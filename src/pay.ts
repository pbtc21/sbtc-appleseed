import type {
  SbtcPaymentOption,
  PayResult,
  PaymentRequiredV1,
  AcceptOption,
} from "./types";
import type { Config } from "./config";

/**
 * Pay an x402 endpoint with sBTC and check if the resource is delivered.
 *
 * Handles both v1 (X-PAYMENT header) and v2 (Payment-Signature header) flows.
 */
export async function payEndpoint(
  url: string,
  option: SbtcPaymentOption,
  config: Config
): Promise<PayResult> {
  const amountNum = parseInt(option.amount, 10);

  // Safety: check amount against max
  if (amountNum > config.maxSbtcPerVerify) {
    return {
      success: false,
      resourceDelivered: false,
      httpStatus: 0,
      bodyLength: 0,
      bodyPreview: "",
      txId: null,
      amount: option.amount,
      recipient: option.payTo,
      error: `Payment amount ${amountNum} sats exceeds max ${config.maxSbtcPerVerify} sats`,
    };
  }

  try {
    if (option.version === "v1") {
      return await payV1(url, option, config);
    }
    return await payV2(url, option, config);
  } catch (err) {
    return {
      success: false,
      resourceDelivered: false,
      httpStatus: 0,
      bodyLength: 0,
      bodyPreview: "",
      txId: null,
      amount: option.amount,
      recipient: option.payTo,
      error: `Payment failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * v1 flow: Sign + broadcast tx → wait → X-PAYMENT: txid header → GET endpoint
 *
 * v1 endpoints expect the transaction to be already broadcast on-chain.
 * The X-PAYMENT header carries the txid, not a signed tx hex.
 */
async function payV1(
  url: string,
  option: SbtcPaymentOption,
  config: Config
): Promise<PayResult> {
  // Route to contract-call flow if detected
  if (option.contractCall) {
    return payV1ContractCall(url, option, config);
  }

  // Route to sBTC SIP-010 transfer if token type is sBTC
  if (isSbtcToken(option.tokenType)) {
    return payV1Sbtc(url, option, config);
  }

  const { X402PaymentClient } = await import("x402-stacks");

  const client = new X402PaymentClient({
    network: config.network,
    privateKey: config.privateKey,
    facilitatorUrl: config.facilitatorUrl,
  });

  // Sign the transaction
  const v1Req = option.raw as PaymentRequiredV1;
  const signed = await client.signPayment(v1Req);

  if (!signed.success || !signed.signedTransaction) {
    return {
      success: false,
      resourceDelivered: false,
      httpStatus: 0,
      bodyLength: 0,
      bodyPreview: "",
      txId: null,
      amount: option.amount,
      recipient: option.payTo,
      error: `Signing failed: ${signed.error || "unknown error"}`,
    };
  }

  // Broadcast via Hiro API
  const hiroBase =
    config.network === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";

  const broadcastRes = await fetch(`${hiroBase}/v2/transactions`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream" },
    body: hexToBytes(signed.signedTransaction),
    signal: AbortSignal.timeout(30000),
  });

  const broadcastBody = await broadcastRes.text();
  let txId: string | null = null;

  if (broadcastRes.ok) {
    // Hiro returns the txid as a JSON string
    txId = broadcastBody.replace(/"/g, "").trim();
  } else {
    // Check if the error indicates the tx was already broadcast
    try {
      const errJson = JSON.parse(broadcastBody);
      if (errJson.txid) {
        txId = errJson.txid;
      } else {
        return {
          success: false,
          resourceDelivered: false,
          httpStatus: 0,
          bodyLength: 0,
          bodyPreview: "",
          txId: null,
          amount: option.amount,
          recipient: option.payTo,
          error: `Broadcast failed: ${broadcastBody.slice(0, 200)}`,
        };
      }
    } catch {
      return {
        success: false,
        resourceDelivered: false,
        httpStatus: 0,
        bodyLength: 0,
        bodyPreview: "",
        txId: null,
        amount: option.amount,
        recipient: option.payTo,
        error: `Broadcast failed (${broadcastRes.status}): ${broadcastBody.slice(0, 200)}`,
      };
    }
  }

  // Ensure 0x prefix
  if (txId && !txId.startsWith("0x")) {
    txId = `0x${txId}`;
  }

  console.log(`  [pay] Broadcast TX: ${txId}`);
  console.log(`  [pay] Waiting for confirmation...`);

  // Poll for transaction confirmation (up to 60s)
  const hiroBase2 =
    config.network === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";

  let confirmed = false;
  for (let attempt = 0; attempt < 12; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));
    try {
      const checkRes = await fetch(
        `${hiroBase2}/extended/v1/tx/${txId}`,
        { signal: AbortSignal.timeout(5000) }
      );
      if (checkRes.ok) {
        const txData = (await checkRes.json()) as { tx_status?: string };
        if (txData.tx_status === "success") {
          confirmed = true;
          console.log(`  [pay] TX confirmed (attempt ${attempt + 1})`);
          break;
        }
        if (txData.tx_status === "pending") {
          console.log(`  [pay] TX pending (attempt ${attempt + 1}/12)...`);
        }
      }
    } catch {
      // Ignore polling errors
    }
  }

  if (!confirmed) {
    console.log(`  [pay] TX not confirmed after 60s, trying anyway...`);
  }

  // Retry endpoint with txid in header
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "X-Payment": txId!,
    },
    signal: AbortSignal.timeout(60000),
  });

  const result = await buildPayResult(res, option);
  result.txId = txId;
  return result;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    bytes[i / 2] = parseInt(clean.substring(i, i + 2), 16);
  }
  return bytes;
}

/**
 * v1 contract-call flow: Build contract call tx → broadcast → poll → X-PAYMENT header
 *
 * Used when the 402 body specifies payment.contract + payment.function,
 * meaning the endpoint expects a contract call rather than a simple STX transfer.
 */
async function payV1ContractCall(
  url: string,
  option: SbtcPaymentOption,
  config: Config
): Promise<PayResult> {
  const {
    makeContractCall,
    broadcastTransaction,
    AnchorMode,
    PostConditionMode,
    FungibleConditionCode,
    makeStandardSTXPostCondition,
    getAddressFromPrivateKey,
    TransactionVersion,
  } = await import("@stacks/transactions");

  const cc = option.contractCall!;

  // Derive sender address for post-condition
  const txVersion =
    config.network === "mainnet"
      ? TransactionVersion.Mainnet
      : TransactionVersion.Testnet;
  const senderAddress = getAddressFromPrivateKey(config.privateKey, txVersion);

  // Post-condition: sender sends at most `price` uSTX
  const postCondition = makeStandardSTXPostCondition(
    senderAddress,
    FungibleConditionCode.LessEqual,
    cc.price
  );

  console.log(
    `  [pay] Building contract-call: ${cc.contractAddress}.${cc.contractName}::${cc.functionName} (${cc.price} uSTX)`
  );

  const fee = await estimateFee(config);

  const tx = await makeContractCall({
    contractAddress: cc.contractAddress,
    contractName: cc.contractName,
    functionName: cc.functionName,
    functionArgs: [],
    senderKey: config.privateKey,
    network: config.network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
    postConditions: [postCondition],
    fee,
    validateWithAbi: false,
  });

  // Broadcast with retry
  const broadcastResult = await broadcastWithRetry(
    () => broadcastTransaction(tx, config.network)
  );

  if (broadcastResult.error) {
    return {
      success: false,
      resourceDelivered: false,
      httpStatus: 0,
      bodyLength: 0,
      bodyPreview: "",
      txId: null,
      amount: option.amount,
      recipient: `${cc.contractAddress}.${cc.contractName}`,
      error: `Broadcast failed: ${broadcastResult.error} - ${broadcastResult.reason || ""}`,
    };
  }

  let txId = broadcastResult.txid;
  if (txId && !txId.startsWith("0x")) {
    txId = `0x${txId}`;
  }

  console.log(`  [pay] Broadcast contract-call TX: ${txId}`);

  return awaitConfirmationAndRetry(url, txId, option, config);
}

/**
 * v2 flow: Sign tx → Payment-Signature header (base64 JSON) → GET endpoint
 */
async function payV2(
  url: string,
  option: SbtcPaymentOption,
  config: Config
): Promise<PayResult> {
  const { X402PaymentClient } = await import("x402-stacks");
  const acceptOpt = option.raw as AcceptOption;

  const client = new X402PaymentClient({
    network: config.network,
    privateKey: config.privateKey,
    facilitatorUrl: config.facilitatorUrl,
  });

  // Build v1-compatible request for signPayment()
  const v1Compat = {
    maxAmountRequired: option.amount,
    resource: new URL(url).pathname,
    payTo: option.payTo,
    network: config.network,
    nonce: Date.now().toString(),
    expiresAt: new Date(Date.now() + 300000).toISOString(),
    tokenType: option.tokenType as "STX" | "sBTC" | "USDCx",
  };

  const signed = await client.signPayment(v1Compat);

  if (!signed.success || !signed.signedTransaction) {
    return {
      success: false,
      resourceDelivered: false,
      httpStatus: 0,
      bodyLength: 0,
      bodyPreview: "",
      txId: null,
      amount: option.amount,
      recipient: option.payTo,
      error: `Signing failed: ${signed.error || "unknown error"}`,
    };
  }

  // Build v2 Payment-Signature payload
  const payloadObj = {
    x402Version: 2,
    resource: {
      url: new URL(url).pathname,
      description: "",
      mimeType: "application/json",
    },
    accepted: {
      scheme: acceptOpt.scheme || "exact",
      network: option.network,
      asset: acceptOpt.asset,
      amount: option.amount,
      payTo: option.payTo,
      maxTimeoutSeconds: acceptOpt.maxTimeoutSeconds || 300,
      extra: acceptOpt.extra || {},
    },
    payload: {
      transaction: signed.signedTransaction,
    },
  };

  const encoded = btoa(JSON.stringify(payloadObj));

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Payment-Signature": encoded,
    },
    signal: AbortSignal.timeout(60000),
  });

  return await buildPayResult(res, option);
}

const SBTC_CONTRACT_ADDRESS = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4";
const SBTC_CONTRACT_NAME = "sbtc-token";
const SBTC_TOKEN_NAME = "sbtc-token";

function isSbtcToken(tokenType: string): boolean {
  const t = tokenType.toLowerCase();
  return t === "sbtc" || t.includes("sbtc") || t.includes("token-sbtc");
}

/**
 * v1 sBTC flow: SIP-010 transfer → broadcast → poll → X-Payment header
 */
async function payV1Sbtc(
  url: string,
  option: SbtcPaymentOption,
  config: Config
): Promise<PayResult> {
  const {
    makeContractCall,
    broadcastTransaction,
    AnchorMode,
    PostConditionMode,
    FungibleConditionCode,
    makeStandardFungiblePostCondition,
    getAddressFromPrivateKey,
    TransactionVersion,
    Cl,
  } = await import("@stacks/transactions");

  const amount = parseInt(option.amount, 10);
  const txVersion =
    config.network === "mainnet"
      ? TransactionVersion.Mainnet
      : TransactionVersion.Testnet;
  const senderAddress = getAddressFromPrivateKey(config.privateKey, txVersion);

  // Post-condition: sender sends exactly `amount` of sbtc-token
  const postCondition = makeStandardFungiblePostCondition(
    senderAddress,
    FungibleConditionCode.Equal,
    amount,
    `${SBTC_CONTRACT_ADDRESS}.${SBTC_CONTRACT_NAME}::${SBTC_TOKEN_NAME}`
  );

  console.log(
    `  [pay] Building sBTC SIP-010 transfer: ${amount} sats → ${option.payTo}`
  );

  const fee = await estimateFee(config);

  const tx = await makeContractCall({
    contractAddress: SBTC_CONTRACT_ADDRESS,
    contractName: SBTC_CONTRACT_NAME,
    functionName: "transfer",
    functionArgs: [
      Cl.uint(amount),
      Cl.principal(senderAddress),
      Cl.principal(option.payTo),
      Cl.none(), // memo
    ],
    senderKey: config.privateKey,
    network: config.network,
    anchorMode: AnchorMode.Any,
    postConditionMode: PostConditionMode.Deny,
    postConditions: [postCondition],
    fee,
    validateWithAbi: false,
  });

  // Broadcast with retry
  const broadcastResult = await broadcastWithRetry(
    () => broadcastTransaction(tx, config.network)
  );

  if (broadcastResult.error) {
    return {
      success: false,
      resourceDelivered: false,
      httpStatus: 0,
      bodyLength: 0,
      bodyPreview: "",
      txId: null,
      amount: option.amount,
      recipient: option.payTo,
      error: `Broadcast failed: ${broadcastResult.error} - ${broadcastResult.reason || ""}`,
    };
  }

  let txId = broadcastResult.txid;
  if (txId && !txId.startsWith("0x")) {
    txId = `0x${txId}`;
  }

  console.log(`  [pay] Broadcast sBTC transfer TX: ${txId}`);

  return awaitConfirmationAndRetry(url, txId, option, config);
}

/**
 * Estimate fee with multiplier from config.
 * Queries Hiro for current fee estimate, applies multiplier.
 */
async function estimateFee(config: Config): Promise<number> {
  const hiroBase =
    config.network === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";

  try {
    const res = await fetch(`${hiroBase}/v2/fees/transfer`, {
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = (await res.json()) as { fee_rate: number };
      // fee_rate is in microSTX per byte, contract calls ~250 bytes
      const baseFee = Math.max(data.fee_rate * 250, 2000);
      return Math.ceil(baseFee * config.feeMultiplier);
    }
  } catch {
    // Fall through to default
  }
  // Default: 3000 uSTX * multiplier
  return Math.ceil(3000 * config.feeMultiplier);
}

/**
 * Broadcast with exponential backoff retry.
 * 3 attempts: immediate, 5s, 15s
 */
async function broadcastWithRetry(
  broadcastFn: () => Promise<{ txid: string; error?: string; reason?: string }>
): Promise<{ txid: string; error?: string; reason?: string }> {
  const delays = [0, 5000, 15000];
  let lastResult: { txid: string; error?: string; reason?: string } = {
    txid: "",
    error: "No broadcast attempted",
  };

  for (let i = 0; i < delays.length; i++) {
    if (delays[i] > 0) {
      console.log(`  [pay] Broadcast retry ${i}/2 (waiting ${delays[i] / 1000}s)...`);
      await new Promise((r) => setTimeout(r, delays[i]));
    }

    try {
      lastResult = await broadcastFn();
      // Success - no error field
      if (!lastResult.error) return lastResult;

      // Permanent errors - don't retry
      const reason = String(lastResult.reason || "");
      if (
        reason.includes("NotEnoughFunds") ||
        reason.includes("NoSuchContract") ||
        reason.includes("BadFunctionArgument")
      ) {
        return lastResult;
      }

      // Transient - retry
      console.log(`  [pay] Broadcast error (attempt ${i + 1}): ${lastResult.reason || lastResult.error}`);
    } catch (err) {
      console.log(
        `  [pay] Broadcast exception (attempt ${i + 1}): ${err instanceof Error ? err.message : String(err)}`
      );
      lastResult = {
        txid: "",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return lastResult;
}

/**
 * Shared confirmation polling + endpoint retry loop.
 * Used by contract-call and sBTC transfer flows.
 */
async function awaitConfirmationAndRetry(
  url: string,
  txId: string,
  option: SbtcPaymentOption,
  config: Config
): Promise<PayResult> {
  console.log(`  [pay] Waiting for confirmation + endpoint verification...`);

  const hiroBase =
    config.network === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";

  let confirmed = false;
  let res: Response | null = null;

  for (let attempt = 0; attempt < 36; attempt++) {
    await new Promise((r) => setTimeout(r, 5000));

    if (!confirmed) {
      try {
        const checkRes = await fetch(
          `${hiroBase}/extended/v1/tx/${txId}`,
          { signal: AbortSignal.timeout(5000) }
        );
        if (checkRes.ok) {
          const txData = (await checkRes.json()) as { tx_status?: string };
          if (txData.tx_status === "success") {
            confirmed = true;
            console.log(`  [pay] TX confirmed (attempt ${attempt + 1})`);
          } else if (txData.tx_status === "pending") {
            console.log(`  [pay] TX pending (attempt ${attempt + 1}/36)...`);
            continue;
          }
        }
      } catch {
        // Ignore polling errors
      }
      if (!confirmed) continue;
    }

    res = await fetch(url, {
      method: "GET",
      headers: { "X-Payment": txId },
      signal: AbortSignal.timeout(60000),
    });

    if (res.status >= 200 && res.status < 300) {
      console.log(`  [pay] Endpoint accepted payment`);
      break;
    }

    if (res.status === 403 || res.status === 402) {
      console.log(`  [pay] Endpoint not ready (${res.status}), retrying...`);
      continue;
    }

    break;
  }

  if (!confirmed) {
    console.log(`  [pay] TX not confirmed after 3 min`);
  }

  if (!res) {
    return {
      success: false,
      resourceDelivered: false,
      httpStatus: 0,
      bodyLength: 0,
      bodyPreview: "",
      txId,
      amount: option.amount,
      recipient: option.payTo,
      error: "TX never confirmed within timeout",
    };
  }

  const result = await buildPayResult(res, option);
  result.txId = txId;
  return result;
}

async function buildPayResult(
  res: Response,
  option: SbtcPaymentOption
): Promise<PayResult> {
  const body = await res.text();
  const delivered = res.status >= 200 && res.status < 300 && body.length > 0;

  // Try to extract txId from response headers or body
  let txId: string | null = null;
  const txHeader =
    res.headers.get("x-payment-txid") ||
    res.headers.get("x-transaction-id");
  if (txHeader) {
    txId = txHeader;
  } else {
    try {
      const parsed = JSON.parse(body);
      txId = parsed.txId || parsed.tx_id || parsed.transactionId || null;
    } catch {
      // Body isn't JSON, that's fine
    }
  }

  return {
    success: delivered,
    resourceDelivered: delivered,
    httpStatus: res.status,
    bodyLength: body.length,
    bodyPreview: body.slice(0, 200),
    txId,
    amount: option.amount,
    recipient: option.payTo,
    error: delivered
      ? undefined
      : `HTTP ${res.status}: ${body.slice(0, 200)}`,
  };
}
