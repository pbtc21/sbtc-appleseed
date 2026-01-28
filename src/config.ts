export interface Config {
  privateKey: string;
  network: "mainnet" | "testnet";
  facilitatorUrl: string;
  maxSbtcPerVerify: number;

  walletAddress: string;
}

export function loadConfig(): Config {
  const privateKey = process.env.APPLESEED_PRIVATE_KEY || "";

  return {
    privateKey,
    network: (process.env.STACKS_NETWORK as "mainnet" | "testnet") || "mainnet",
    facilitatorUrl:
      process.env.FACILITATOR_URL || "https://facilitator.stacksx402.com",
    maxSbtcPerVerify: parseInt(process.env.MAX_SBTC_PER_VERIFY || "50000", 10),
    walletAddress: process.env.PAYMENT_ADDRESS || "",
  };
}
