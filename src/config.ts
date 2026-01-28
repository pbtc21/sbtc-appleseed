export interface Config {
  privateKey: string;
  network: "mainnet" | "testnet";
  facilitatorUrl: string;
  maxSbtcPerVerify: number;
  feeMultiplier: number;
  dbPath: string;
  telegramBotToken: string;
  telegramChatId: string;

  walletAddress: string;
}

export function loadConfig(): Config {
  const privateKey = process.env.APPLESEED_PRIVATE_KEY || "";
  const home = process.env.HOME || "/tmp";

  return {
    privateKey,
    network: (process.env.STACKS_NETWORK as "mainnet" | "testnet") || "mainnet",
    facilitatorUrl:
      process.env.FACILITATOR_URL || "https://facilitator.stacksx402.com",
    maxSbtcPerVerify: parseInt(process.env.MAX_SBTC_PER_VERIFY || "50000", 10),
    feeMultiplier: parseFloat(process.env.FEE_MULTIPLIER || "1.5"),
    dbPath: process.env.DB_PATH || `${home}/.appleseed/endpoints.db`,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "",
    walletAddress: process.env.PAYMENT_ADDRESS || "",
  };
}
