import type { Config } from "./config";
import type { VerifyResult } from "./types";
import type { Endpoint } from "./db";
import { formatSats } from "./wallet";

const API = "https://api.telegram.org/bot";

async function send(
  config: Config,
  text: string,
  parseMode: "HTML" | "Markdown" = "HTML"
): Promise<boolean> {
  if (!config.telegramBotToken || !config.telegramChatId) return false;

  try {
    const res = await fetch(`${API}${config.telegramBotToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: config.telegramChatId,
        text,
        parse_mode: parseMode,
        disable_web_page_preview: true,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Alert types ──────────────────────────────────────────

export async function alertEndpointDown(
  endpoint: Endpoint,
  error: string,
  config: Config
): Promise<void> {
  const text = [
    `🔴 <b>Endpoint DOWN</b>`,
    ``,
    `<b>URL:</b> <code>${endpoint.url}</code>`,
    `<b>Status:</b> ${endpoint.status} → broken`,
    `<b>Error:</b> ${error}`,
    endpoint.repo_url ? `<b>Repo:</b> ${endpoint.repo_url}` : "",
    ``,
    `Last check: ${endpoint.last_check || "never"}`,
  ]
    .filter(Boolean)
    .join("\n");

  await send(config, text);
}

export async function alertEndpointRecovered(
  endpoint: Endpoint,
  config: Config
): Promise<void> {
  const text = [
    `🟢 <b>Endpoint RECOVERED</b>`,
    ``,
    `<b>URL:</b> <code>${endpoint.url}</code>`,
    `<b>Status:</b> broken → verified`,
    endpoint.repo_url ? `<b>Repo:</b> ${endpoint.repo_url}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await send(config, text);
}

export async function alertVerifyResult(
  result: VerifyResult,
  config: Config
): Promise<void> {
  const passed = result.payment?.success ?? result.probe.success;
  const icon = passed ? "✅" : "❌";
  const status = passed ? "PASSED" : "FAILED";

  const lines = [
    `${icon} <b>Verify: ${status}</b>`,
    ``,
    `<b>URL:</b> <code>${result.endpoint}</code>`,
    `<b>Protocol:</b> x402 ${result.probe.version || "unknown"}`,
  ];

  if (result.probe.sbtcOption) {
    lines.push(
      `<b>sBTC:</b> ${formatSats(result.probe.sbtcOption.amount)} → ${result.probe.sbtcOption.payTo}`
    );
  }

  if (result.payment) {
    if (result.payment.success) {
      lines.push(`<b>Payment:</b> ${result.payment.amount} sats`);
      if (result.payment.txId) {
        lines.push(
          `<b>TX:</b> <a href="https://explorer.hiro.so/txid/${result.payment.txId}">view</a>`
        );
      }
    } else {
      lines.push(`<b>Payment error:</b> ${result.payment.error}`);
    }
  }

  await send(config, lines.join("\n"));
}

export async function alertBatchSummary(
  passed: number,
  failed: number,
  total: number,
  config: Config
): Promise<void> {
  const icon = failed === 0 ? "✅" : "⚠️";
  const text = [
    `${icon} <b>Batch Verify Complete</b>`,
    ``,
    `Passed: ${passed}`,
    `Failed: ${failed}`,
    `Total: ${total}`,
  ].join("\n");

  await send(config, text);
}

export async function alertMonitorDigest(
  healthy: number,
  broken: number,
  recovered: number,
  newlyBroken: number,
  config: Config
): Promise<void> {
  const icon = newlyBroken === 0 ? "📊" : "⚠️";
  const text = [
    `${icon} <b>Daily Monitor Digest</b>`,
    ``,
    `Healthy: ${healthy}`,
    `Broken: ${broken}`,
    recovered > 0 ? `Recovered: ${recovered}` : "",
    newlyBroken > 0 ? `Newly broken: ${newlyBroken}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  await send(config, text);
}

export async function alertDiscovery(
  found: number,
  added: number,
  highScore: number,
  config: Config
): Promise<void> {
  const text = [
    `🔍 <b>Discovery Run</b>`,
    ``,
    `Found: ${found} repos`,
    `New: ${added}`,
    `High-score: ${highScore}`,
  ].join("\n");

  await send(config, text);
}

export async function sendMessage(
  text: string,
  config: Config
): Promise<boolean> {
  return send(config, text);
}
