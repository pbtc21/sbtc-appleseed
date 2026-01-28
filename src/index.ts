import { loadConfig } from "./config";
import { getWalletAddress, getWalletInfo, formatSats } from "./wallet";
import { probeEndpoint } from "./probe";
import { payEndpoint } from "./pay";
import { postReport } from "./report";
import { updateCRM } from "./crm";
import type { VerifyResult } from "./types";

function parseArgs(): {
  endpoint: string;
  issue: string | null;
  maxSbtc: number | null;
  dryRun: boolean;
} {
  const args = process.argv.slice(2);
  let endpoint = "";
  let issue: string | null = null;
  let maxSbtc: number | null = null;
  let dryRun = false;

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--endpoint":
      case "-e":
        endpoint = args[++i];
        break;
      case "--issue":
      case "-i":
        issue = args[++i];
        break;
      case "--max-sbtc":
      case "-m":
        maxSbtc = parseInt(args[++i], 10);
        break;
      case "--dry-run":
        dryRun = true;
        break;
      default:
        if (!endpoint && !args[i].startsWith("-")) {
          endpoint = args[i];
        }
    }
  }

  if (!endpoint) {
    console.error(`
Usage: bun run verify --endpoint <url> [--issue <github-issue-url>] [--max-sbtc <sats>] [--dry-run]

  --endpoint, -e    x402 endpoint URL to verify
  --issue, -i       GitHub issue URL to post results to
  --max-sbtc, -m    Max sats to spend (default: 50000)
  --dry-run         Probe only, don't send payment

Examples:
  bun run verify --endpoint https://agent.example.com/api/data
  bun run verify -e https://agent.example.com/api/data -i https://github.com/org/repo/issues/1
  bun run verify -e https://agent.example.com/api/data --dry-run
`);
    process.exit(1);
  }

  return { endpoint, issue, maxSbtc, dryRun };
}

async function main() {
  const args = parseArgs();
  const config = loadConfig();

  if (args.maxSbtc) {
    config.maxSbtcPerVerify = args.maxSbtc;
  }

  console.log("\n  sBTC Appleseed — Verification Script\n");

  // Step 0: Wallet info (skip on dry-run if key is invalid)
  if (!args.dryRun) {
    console.log("  [wallet] Loading...");
    const address = await getWalletAddress(config);
    config.walletAddress = address;
    const wallet = await getWalletInfo(address, config);
    console.log(`  [wallet] ${wallet.address}`);
    console.log(
      `  [wallet] Balance: ${formatSats(wallet.stxBalance)} STX, ${formatSats(wallet.sbtcBalance)} sBTC`
    );
    console.log(`  [wallet] Max per verify: ${formatSats(config.maxSbtcPerVerify)}\n`);
  } else {
    console.log("  [wallet] Dry run — skipping wallet load\n");
  }

  // Step 1: Probe
  console.log(`  [probe] ${args.endpoint}`);
  const probe = await probeEndpoint(args.endpoint);

  if (!probe.success) {
    console.log(`  [probe] FAILED: ${probe.error}`);
  } else {
    console.log(`  [probe] Protocol: x402 ${probe.version}`);
    if (probe.sbtcOption) {
      console.log(
        `  [probe] sBTC accepted: ${formatSats(probe.sbtcOption.amount)} → ${probe.sbtcOption.payTo}`
      );
      console.log(`  [probe] Token: ${probe.sbtcOption.tokenType}`);
      console.log(`  [probe] Facilitator: ${probe.sbtcOption.facilitatorUrl}`);
    } else {
      console.log(`  [probe] sBTC NOT found in accepted payments`);
      if (probe.allAccepts) {
        console.log(
          `  [probe] Available: ${probe.allAccepts.map((a) => `${a.network}/${a.asset}`).join(", ")}`
        );
      }
    }
  }

  // Step 2: Pay (unless dry-run or probe failed)
  let payResult = null;

  if (args.dryRun) {
    console.log(`\n  [pay] Dry run — skipping payment\n`);
  } else if (!config.privateKey) {
    console.log(`\n  [pay] No APPLESEED_PRIVATE_KEY set — skipping payment\n`);
  } else if (probe.success && probe.sbtcOption) {
    console.log(`\n  [pay] Sending payment...`);
    payResult = await payEndpoint(args.endpoint, probe.sbtcOption, config);

    if (payResult.success) {
      console.log(`  [pay] SUCCESS`);
      console.log(
        `  [pay] Resource delivered: HTTP ${payResult.httpStatus}, ${payResult.bodyLength.toLocaleString()} bytes`
      );
      if (payResult.txId) {
        console.log(
          `  [pay] TX: https://explorer.hiro.so/txid/${payResult.txId}`
        );
      }
    } else {
      console.log(`  [pay] FAILED: ${payResult.error}`);
    }
  } else {
    console.log(`\n  [pay] Skipped — probe did not find sBTC option\n`);
  }

  // Build result
  const result: VerifyResult = {
    endpoint: args.endpoint,
    probe,
    payment: payResult,
    timestamp: new Date().toISOString(),
  };

  // Step 3: Report to GitHub
  if (args.issue) {
    console.log(`\n  [report] Posting to ${args.issue}`);
    try {
      await postReport(args.issue, result);
    } catch (err) {
      console.error(
        `  [report] Failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  } else {
    console.log(`\n  [report] No --issue provided, skipping GitHub comment`);
  }

  // Step 4: CRM update
  console.log(`  [crm] Updating...`);
  await updateCRM(result, config);

  // Summary
  console.log(`\n  --- Result ---`);
  const passed = args.dryRun ? probe.success : (payResult?.success ?? false);
  console.log(`  Status: ${passed ? "PASSED" : "FAILED"}`);
  console.log(`  Endpoint: ${args.endpoint}`);
  if (payResult) {
    console.log(
      `  Payment: ${formatSats(payResult.amount)} → ${payResult.recipient}`
    );
  }
  console.log(`  Timestamp: ${result.timestamp}\n`);

  process.exit(passed ? 0 : 1);
}

main().catch((err) => {
  console.error(`\n  Fatal error: ${err.message}\n`);
  process.exit(1);
});
