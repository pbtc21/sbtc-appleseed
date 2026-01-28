import type {
  ProbeResult,
  PaymentRequiredV1,
  PaymentRequiredV2,
  AcceptOption,
  SbtcPaymentOption,
  ContractCallPayment,
} from "./types";

const STACKS_NETWORK_PREFIXES = ["stacks:1", "stacks:2147483648"];
const SBTC_IDENTIFIERS = [
  "sbtc",
  "token-sbtc",
  "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9",
];

/**
 * Probe an x402 endpoint: call without payment, parse the 402 response,
 * and determine if sBTC is accepted.
 */
export async function probeEndpoint(url: string): Promise<ProbeResult> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    return {
      success: false,
      version: null,
      sbtcOption: null,
      allAccepts: null,
      raw402Body: null,
      httpStatus: 0,
      error: `Failed to reach endpoint: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.status !== 402) {
    return {
      success: false,
      version: null,
      sbtcOption: null,
      allAccepts: null,
      raw402Body: null,
      httpStatus: res.status,
      error: `Expected HTTP 402, got ${res.status}`,
    };
  }

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return {
      success: false,
      version: null,
      sbtcOption: null,
      allAccepts: null,
      raw402Body: null,
      httpStatus: 402,
      error: "402 response body is not valid JSON",
    };
  }

  // Detect v1 vs v2
  if (isV2(body)) {
    return parseV2(body as PaymentRequiredV2);
  }
  return parseV1(body);
}

function isV2(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const obj = body as Record<string, unknown>;
  return obj.x402Version === 2 || Array.isArray(obj.accepts);
}

function parseV2(body: PaymentRequiredV2): ProbeResult {
  const accepts = body.accepts || [];
  const sbtcOption = findSbtcAccept(accepts);

  return {
    success: true,
    version: "v2",
    sbtcOption: sbtcOption
      ? {
          version: "v2",
          amount: sbtcOption.amount,
          payTo: sbtcOption.payTo,
          network: sbtcOption.network,
          facilitatorUrl:
            sbtcOption.extra?.facilitator ||
            "https://facilitator.stacksx402.com",
          tokenType: sbtcOption.extra?.tokenType || "sBTC",
          raw: sbtcOption,
        }
      : null,
    allAccepts: accepts,
    raw402Body: body,
    httpStatus: 402,
    error: sbtcOption ? undefined : "402 returned but sBTC not in accepted payments",
  };
}

function parseV1(body: unknown): ProbeResult {
  if (typeof body !== "object" || body === null) {
    return {
      success: false,
      version: "v1",
      sbtcOption: null,
      allAccepts: null,
      raw402Body: body,
      httpStatus: 402,
      error: "402 body is not a valid v1 payment request",
    };
  }

  const obj = body as Record<string, unknown>;

  // Normalize: handle both standard v1 format and nested payment format
  // Standard: { maxAmountRequired, payTo, tokenType, network, nonce, expiresAt }
  // Nested:   { payment: { price, recipient, token, network }, nonce, expiresAt }
  let amount: string;
  let payTo: string;
  let tokenType: string;
  let network: string;
  let nonce: string;
  let expiresAt: string;
  let contractCall: ContractCallPayment | undefined;

  if (obj.payment && typeof obj.payment === "object") {
    // Nested payment format (e.g. pbtc21 endpoints)
    const p = obj.payment as Record<string, unknown>;
    amount = String(p.price || "0");
    payTo = String(p.recipient || "");
    tokenType = String(p.token || "STX");
    network = String(p.network || "mainnet");
    nonce = String(obj.nonce || "");
    expiresAt = String(obj.expiresAt || "");

    // Detect contract-call payment model
    if (typeof p.contract === "string" && typeof p.function === "string") {
      const parts = p.contract.split(".");
      if (parts.length === 2) {
        contractCall = {
          contractAddress: parts[0],
          contractName: parts[1],
          functionName: String(p.function),
          price: parseInt(amount, 10),
        };
      }
    }
  } else {
    // Standard v1 format
    amount = String(obj.maxAmountRequired || "0");
    payTo = String(obj.payTo || "");
    tokenType = String(obj.tokenType || "STX");
    network = String(obj.network || "mainnet");
    nonce = String(obj.nonce || "");
    expiresAt = String(obj.expiresAt || "");
  }

  const networkId = network === "mainnet" ? "stacks:1" : "stacks:2147483648";

  // Build normalized v1 request for the SDK
  const normalized: PaymentRequiredV1 = {
    maxAmountRequired: amount,
    resource: String(obj.resource || ""),
    payTo,
    network: network as "mainnet" | "testnet",
    nonce,
    expiresAt,
    tokenType: tokenType as "STX" | "sBTC" | "USDCx",
  };

  const accept: AcceptOption = {
    scheme: "exact",
    network: networkId,
    asset: tokenType,
    amount,
    payTo,
    extra: { tokenType },
  };

  return {
    success: true,
    version: "v1",
    sbtcOption: {
      version: "v1",
      amount,
      payTo,
      network: networkId,
      facilitatorUrl: "https://facilitator.stacksx402.com",
      tokenType,
      raw: normalized,
      contractCall,
    },
    allAccepts: [accept],
    raw402Body: body,
    httpStatus: 402,
  };
}

function findSbtcAccept(accepts: AcceptOption[]): AcceptOption | null {
  // First: look for explicit sBTC on Stacks
  for (const opt of accepts) {
    const isStacks = STACKS_NETWORK_PREFIXES.some((p) =>
      opt.network?.startsWith(p.split(":")[0])
    );
    const isSbtc = SBTC_IDENTIFIERS.some(
      (id) =>
        opt.asset?.toLowerCase().includes(id) ||
        opt.extra?.tokenType?.toLowerCase().includes("sbtc")
    );
    if (isStacks && isSbtc) return opt;
  }

  // Second: any Stacks option (STX is fine too — still proves Stacks works)
  for (const opt of accepts) {
    const isStacks = STACKS_NETWORK_PREFIXES.some(
      (p) => opt.network === p || opt.network?.startsWith("stacks:")
    );
    if (isStacks) return opt;
  }

  return null;
}
