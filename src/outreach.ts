import type { Config } from "./config";
import { updateEndpoint, getEndpoint } from "./db";
import { probeEndpoint } from "./probe";

/**
 * Open a GitHub issue on a repo to propose sBTC x402 integration.
 * Picks the right template based on probe results.
 */
export async function openOutreachIssue(
  repoUrl: string,
  endpointUrl: string | null,
  config: Config
): Promise<string | null> {
  const { owner, repo } = parseRepoUrl(repoUrl);

  // Probe endpoint if provided
  let hasX402 = false;
  let hasSbtc = false;
  if (endpointUrl) {
    try {
      const probe = await probeEndpoint(endpointUrl);
      hasX402 = probe.success;
      hasSbtc = !!probe.sbtcOption;
    } catch {
      // Probe failed, use generic template
    }
  }

  const title = hasSbtc
    ? "sBTC x402 Integration Verified — Appleseed"
    : hasX402
    ? "Add sBTC support to your x402 endpoint"
    : "x402 Payment Integration — sBTC Support";

  const body = hasSbtc
    ? alreadyHasSbtcTemplate(endpointUrl!)
    : hasX402
    ? addSbtcTemplate(endpointUrl!)
    : newIntegrationTemplate(repoUrl);

  try {
    const proc = Bun.spawn(
      [
        "gh", "issue", "create",
        "--repo", `${owner}/${repo}`,
        "--title", title,
        "--body", body,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`  [outreach] gh issue create failed: ${stderr.trim()}`);
      return null;
    }

    const issueUrl = stdout.trim();
    console.log(`  [outreach] Issue created: ${issueUrl}`);

    // Update DB
    const ep = getEndpoint(config.dbPath, endpointUrl || repoUrl);
    if (ep) {
      updateEndpoint(config.dbPath, ep.url, {
        status: "contacted",
        issue_url: issueUrl,
      });
    }

    return issueUrl;
  } catch (err) {
    console.error(`  [outreach] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parseRepoUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Invalid GitHub repo URL: ${url}`);
  return { owner: match[1], repo: match[2].replace(/\.git$/, "") };
}

// ── Templates ────────────────────────────────────────────

function alreadyHasSbtcTemplate(endpointUrl: string): string {
  return `## sBTC x402 Verification

Hi! I'm [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed), a tool that finds and verifies x402 endpoints accepting sBTC payments.

Your endpoint at \`${endpointUrl}\` already accepts sBTC — nice work!

I'll be running periodic verification checks and sending small sBTC payments to confirm everything stays healthy. The sBTC from these tests is yours to keep.

### What happens next

- I'll verify your endpoint and post results here
- If anything breaks, I'll update this issue
- No action needed from you

---
*Automated by [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed)*`;
}

function addSbtcTemplate(endpointUrl: string): string {
  return `## Add sBTC Support to Your x402 Endpoint

Hi! I'm [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed), a tool that helps x402 developers accept sBTC payments.

Your endpoint at \`${endpointUrl}\` supports x402 payments — but doesn't accept sBTC yet. Adding sBTC support is straightforward and opens your endpoint to Bitcoin-backed payments on Stacks.

### Quick Integration

Add sBTC to your accepted payment methods:

\`\`\`typescript
// In your x402 payment config, add to accepts array:
{
  scheme: "exact",
  network: "stacks-mainnet",
  asset: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR.token-sbtc::sbtc",
  amount: "1000", // price in sats
  payTo: "YOUR_STACKS_ADDRESS",
  maxTimeoutSeconds: 300,
  extra: {
    facilitator: "https://facilitator.stacksx402.com",
    tokenType: "sBTC"
  }
}
\`\`\`

### Why sBTC?

- **Bitcoin-backed**: 1:1 peg with BTC via Stacks
- **Fast settlement**: ~30 second block times on Stacks
- **Growing ecosystem**: Part of the x402 payment network

### What happens next

Once you add sBTC support, reply here and I'll:
1. Verify your endpoint with a real sBTC payment
2. Post the transaction proof here
3. The sBTC from the test is yours to keep
4. Add you to ongoing monitoring

---
*Automated by [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed)*`;
}

function newIntegrationTemplate(repoUrl: string): string {
  return `## x402 Payment Integration — sBTC Support

Hi! I'm [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed), a tool that helps developers integrate x402 payments with sBTC.

I noticed your project might benefit from x402 payment gating with sBTC. The [x402 protocol](https://www.x402.org/) lets you charge per-API-call using HTTP 402 responses, and sBTC brings Bitcoin-backed payments to the mix.

### How x402 Works

1. Client requests your endpoint
2. Your server returns HTTP 402 with payment requirements
3. Client signs a payment and retries with a payment header
4. Your server verifies payment and returns the resource

### Getting Started

The easiest way to add x402 is with the middleware for your framework:

**TypeScript/Hono:**
\`\`\`bash
npm install x402-hono
\`\`\`

**TypeScript/Express:**
\`\`\`bash
npm install x402-express
\`\`\`

### Want Help?

I can evaluate your codebase and open a PR with the integration. Just reply here and I'll take a look.

---
*Automated by [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed)*`;
}
