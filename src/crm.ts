import type { VerifyResult } from "./types";
import type { Config } from "./config";

const CRM_API = "https://x402crm-api.c3dar.workers.dev";

interface CrmEntry {
  provider_id: string;
  synced_data: { domain?: string };
  notes?: string;
  supports_sbtc?: boolean;
  pipeline_status?: string;
}

/**
 * Update the x402 CRM with verification results.
 * Matches the endpoint hostname to a CRM provider, then updates via PUT.
 * Best-effort — failure here doesn't block the script.
 */
export async function updateCRM(
  result: VerifyResult,
  _config: Config
): Promise<void> {
  try {
    // Find matching provider by domain
    const hostname = new URL(result.endpoint).hostname;
    const provider = await findProvider(hostname);

    if (!provider) {
      console.log(`  [crm] No CRM entry found for ${hostname} (non-blocking)`);
      return;
    }

    const isSuccess = result.payment?.success ?? false;

    const note = isSuccess
      ? `Appleseed verified ${new Date(result.timestamp).toLocaleDateString()}: PASSED — ${result.payment!.amount} sats sent, resource delivered (HTTP ${result.payment!.httpStatus}).${result.payment!.txId ? ` TX: ${result.payment!.txId}` : ""}`
      : `Appleseed verified ${new Date(result.timestamp).toLocaleDateString()}: FAILED — ${result.probe.error || result.payment?.error || "unknown error"}`;

    // Append to existing notes
    const existingNotes = provider.notes || "";
    const updatedNotes = existingNotes
      ? `${existingNotes}\n${note}`
      : note;

    const update: Record<string, unknown> = {
      notes: updatedNotes,
    };

    // Mark supports_sbtc if payment succeeded
    if (isSuccess) {
      update.supports_sbtc = true;
    }

    // Move to "onboarding" if verified and currently "new"
    if (isSuccess && provider.pipeline_status === "new") {
      update.pipeline_status = "onboarding";
    }

    const res = await fetch(`${CRM_API}/crm/${provider.provider_id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
      signal: AbortSignal.timeout(10000),
    });

    if (res.ok) {
      console.log(`  [crm] Updated ${provider.provider_id}`);
    } else {
      console.log(`  [crm] PUT returned ${res.status} (non-blocking)`);
    }
  } catch (err) {
    console.log(
      `  [crm] Update skipped: ${err instanceof Error ? err.message : "error"}`
    );
  }
}

async function findProvider(hostname: string): Promise<CrmEntry | null> {
  const res = await fetch(`${CRM_API}/crm`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) return null;

  const data = (await res.json()) as { entries: CrmEntry[] };

  // Exact domain match
  for (const entry of data.entries) {
    if (entry.synced_data.domain === hostname) return entry;
  }

  // Partial match (domain contains hostname or vice versa)
  for (const entry of data.entries) {
    const domain = entry.synced_data.domain || "";
    if (hostname.includes(domain) || domain.includes(hostname)) return entry;
  }

  return null;
}
