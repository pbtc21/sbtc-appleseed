import type { VerifyResult } from "./types";
import type { Config } from "./config";

/**
 * Update the x402 CRM with verification results.
 * Best-effort — failure here doesn't block the script.
 */
export async function updateCRM(
  result: VerifyResult,
  config: Config
): Promise<void> {
  try {
    const isSuccess = result.payment?.success ?? false;

    const update = {
      endpoint: result.endpoint,
      verificationStatus: isSuccess ? "passed" : "failed",
      verificationTxId: result.payment?.txId || null,
      sbtcSent: result.payment?.amount || "0",
      verifiedAt: result.timestamp,
      notes: isSuccess
        ? `Appleseed verification passed. ${result.payment!.amount} sats sent. Resource delivered (HTTP ${result.payment!.httpStatus}).`
        : `Appleseed verification failed. ${result.probe.error || result.payment?.error || "unknown error"}`,
    };

    const res = await fetch(`${config.crmUrl}/api/leads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      console.log("  CRM updated");
    } else {
      console.log(`  CRM update returned ${res.status} (non-blocking)`);
    }
  } catch (err) {
    console.log(
      `  CRM update skipped: ${err instanceof Error ? err.message : "error"}`
    );
  }
}
