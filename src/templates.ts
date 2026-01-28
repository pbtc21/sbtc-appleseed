import type { VerifyResult } from "./types";
import { formatSats } from "./wallet";

export function successComment(result: VerifyResult): string {
  const p = result.payment!;
  const explorerUrl = p.txId
    ? `https://explorer.hiro.so/txid/${p.txId}`
    : null;
  const txLine = explorerUrl
    ? `**Transaction:** [view on explorer](${explorerUrl})`
    : `**Transaction:** settlement pending (facilitator processed)`;

  return `## sBTC Payment Verification — Passed

**Endpoint:** \`${result.endpoint}\`
**Payment:** ${formatSats(p.amount)} sent to \`${p.recipient}\`
${txLine}
**Resource delivered:** Yes (HTTP ${p.httpStatus}, ${p.bodyLength.toLocaleString()} bytes)

Your endpoint is live and accepting sBTC payments via x402.
The sBTC from this test is yours to keep.

---
*Verified by [sBTC Appleseed](https://github.com/aibtcdev) — ${result.timestamp}*`;
}

export function failureComment(result: VerifyResult): string {
  const probe = result.probe;
  const payment = result.payment;

  let stepFailed: string;
  let details: string;

  if (!probe.success) {
    stepFailed = "Endpoint probe";
    details = probe.error || `HTTP ${probe.httpStatus} (expected 402)`;
  } else if (!probe.sbtcOption) {
    stepFailed = "sBTC detection";
    details =
      "402 response received but sBTC/Stacks not found in accepted payment methods. " +
      `Accepted networks: ${
        probe.allAccepts?.map((a) => a.network).join(", ") || "none detected"
      }`;
  } else if (!payment) {
    stepFailed = "Payment signing";
    details = "Could not sign or submit payment transaction";
  } else if (!payment.success) {
    stepFailed = "Resource delivery";
    details =
      payment.error ||
      `HTTP ${payment.httpStatus} after payment (expected 200)`;
  } else {
    stepFailed = "Unknown";
    details = "Unexpected failure state";
  }

  return `## sBTC Payment Verification — Failed

**Endpoint:** \`${result.endpoint}\`
**Step failed:** ${stepFailed}
**Details:** ${details}

See the integration guide in this issue for setup instructions.
Happy to help — reply here with questions.

---
*Verified by [sBTC Appleseed](https://github.com/aibtcdev) — ${result.timestamp}*`;
}
