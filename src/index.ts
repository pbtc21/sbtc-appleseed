import { loadConfig } from "./config";
import type { Config } from "./config";
import { getWalletAddress, getWalletInfo, formatSats } from "./wallet";
import { probeEndpoint } from "./probe";
import { payEndpoint } from "./pay";
import { postReport } from "./report";
import { updateCRM } from "./crm";
import { addEndpoint, listEndpoints, updateEndpoint } from "./db";
import { discoverEndpoints } from "./discover";
import { runMonitorPass, runMonitorLoop, sendDigest } from "./monitor";
import { alertEndpointDown, alertEndpointRecovered, alertBatchSummary, alertVerifyResult } from "./telegram";
import { openOutreachIssue } from "./outreach";
import { evaluateRepo, printReport } from "./evaluate";
import { generateSbtcPR } from "./pr-generator";
import type { VerifyResult } from "./types";
import type { EndpointStatus, Endpoint } from "./db";

const HELP = `
  sBTC Appleseed — x402 sBTC Adoption Engine

  Commands:
    verify    Verify an endpoint or batch of endpoints
    add       Register an endpoint in the registry
    list      Show all tracked endpoints
    discover  Search GitHub for x402 endpoints
    monitor   Run monitoring pass or continuous loop
    digest    Send daily status digest
    outreach  Open a GitHub issue to propose sBTC support
    evaluate  Analyze a repo for x402/sBTC integration

  verify:
    --endpoint, -e <url>    Single endpoint to verify
    --all                   Verify all monitoring/awaiting endpoints
    --status <status>       Verify all endpoints with given status
    --issue, -i <url>       GitHub issue URL to post results
    --max-sbtc, -m <sats>   Max sats per verify (default: 50000)
    --dry-run               Probe only, skip payment

  add:
    <url>                   Endpoint URL to register
    --repo <github-url>     Associated GitHub repo
    --token <STX|sBTC>      Expected token type

  list:
    --status <status>       Filter by status

  discover:
    --language <lang>       Filter by language (ts, js, python, go)
    --limit <n>             Max results (default: 50)
    --dry-run               Preview without inserting

  monitor:
    --once                  Single pass (default: continuous loop)
    --interval <minutes>    Loop interval (default: 30)
    --healthy <hours>       Healthy recheck interval (default: 24)
    --broken <hours>        Broken recheck interval (default: 6)
    --dry-run               Probe only, skip payment

  outreach:
    <url>                   Endpoint URL
    --repo <github-url>     GitHub repo to open issue on

  evaluate:
    <repo-url>              GitHub repo URL to evaluate
    --auto                  Auto-generate PR if possible

  Examples:
    bun run appleseed verify -e https://api.example.com/data
    bun run appleseed verify --all
    bun run appleseed add https://api.example.com/data --repo https://github.com/org/repo
    bun run appleseed list --status verified
    bun run appleseed discover --language ts --limit 20
    bun run appleseed monitor --once
    bun run appleseed outreach https://api.example.com/data --repo https://github.com/org/repo
    bun run appleseed evaluate https://github.com/org/repo --auto
`;

function parseCommand(): { command: string; args: string[] } {
  const allArgs = process.argv.slice(2);
  const command = allArgs[0] || "help";
  // Support legacy: if first arg starts with -- it's the old verify format
  if (command.startsWith("-")) {
    return { command: "verify", args: allArgs };
  }
  return { command, args: allArgs.slice(1) };
}

function parseFlags(args: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run" || arg === "--all") {
      flags[arg.replace(/^--/, "")] = true;
    } else if (arg.startsWith("--") || arg.startsWith("-")) {
      const key = arg.replace(/^-+/, "");
      flags[key] = args[++i] || "";
    } else {
      positional.push(arg);
    }
  }

  if (positional.length > 0) flags._pos = positional[0];
  return flags;
}

async function main() {
  const { command, args } = parseCommand();
  const config = loadConfig();

  console.log("\n  sBTC Appleseed\n");

  switch (command) {
    case "verify":
      return cmdVerify(args, config);
    case "add":
      return cmdAdd(args, config);
    case "list":
      return cmdList(args, config);
    case "discover":
      return cmdDiscover(args, config);
    case "monitor":
      return cmdMonitor(args, config);
    case "digest":
      return cmdDigest(config);
    case "outreach":
      return cmdOutreach(args, config);
    case "evaluate":
      return cmdEvaluate(args, config);
    case "help":
    default:
      console.log(HELP);
      process.exit(0);
  }
}

