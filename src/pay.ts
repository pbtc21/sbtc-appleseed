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
      "X-PAYMENT": txId!,
      "x-payment": txId!,
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
