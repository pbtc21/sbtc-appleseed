import type { Config } from "./config";
import { addEndpoint, getEndpoint } from "./db";
import { probeEndpoint } from "./probe";

/**
 * SSRF protection: validate URL before probing.
 */
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
      host === "169.254.169.254" ||
      host.endsWith(".internal") ||
      host.endsWith(".local")
    ) {
      return false;
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}

interface DiscoverResult {
  repo: string;
  url: string;
  description: string;
  language: string;
  score: "high" | "medium" | "low";
  probeSuccess: boolean;
  alreadyTracked: boolean;
}

const X402_CODE_PATTERNS = [
  "x402Version",
  "PaymentRequired",
  "Payment-Signature",
  "X-PAYMENT",
  "facilitator",
  "402 payment",
];

const X402_TOPICS = ["x402", "http-402", "pay-per-call", "micropayments"];

/**
 * Discover x402 endpoints by searching GitHub for repos using x402 patterns.
 */
export async function discoverEndpoints(
  config: Config,
  opts: { language?: string; limit?: number; dryRun?: boolean }
): Promise<DiscoverResult[]> {
  const limit = opts.limit || 50;
  const results: DiscoverResult[] = [];
  const seenRepos = new Set<string>();

  console.log("  [discover] Searching GitHub for x402 endpoints...\n");

  // Search by code patterns
  for (const pattern of X402_CODE_PATTERNS) {
    if (results.length >= limit) break;

    const repos = await searchCode(pattern, opts.language);
    for (const repo of repos) {
      if (seenRepos.has(repo.full_name) || results.length >= limit) continue;
      seenRepos.add(repo.full_name);

      const result = await evaluateRepo(repo, config, opts.dryRun ?? false);
      if (result) results.push(result);
    }

    // GitHub code search: 10 req/min, be cautious
    await new Promise((r) => setTimeout(r, 6000));
  }

  // Search by topics
  for (const topic of X402_TOPICS) {
    if (results.length >= limit) break;

    const repos = await searchTopics(topic, opts.language);
    for (const repo of repos) {
      if (seenRepos.has(repo.full_name) || results.length >= limit) continue;
      seenRepos.add(repo.full_name);

      const result = await evaluateRepo(repo, config, opts.dryRun ?? false);
      if (result) results.push(result);
    }

    await new Promise((r) => setTimeout(r, 2000));
  }

  // Insert non-dry-run results into DB
  if (!opts.dryRun) {
    let added = 0;
    for (const r of results) {
      if (!r.alreadyTracked && r.url) {
        addEndpoint(config.dbPath, r.url, {
          repo_url: `https://github.com/${r.repo}`,
          status: "discovered",
        });
        added++;
      }
    }
    console.log(`\n  [discover] Added ${added} new endpoints to registry`);
  }

  return results;
}

interface GhRepo {
  full_name: string;
  html_url: string;
  description: string | null;
  language: string | null;
  topics?: string[];
}

async function searchCode(
  query: string,
  language?: string
): Promise<GhRepo[]> {
  const q = language
    ? `${query} language:${language}`
    : query;

  try {
    const proc = Bun.spawn(
      ["gh", "api", "search/code", "-q", ".items[].repository | {full_name, html_url, description, language}", "--paginate", "-X", "GET",
       "-f", `q=${q}`, "-f", "per_page=10"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    return parseGhOutput(stdout);
  } catch {
    return [];
  }
}

async function searchTopics(
  topic: string,
  language?: string
): Promise<GhRepo[]> {
  const q = language
    ? `topic:${topic} language:${language}`
    : `topic:${topic}`;

  try {
    const proc = Bun.spawn(
      ["gh", "api", "search/repositories", "-q", ".items[] | {full_name, html_url, description, language}", "-X", "GET",
       "-f", `q=${q}`, "-f", "per_page=10"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    await proc.exited;

    return parseGhOutput(stdout);
  } catch {
    return [];
  }
}

function parseGhOutput(stdout: string): GhRepo[] {
  const repos: GhRepo[] = [];
  for (const line of stdout.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      repos.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }
  return repos;
}

async function evaluateRepo(
  repo: GhRepo,
  config: Config,
  dryRun: boolean
): Promise<DiscoverResult | null> {
  // Check if already tracked
  const existing = getEndpoint(config.dbPath, `https://github.com/${repo.full_name}`);
  const alreadyTracked = !!existing;

  // Try to find endpoint URL from repo README
  const endpointUrl = await extractEndpointUrl(repo.full_name);

  // Score the target
  let score: "high" | "medium" | "low" = "low";
  const desc = (repo.description || "").toLowerCase();

  if (desc.includes("sbtc") || desc.includes("stacks")) {
    score = "high";
  } else if (desc.includes("x402") || desc.includes("402")) {
    score = "medium";
  }

  // Probe if we found a URL (with SSRF protection)
  let probeSuccess = false;
  if (endpointUrl && !dryRun && isUrlSafe(endpointUrl)) {
    try {
      const probe = await probeEndpoint(endpointUrl);
      probeSuccess = probe.success;
      if (probe.sbtcOption) score = "high";
    } catch {
      // Probe failed, that's fine
    }
  }

  const scoreEmoji = score === "high" ? "★" : score === "medium" ? "◆" : "·";
  console.log(
    `  ${scoreEmoji} ${repo.full_name} [${score}]${alreadyTracked ? " (tracked)" : ""}${endpointUrl ? ` → ${endpointUrl}` : ""}`
  );

  return {
    repo: repo.full_name,
    url: endpointUrl || "",
    description: repo.description || "",
    language: repo.language || "unknown",
    score,
    probeSuccess,
    alreadyTracked,
  };
}

async function extractEndpointUrl(repoFullName: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(
      ["gh", "api", `repos/${repoFullName}/readme`, "-q", ".content"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const b64 = await new Response(proc.stdout).text();
    await proc.exited;

    const content = atob(b64.trim());

    // Look for URLs that look like x402 endpoints
    const urlPattern = /https?:\/\/[^\s)>"']+/g;
    const urls = content.match(urlPattern) || [];

    for (const url of urls) {
      // Skip common non-endpoint URLs
      if (
        url.includes("github.com") ||
        url.includes("npmjs.com") ||
        url.includes("docs.") ||
        url.includes("shields.io") ||
        url.includes("img.") ||
        url.includes(".md")
      ) {
        continue;
      }
      // Prefer URLs with /api, /v1, /data, /oracle, etc.
      if (/\/(api|v[0-9]|data|oracle|query|chat|agent)/.test(url)) {
        return url.replace(/[,.\s]+$/, "");
      }
    }

    // Return first non-filtered URL as fallback
    for (const url of urls) {
      if (
        !url.includes("github.com") &&
        !url.includes("npmjs.com") &&
        !url.includes("docs.") &&
        !url.includes("shields.io") &&
        !url.includes("img.")
      ) {
        return url.replace(/[,.\s]+$/, "");
      }
    }
  } catch {
    // README not found or not readable
  }

  return null;
}