// ── verify ────────────────────────────────────────────────

async function cmdVerify(args: string[], config: Config) {
  const flags = parseFlags(args);
  const dryRun = !!flags["dry-run"];
  const endpoint = (flags.endpoint || flags.e || flags._pos) as string;
  const all = !!flags.all;
  const statusFilter = flags.status as string;
  const issue = (flags.issue || flags.i) as string | undefined;

  if (flags["max-sbtc"] || flags.m) {
    config.maxSbtcPerVerify = parseInt(String(flags["max-sbtc"] || flags.m), 10);
  }

  // Load wallet unless dry-run
  if (!dryRun && config.privateKey) {
    console.log("  [wallet] Loading...");
    const address = await getWalletAddress(config);
    config.walletAddress = address;
    const wallet = await getWalletInfo(address, config);
    console.log(`  [wallet] ${wallet.address}`);
    console.log(
      `  [wallet] Balance: ${formatSats(wallet.stxBalance)} STX, ${formatSats(wallet.sbtcBalance)} sBTC`
    );
    console.log(`  [wallet] Max per verify: ${formatSats(config.maxSbtcPerVerify)}\n`);
  }

  // Batch mode
  if (all || statusFilter) {
    const statuses: EndpointStatus[] = statusFilter
      ? [statusFilter as EndpointStatus]
      : ["awaiting_verification", "monitoring", "verified"];
    const endpoints = statuses.flatMap((s) => getEndpointsByStatus(config.dbPath, s));

    if (endpoints.length === 0) {
      console.log("  No endpoints to verify.");
      process.exit(0);
    }

    console.log(`  Verifying ${endpoints.length} endpoints...\n`);
    let passed = 0;
    let failed = 0;

    for (const ep of endpoints) {
      const result = await verifySingle(ep.url, dryRun, issue || null, config);
      const wasBroken = ep.status === "broken";

      if (result) {
        passed++;
        updateEndpoint(config.dbPath, ep.url, {
          status: "verified",
          last_check: new Date().toISOString(),
          last_result: "passed",
          total_spent: ep.total_spent + parseInt(result.payment?.amount || "0", 10),
        });
        if (wasBroken) {
          await alertEndpointRecovered(ep, config);
        }
      } else {
        failed++;
        updateEndpoint(config.dbPath, ep.url, {
          status: "broken",
          last_check: new Date().toISOString(),
          last_result: "failed",
        });
        if (!wasBroken) {
          await alertEndpointDown(ep, "Verification failed", config);
        }
      }
      console.log("");
    }

    console.log(`  --- Batch Result ---`);
    console.log(`  Passed: ${passed}  Failed: ${failed}  Total: ${endpoints.length}\n`);
    await alertBatchSummary(passed, failed, endpoints.length, config);
    process.exit(failed > 0 ? 1 : 0);
    return;
  }

  // Single endpoint mode
  if (!endpoint) {
    console.log("  Error: provide --endpoint <url> or --all\n");
    process.exit(1);
  }

  const result = await verifySingle(endpoint, dryRun, issue || null, config);
  process.exit(result ? 0 : 1);
}

