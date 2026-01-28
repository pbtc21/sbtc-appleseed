import { Config } from "./config";

interface WalletInfo {
  address: string;
  stxBalance: string;
  sbtcBalance: string;
}

const SBTC_CONTRACT = "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-sbtc";

/**
 * Get wallet address from private key using x402-stacks SDK.
 */
export async function getWalletAddress(config: Config): Promise<string> {
  const { privateKeyToAccount } = await import("x402-stacks");
  const account = privateKeyToAccount(config.privateKey, config.network);
  return account.address;
}

/**
 * Check wallet balances via Hiro API.
 */
export async function getWalletInfo(
  address: string,
  config: Config
): Promise<WalletInfo> {
  const baseUrl =
    config.network === "mainnet"
      ? "https://api.hiro.so"
      : "https://api.testnet.hiro.so";

  const res = await fetch(`${baseUrl}/extended/v1/address/${address}/balances`);
  if (!res.ok) {
    throw new Error(`Failed to fetch wallet balances: ${res.status}`);
  }

  const data = (await res.json()) as {
    stx: { balance: string };
    fungible_tokens: Record<string, { balance: string }>;
  };

  const stxBalance = data.stx?.balance || "0";
  const sbtcKey = Object.keys(data.fungible_tokens || {}).find((k) =>
    k.includes("token-sbtc")
  );
  const sbtcBalance = sbtcKey
    ? data.fungible_tokens[sbtcKey].balance
    : "0";

  return { address, stxBalance, sbtcBalance };
}

/**
 * Format sats to BTC-like display.
 */
export function formatSats(sats: string | number): string {
  const n = typeof sats === "string" ? parseInt(sats, 10) : sats;
  if (n >= 100_000_000) return `${(n / 100_000_000).toFixed(4)} sBTC`;
  return `${n.toLocaleString()} sats`;
}
