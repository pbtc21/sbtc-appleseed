import { loadConfig, type Config } from "./config";
import { listEndpoints, getEndpoint, type Endpoint, type EndpointStatus } from "./db";
import { getWalletAddress, getWalletInfo, formatSats } from "./wallet";
import { probeEndpoint } from "./probe";

const API = "https://api.telegram.org/bot";

interface Update {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string; title?: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    date: number;
  };
}

interface GetUpdatesResponse {
  ok: boolean;
  result: Update[];
}

let lastUpdateId = 0;

async function getUpdates(token: string, timeout = 30): Promise<Update[]> {
  const url = `${API}${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=${timeout}`;
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = (await res.json()) as GetUpdatesResponse;
    if (!data.ok || !data.result.length) return [];
    lastUpdateId = data.result[data.result.length - 1].update_id;
    return data.result;
  } catch {
    return [];
  }
}

async function sendMessage(
  token: string,
  chatId: number,
  text: string
): Promise<void> {
  await fetch(`${API}${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
}

// ── Command handlers ──────────────────────────────────────

async function handleStart(
  chatId: number,
  token: string,
  username?: string
): Promise<void> {
  const text = [
    `👋 <b>Welcome to Appleseed Bot</b>`,
    ``,
    `Your chat ID: <code>${chatId}</code>`,
    ``,
    `Add this to your .env:`,
    `<code>TELEGRAM_CHAT_ID=${chatId}</code>`,
    ``,
    `<b>Commands:</b>`,
    `/status — Wallet + endpoint overview`,
    `/list — All tracked endpoints`,
    `/check &lt;url&gt; — Probe an endpoint`,
  ].join("\n");

  await sendMessage(token, chatId, text);
}

async function handleStatus(
  chatId: number,
  token: string,
  config: Config
): Promise<void> {
  const endpoints = listEndpoints(config.dbPath);

  const counts: Record<string, number> = {};
  for (const ep of endpoints) {
    counts[ep.status] = (counts[ep.status] || 0) + 1;
  }

  const lines = [`📊 <b>Appleseed Status</b>`, ``];

  // Wallet info
  try {
    const address = await getWalletAddress(config);
    const wallet = await getWalletInfo(address, config);
    lines.push(`<b>Wallet:</b> <code>${address.slice(0, 12)}...</code>`);
    lines.push(`<b>STX:</b> ${formatSats(wallet.stxBalance)}`);
    lines.push(`<b>sBTC:</b> ${formatSats(wallet.sbtcBalance)}`);
    lines.push(``);
  } catch {
    lines.push(`<b>Wallet:</b> Not configured`);
    lines.push(``);
  }

  // Endpoint counts
  lines.push(`<b>Endpoints:</b> ${endpoints.length} total`);
  if (counts.verified) lines.push(`  ✅ Verified: ${counts.verified}`);
  if (counts.monitoring) lines.push(`  👁 Monitoring: ${counts.monitoring}`);
  if (counts.broken) lines.push(`  🔴 Broken: ${counts.broken}`);
  if (counts.discovered) lines.push(`  🔍 Discovered: ${counts.discovered}`);
  if (counts.contacted) lines.push(`  📧 Contacted: ${counts.contacted}`);
  if (counts.pr_opened) lines.push(`  🔀 PR Opened: ${counts.pr_opened}`);
  if (counts.awaiting_verification) lines.push(`  ⏳ Awaiting: ${counts.awaiting_verification}`);

  await sendMessage(token, chatId, lines.join("\n"));
}

async function handleList(
  chatId: number,
  token: string,
  config: Config,
  statusFilter?: string
): Promise<void> {
  const endpoints = statusFilter
    ? listEndpoints(config.dbPath, statusFilter as EndpointStatus)
    : listEndpoints(config.dbPath);

  if (endpoints.length === 0) {
    await sendMessage(token, chatId, "No endpoints tracked.");
    return;
  }

  const statusEmoji: Record<string, string> = {
    verified: "✅",
    monitoring: "👁",
    broken: "🔴",
    discovered: "🔍",
    contacted: "📧",
    pr_opened: "🔀",
    awaiting_verification: "⏳",
    evaluating: "🔬",
  };

  const lines = [`📋 <b>Endpoints</b> (${endpoints.length})`, ``];

  for (const ep of endpoints.slice(0, 20)) {
    const emoji = statusEmoji[ep.status] || "•";
    const shortUrl = ep.url.replace(/^https?:\/\//, "").slice(0, 35);
    lines.push(`${emoji} <code>${shortUrl}</code>`);
  }

  if (endpoints.length > 20) {
    lines.push(``, `... and ${endpoints.length - 20} more`);
  }

  await sendMessage(token, chatId, lines.join("\n"));
}

async function handleCheck(
  chatId: number,
  token: string,
  url: string
): Promise<void> {
  if (!url || !url.startsWith("http")) {
    await sendMessage(token, chatId, "Usage: /check <url>");
    return;
  }

  // SSRF protection: block internal/private URLs
  if (!isUrlSafe(url)) {
    await sendMessage(token, chatId, "⛔ URL blocked: cannot probe internal/private addresses");
    return;
  }

  await sendMessage(token, chatId, `🔍 Probing ${escapeHtml(url)}...`);

  try {
    const probe = await probeEndpoint(url);

    if (!probe.success) {
      await sendMessage(
        token,
        chatId,
        `❌ <b>Probe Failed</b>\n\n${probe.error || "Unknown error"}`
      );
      return;
    }

    const lines = [
      `✅ <b>Probe Success</b>`,
      ``,
      `<b>URL:</b> <code>${escapeHtml(url)}</code>`,
      `<b>Protocol:</b> x402 ${escapeHtml(probe.version || "unknown")}`,
    ];

    if (probe.sbtcOption) {
      lines.push(`<b>sBTC:</b> ${formatSats(probe.sbtcOption.amount)} sats`);
      lines.push(`<b>Pay to:</b> <code>${escapeHtml(probe.sbtcOption.payTo)}</code>`);
    } else {
      lines.push(`<b>sBTC:</b> Not accepted`);
    }

    await sendMessage(token, chatId, lines.join("\n"));
  } catch (err) {
    await sendMessage(
      token,
      chatId,
      `❌ Error: ${err instanceof Error ? err.message : "Unknown"}`
    );
  }
}

async function handleHelp(chatId: number, token: string): Promise<void> {
  const text = [
    `🌱 <b>Appleseed Bot</b>`,
    ``,
    `<b>Commands:</b>`,
    `/status — Wallet + endpoint overview`,
    `/list — All tracked endpoints`,
    `/list verified — Filter by status`,
    `/check &lt;url&gt; — Probe an endpoint`,
    `/help — Show this message`,
  ].join("\n");

  await sendMessage(token, chatId, text);
}

// ── Security helpers ──────────────────────────────────────

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function isUrlSafe(url: string): boolean {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();

    // Block private/internal IPs
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host.startsWith("192.168.") ||
      host.startsWith("10.") ||
      host.startsWith("172.16.") ||
      host.startsWith("172.17.") ||
      host.startsWith("172.18.") ||
      host.startsWith("172.19.") ||
      host.startsWith("172.2") ||
      host.startsWith("172.30.") ||
      host.startsWith("172.31.") ||
      host === "169.254.169.254" ||  // AWS metadata
      host.endsWith(".internal") ||
      host.endsWith(".local")
    ) {
      return false;
    }

    // Only allow http/https
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

// ── Main loop ──────────────────────────────────────────────

async function processUpdate(update: Update, config: Config): Promise<void> {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const token = config.telegramBotToken;

  // Authorization: only respond to configured chat ID
  const authorizedChatId = config.telegramChatId ? parseInt(config.telegramChatId, 10) : null;
  if (authorizedChatId && chatId !== authorizedChatId) {
    // Allow /start for anyone (so they can get their chat ID)
    if (!text.toLowerCase().startsWith("/start")) {
      console.log(`[bot] Unauthorized: ${chatId} (expected ${authorizedChatId})`);
      await sendMessage(token, chatId, "⛔ Unauthorized. This bot is private.");
      return;
    }
  }

  // Parse command
  const parts = text.split(/\s+/);
  const cmd = parts[0].toLowerCase().replace("@aibtc_appleseed_bot", "");
  const arg = parts.slice(1).join(" ");

  console.log(`[bot] ${msg.from?.username || chatId}: ${cmd}`);

  switch (cmd) {
    case "/start":
      return handleStart(chatId, token, msg.from?.username);
    case "/status":
      return handleStatus(chatId, token, config);
    case "/list":
      return handleList(chatId, token, config, arg || undefined);
    case "/check":
      return handleCheck(chatId, token, arg);
    case "/help":
      return handleHelp(chatId, token);
    default:
      if (text.startsWith("/")) {
        await sendMessage(token, chatId, "Unknown command. Try /help");
      }
  }
}

async function runBot(): Promise<void> {
  const config = loadConfig();

  if (!config.telegramBotToken) {
    console.error("Error: TELEGRAM_BOT_TOKEN not set");
    process.exit(1);
  }

  console.log("🤖 Appleseed Bot starting...");
  console.log(`   Token: ${config.telegramBotToken.slice(0, 10)}...`);
  console.log(`   Polling for updates...\n`);

  while (true) {
    try {
      const updates = await getUpdates(config.telegramBotToken);
      for (const update of updates) {
        await processUpdate(update, config);
      }
    } catch (err) {
      console.error("[bot] Poll error:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

runBot();