async function verifySingle(
  endpoint: string,
  dryRun: boolean,
  issue: string | null,
  config: Config
): Promise<VerifyResult | null> {
  console.log(`  [probe] ${endpoint}`);
  const probe = await probeEndpoint(endpoint);

  if (!probe.success) {
    console.log(`  [probe] FAILED: ${probe.error}`);
  } else {
    console.log(`  [probe] Protocol: x402 ${probe.version}`);
    if (probe.sbtcOption) {
      console.log(
        `  [probe] sBTC accepted: ${formatSats(probe.sbtcOption.amount)} → ${probe.sbtcOption.payTo}`
      );
      console.log(`  [probe] Token: ${probe.sbtcOption.tokenType}`);
    } else {
      console.log(`  [probe] sBTC NOT found in accepted payments`);
    }
  }

  let payResult = null;

  if (dryRun) {
    console.log(`  [pay] Dry run — skipping payment`);
  } else if (!config.privateKey) {
    console.log(`  [pay] No APPLESEED_PRIVATE_KEY — skipping payment`);
  } else if (probe.success && probe.sbtcOption) {
    console.log(`  [pay] Sending payment...`);
    payResult = await payEndpoint(endpoint, probe.sbtcOption, config);

    if (payResult.success) {
      console.log(`  [pay] SUCCESS`);
      console.log(
        `  [pay] Resource delivered: HTTP ${payResult.httpStatus}, ${payResult.bodyLength.toLocaleString()} bytes`
      );
      if (payResult.txId) {
        console.log(`  [pay] TX: https://explorer.hiro.so/txid/${payResult.txId}`);
      }
    } else {
      console.log(`  [pay] FAILED: ${payResult.error}`);
    }
  }

  const result: VerifyResult = {
    endpoint,
    probe,
    payment: payResult,
    timestamp: new Date().toISOString(),
  };

  // Report
  if (issue) {
    console.log(`  [report] Posting to ${issue}`);
    try {
      await postReport(issue, result);
    } catch (err) {
      console.error(`  [report] Failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // CRM
  await updateCRM(result, config);

  // Telegram alert
  await alertVerifyResult(result, config);

  // Summary
  const passed = dryRun ? probe.success : (payResult?.success ?? false);
  console.log(`  ${passed ? "PASSED" : "FAILED"} — ${endpoint}`);

  return passed ? result : null;
}

// ── add ───────────────────────────────────────────────────

async function cmdAdd(args: string[], config: Config) {
  const flags = parseFlags(args);
  const url = flags._pos as string;
  const repo = flags.repo as string | undefined;
  const token = (flags.token as string) || "STX";

  if (!url) {
    console.log("  Usage: appleseed add <url> [--repo <github-url>] [--token sBTC|STX]\n");
    process.exit(1);
  }

  // Validate URL scheme (security: prevent javascript:, file://, etc.)
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      console.log(`  Error: Only http/https URLs allowed (got ${parsed.protocol})\n`);
      process.exit(1);
    }
  } catch {
    console.log(`  Error: Invalid URL format\n`);
    process.exit(1);
  }

  // Probe to validate
  console.log(`  [probe] Checking ${url}...`);
  const probe = await probeEndpoint(url);

  const ep = addEndpoint(config.dbPath, url, {
    repo_url: repo,
    token_type: probe.sbtcOption?.tokenType || token,
    status: "discovered",
  });

  console.log(`  Added: ${ep.url}`);
  console.log(`  Status: ${ep.status}`);
  console.log(`  Probe: ${probe.success ? `x402 ${probe.version}` : `failed (${probe.error})`}`);
  if (repo) console.log(`  Repo: ${repo}`);
  console.log("");
}

// ── list ──────────────────────────────────────────────────

async function cmdList(args: string[], config: Config) {
  const flags = parseFlags(args);
  const statusFilter = flags.status as string | undefined;

  const endpoints = listEndpoints(
    config.dbPath,
    statusFilter as EndpointStatus | undefined
  );

  if (endpoints.length === 0) {
    console.log("  No endpoints registered.\n");
    console.log("  Add one: appleseed add <url>");
    console.log("  Or discover: appleseed discover\n");
    process.exit(0);
  }

  const statusColors: Record<string, string> = {
    verified: "\x1b[32m",    // green
    monitoring: "\x1b[32m",
    broken: "\x1b[31m",      // red
    discovered: "\x1b[33m",  // yellow
    contacted: "\x1b[33m",
    evaluating: "\x1b[36m",  // cyan
    pr_opened: "\x1b[36m",
    awaiting_verification: "\x1b[35m", // magenta
  };
  const reset = "\x1b[0m";

  console.log(`  Endpoints (${endpoints.length}):\n`);
  for (const ep of endpoints) {
    const color = statusColors[ep.status] || "";
    const spent = ep.total_spent > 0 ? ` | spent: ${formatSats(ep.total_spent)}` : "";
    const lastCheck = ep.last_check
      ? ` | last: ${new Date(ep.last_check).toLocaleDateString()}`
      : "";
    console.log(
      `  ${color}${ep.status.padEnd(24)}${reset} ${ep.url}${spent}${lastCheck}`
    );
  }
  console.log("");
}

// ── discover ──────────────────────────────────────────────

async function cmdDiscover(args: string[], config: Config) {
  const flags = parseFlags(args);
  const language = flags.language as string | undefined;
  const limit = flags.limit ? parseInt(String(flags.limit), 10) : 50;
  const dryRun = !!flags["dry-run"];

  const results = await discoverEndpoints(config, { language, limit, dryRun });

  const byScore = { high: 0, medium: 0, low: 0 };
  const newCount = results.filter((r) => !r.alreadyTracked).length;
  for (const r of results) byScore[r.score]++;

  console.log(`\n  --- Discovery Summary ---`);
  console.log(`  Found: ${results.length} repos`);
  console.log(`  New: ${newCount} | Already tracked: ${results.length - newCount}`);
  console.log(`  Score: ${byScore.high} high, ${byScore.medium} medium, ${byScore.low} low`);
  if (dryRun) console.log(`  (dry-run — nothing inserted)`);
  console.log("");
}

// ── monitor ──────────────────────────────────────────────

async function cmdMonitor(args: string[], config: Config) {
  const flags = parseFlags(args);
  const once = !!flags.once;
  const dryRun = !!flags["dry-run"];
  const intervalMinutes = flags.interval ? parseInt(String(flags.interval), 10) : 30;
  const healthyHours = flags.healthy ? parseInt(String(flags.healthy), 10) : 24;
  const brokenHours = flags.broken ? parseInt(String(flags.broken), 10) : 6;

  const opts = {
    healthyIntervalHours: healthyHours,
    brokenIntervalHours: brokenHours,
    dryRun,
  };

  if (once) {
    const result = await runMonitorPass(config, opts);
    console.log(`\n  --- Monitor Pass ---`);
    console.log(`  Checked: ${result.checked}`);
    console.log(`  Healthy: ${result.healthy}  Broken: ${result.broken}`);
    if (result.recovered > 0) console.log(`  Recovered: ${result.recovered}`);
    if (result.newlyBroken > 0) console.log(`  Newly broken: ${result.newlyBroken}`);
    console.log("");
    process.exit(result.newlyBroken > 0 ? 1 : 0);
  } else {
    await runMonitorLoop(config, { ...opts, intervalMinutes });
  }
}

async function cmdDigest(config: Config) {
  await sendDigest(config);
}

// ── outreach ─────────────────────────────────────────────

async function cmdOutreach(args: string[], config: Config) {
  const flags = parseFlags(args);
  const endpointUrl = (flags._pos || flags.endpoint || flags.e) as string | undefined;
  const repoUrl = flags.repo as string | undefined;

  if (!repoUrl) {
    console.log("  Usage: appleseed outreach <endpoint-url> --repo <github-repo-url>\n");
    process.exit(1);
  }

  console.log(`  [outreach] Opening issue on ${repoUrl}...`);
  const issueUrl = await openOutreachIssue(repoUrl, endpointUrl || null, config);

  if (issueUrl) {
    console.log(`  Issue: ${issueUrl}\n`);
  } else {
    console.log("  Failed to open issue.\n");
    process.exit(1);
  }
}

// ── evaluate ─────────────────────────────────────────────

async function cmdEvaluate(args: string[], config: Config) {
  const flags = parseFlags(args);
  const repoUrl = flags._pos as string;
  const auto = !!flags.auto;

  if (!repoUrl) {
    console.log("  Usage: appleseed evaluate <github-repo-url> [--auto]\n");
    process.exit(1);
  }

  console.log(`  [evaluate] Analyzing ${repoUrl}...`);
  const report = await evaluateRepo(repoUrl, config);
  printReport(report);

  if (auto && !report.hasSbtc) {
    console.log("  [pr-gen] Auto mode — generating PR...");
    const prUrl = await generateSbtcPR(report, config);
    if (prUrl) {
      console.log(`  PR: ${prUrl}\n`);
    } else {
      console.log("  PR generation skipped or failed.\n");
    }
  } else if (!auto && !report.hasSbtc) {
    console.log("  Tip: add --auto to generate a PR with sBTC integration\n");
  }
}

// ── helpers ───────────────────────────────────────────────

function getEndpointsByStatus(dbPath: string, status: EndpointStatus) {
  return listEndpoints(dbPath, status);
}

// ── main ──────────────────────────────────────────────────

main().catch((err) => {
  console.error(`\n  Fatal error: ${err.message}\n`);
  process.exit(1);
});
