/** v1 402 response body */
export interface PaymentRequiredV1 {
  maxAmountRequired: string;
  resource: string;
  payTo: string;
  network: "mainnet" | "testnet";
  nonce: string;
  expiresAt: string;
  memo?: string;
  tokenType?: "STX" | "sBTC" | "USDCx";
}

/** v2 402 response body */
export interface PaymentRequiredV2 {
  x402Version: 2;
  error: string;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepts: AcceptOption[];
}

export interface AcceptOption {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: {
    facilitator?: string;
    tokenType?: string;
    acceptedTokens?: string[];
    [key: string]: unknown;
  };
}

export type ProtocolVersion = "v1" | "v2";

export interface ProbeResult {
  success: boolean;
  version: ProtocolVersion | null;
  sbtcOption: SbtcPaymentOption | null;
  allAccepts: AcceptOption[] | null;
  raw402Body: unknown;
  httpStatus: number;
  error?: string;
}

export interface SbtcPaymentOption {
  version: ProtocolVersion;
  amount: string;
  payTo: string;
  network: string;
  facilitatorUrl: string;
  tokenType: string;
  /** Original parsed object for passing to payment SDK */
  raw: PaymentRequiredV1 | AcceptOption;
}

export interface PayResult {
  success: boolean;
  resourceDelivered: boolean;
  httpStatus: number;
  bodyLength: number;
  bodyPreview: string;
  txId: string | null;
  amount: string;
  recipient: string;
  error?: string;
}

export interface VerifyResult {
  endpoint: string;
  probe: ProbeResult;
  payment: PayResult | null;
  timestamp: string;
}

export interface GithubIssueRef {
  owner: string;
  repo: string;
  number: number;
}
