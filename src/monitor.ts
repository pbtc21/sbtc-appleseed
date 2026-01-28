import type { Config } from "./config";
import { getEndpointsDue, listEndpoints, updateEndpoint } from "./db";
import type { Endpoint } from "./db";
import { probeEndpoint } from "./probe";
import { payEndpoint } from "./pay";
import { alertEndpointDown, alertEndpointRecovered, alertMonitorDigest } from "./telegram";
import { formatSats } from "./wallet";

interface MonitorOpts {
  healthyIntervalHours: number;
  brokenIntervalHours: number;
  dryRun: boolean;
}

interface MonitorResult {
  checked: number;
  healthy: number;
  broken: number;
  recovered: number;
  newlyBroken: number;
}

/**
 * Run a single monitoring pass: check all endpoints that are due.
 */
export async function runMonitorPass(
  config: Config,
  opts: MonitorOpts
): Promise<MonitorResult> {
  const due = getEndpointsDue(
    config.dbPath,
    opts.healthyIntervalHours,
    opts.brokenIntervalHours
  );

  if (due.length === 0) {
    console.log("  [monitor] No endpoints due for check.");
    return { checked: 0, healthy: 0, broken: 0, recovered: 0, newlyBroken: 0 };
  }

  console.log(`  [monitor] ${due.length} endpoints due for check\n`);

  let healthy = 0;
  let broken = 0;
  let recovered = 0;
  let newlyBroken = 0;

  for (const ep of due) {
    const wasBroken = ep.status === "broken";
    const passed = await checkEndpoint(ep, config, opts.dryRun);

    if (passed) {
      healthy++;
      updateEndpoint(config.dbPath, ep.url, {
        status: "monitoring",
        last_check: new Date().toISOString(),
        last_result: "passed",
      });
      if (wasBroken) {
        recovered++;
        console.log(`  [monitor] RECOVERED: ${ep.url}`);
        await alertEndpointRecovered(ep, config);
      } else {
        console.log(`  [monitor] OK: ${ep.url}`);
      }
    } else {
      broken++;
      updateEndpoint(config.dbPath, ep.url, {
        status: "broken",
        last_check: new Date().toISOString(),
        last_result: "failed",
      });
      if (!wasBroken) {
        newlyBroken++;
        console.log(`  [monitor] BROKEN: ${ep.url}`);
        await alertEndpointDown(ep, "Monitor check failed", config);
      } else {
        console.log(`  [monitor] STILL BROKEN: ${ep.url}`);
      }
    }
  }

  return { checked: due.length, healthy, broken, recovered, newlyBroken };
}

/**
 * Check a single endpoint via probe (and optionally pay).
 */
async function checkEndpoint(
  ep: Endpoint,
  config: Config,
  dryRun: boolean
): Promise<boolean> {
  try {
    const probe = await probeEndpoint(ep.url);
    if (!probe.success) return false;

    if (dryRun || !config.privateKey) {
      return probe.success;
    }

    // If it accepts sBTC, try a payment
    if (probe.sbtcOption) {
      const payResult = await payEndpoint(ep.url, probe.sbtcOption, config);
      if (payResult.success) {
        updateEndpoint(config.dbPath, ep.url, {
          total_spent: ep.total_spent + parseInt(payResult.amount || "0", 10),
        });
      }
      return payResult.success;
    }

    // Probe succeeded, no sBTC option — still counts as alive
    return true;
  } catch {
    return false;
  }
}

/**
 * Send a digest summary of all endpoint statuses.
 */
export async function sendDigest(config: Config): Promise<void> {
  const all = listEndpoints(config.dbPath);
  const healthy = all.filter((e) =>
    ["verified", "monitoring"].includes(e.status)
  ).length;
  const broken = all.filter((e) => e.status === "broken").length;
  const totalSpent = all.reduce((sum, e) => sum + e.total_spent, 0);

  console.log(`\n  --- Daily Digest ---`);
  console.log(`  Total endpoints: ${all.length}`);
  console.log(`  Healthy: ${healthy}`);
  console.log(`  Broken: ${broken}`);
  console.log(`  Total spent: ${formatSats(totalSpent)}`);
  console.log("");

  await alertMonitorDigest(healthy, broken, 0, 0, config);
}

/**
 * Run continuous monitoring loop with configurable interval.
 */
export async function runMonitorLoop(
  config: Config,
  opts: MonitorOpts & { intervalMinutes: number }
): Promise<never> {
  console.log(`  [monitor] Starting continuous monitoring`);
  console.log(`  [monitor] Check interval: ${opts.intervalMinutes}m`);
  console.log(`  [monitor] Healthy recheck: ${opts.healthyIntervalHours}h`);
  console.log(`  [monitor] Broken recheck: ${opts.brokenIntervalHours}h\n`);

  while (true) {
    const result = await runMonitorPass(config, opts);
    console.log(
      `  [monitor] Pass complete: ${result.checked} checked, ${result.healthy} ok, ${result.broken} broken\n`
    );

    await new Promise((r) => setTimeout(r, opts.intervalMinutes * 60_000));
  }
}
