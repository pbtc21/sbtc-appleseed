import type { Config } from "./config";
import type { EvalReport } from "./evaluate";
import { updateEndpoint, getEndpoint } from "./db";
import { randomUUID } from "crypto";

/**
 * Fork a repo, create a branch with sBTC integration changes, and open a PR.
 */
export async function generateSbtcPR(
  report: EvalReport,
  config: Config
): Promise<string | null> {
  const { owner, repo } = parseRepoUrl(report.repoUrl);
  const repoName = `${owner}/${repo}`;
  const branchName = "feat/add-sbtc-x402";
  // Use randomUUID to prevent temp directory race condition (TOCTOU)
  const tmpDir = `/tmp/appleseed-pr-${randomUUID()}`;

  console.log(`  [pr-gen] Forking ${repoName}...`);

  try {
    // Fork the repo
    const fork = Bun.spawn(
      ["gh", "repo", "fork", repoName, "--clone=false"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const forkStdout = await new Response(fork.stdout).text();
    await fork.exited;

    // Get our fork name
    const whoami = Bun.spawn(["gh", "api", "user", "-q", ".login"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const myUser = (await new Response(whoami.stdout).text()).trim();
    await whoami.exited;
    const forkName = `${myUser}/${repo}`;

    console.log(`  [pr-gen] Cloning fork ${forkName}...`);

    // Clone the fork
    const clone = Bun.spawn(
      ["gh", "repo", "clone", forkName, tmpDir],
      { stdout: "pipe", stderr: "pipe" }
    );
    await clone.exited;

    // Create branch
    const branch = Bun.spawn(
      ["git", "-C", tmpDir, "checkout", "-b", branchName],
      { stdout: "pipe", stderr: "pipe" }
    );
    await branch.exited;

    // Apply changes based on framework
    const changed = await applyChanges(tmpDir, report);

    if (!changed) {
      console.log("  [pr-gen] No changes to apply — skipping PR");
      Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });
      return null;
    }

    // Commit
    const add = Bun.spawn(["git", "-C", tmpDir, "add", "-A"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    await add.exited;

    const commit = Bun.spawn(
      ["git", "-C", tmpDir, "commit", "-m", "feat: add sBTC payment support via x402"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await commit.exited;

    // Push
    console.log(`  [pr-gen] Pushing to ${forkName}...`);
    const push = Bun.spawn(
      ["git", "-C", tmpDir, "push", "-u", "origin", branchName],
      { stdout: "pipe", stderr: "pipe" }
    );
    const pushExit = await push.exited;
    if (pushExit !== 0) {
      const stderr = await new Response(push.stderr).text();
      console.error(`  [pr-gen] Push failed: ${stderr.trim()}`);
      Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });
      return null;
    }

    // Create PR
    console.log(`  [pr-gen] Opening PR...`);
    const prBody = generatePRBody(report);

    const pr = Bun.spawn(
      [
        "gh", "pr", "create",
        "--repo", repoName,
        "--head", `${myUser}:${branchName}`,
        "--title", "feat: add sBTC payment support via x402",
        "--body", prBody,
      ],
      { stdout: "pipe", stderr: "pipe" }
    );
    const prStdout = await new Response(pr.stdout).text();
    const prExit = await pr.exited;

    if (prExit !== 0) {
      const stderr = await new Response(pr.stderr).text();
      console.error(`  [pr-gen] PR creation failed: ${stderr.trim()}`);
      Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });
      return null;
    }

    const prUrl = prStdout.trim();
    console.log(`  [pr-gen] PR created: ${prUrl}`);

    // Update DB
    const ep = getEndpoint(config.dbPath, report.repoUrl);
    if (ep) {
      updateEndpoint(config.dbPath, ep.url, {
        status: "pr_opened",
        pr_url: prUrl,
      });
    }

    // Cleanup
    Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });

    return prUrl;
  } catch (err) {
    Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });
    console.error(`  [pr-gen] Failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

function parseRepoUrl(url: string): { owner: string; repo: string } {
  const match = url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) throw new Error(`Invalid GitHub repo URL: ${url}`);

  const owner = match[1].replace(/\.git$/, "");
  const repo = match[2].replace(/\.git$/, "");

  // Security: validate owner/repo contain only safe characters
  const safePattern = /^[a-zA-Z0-9_.-]+$/;
  if (!safePattern.test(owner) || !safePattern.test(repo)) {
    throw new Error(`Invalid characters in repo URL: ${url}`);
  }

  return { owner, repo };
}

/**
 * Apply sBTC integration changes to the cloned repo.
 * Returns true if any changes were made.
 */
async function applyChanges(dir: string, report: EvalReport): Promise<boolean> {
  if (report.hasSbtc) {
    console.log("  [pr-gen] Already has sBTC — no changes needed");
    return false;
  }

  if (report.hasX402) {
    return await addSbtcToExistingX402(dir, report);
  }

  return await addX402WithSbtc(dir, report);
}

/**
 * For repos that already have x402 but not sBTC:
 * Find the payment config and add sBTC to accepts.
 */
async function addSbtcToExistingX402(
  dir: string,
  report: EvalReport
): Promise<boolean> {
  // Find files with accepts arrays
  const proc = Bun.spawn(
    ["grep", "-rl", "--include=*.ts", "--include=*.js", "accepts", dir],
    { stdout: "pipe", stderr: "pipe" }
  );
  const stdout = await new Response(proc.stdout).text();
  const files = stdout.trim().split("\n").filter(Boolean);

  if (files.length === 0) {
    console.log("  [pr-gen] Could not find accepts config — creating integration guide");
    return await writeIntegrationGuide(dir, report);
  }

  // For each file with 'accepts', try to add sBTC entry
  for (const file of files) {
    const readProc = Bun.spawn(["cat", file], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const content = await new Response(readProc.stdout).text();

    // Check if it already has the accepts pattern and inject sBTC
    if (content.includes("accepts") && !content.includes("sbtc") && !content.includes("sBTC")) {
      // Write integration guide instead of modifying arbitrary code
      return await writeIntegrationGuide(dir, report);
    }
  }

  return await writeIntegrationGuide(dir, report);
}

/**
 * For repos without x402: add a complete integration guide file.
 */
async function addX402WithSbtc(
  dir: string,
  report: EvalReport
): Promise<boolean> {
  return await writeIntegrationGuide(dir, report);
}

/**
 * Write an SBTC_INTEGRATION.md file with framework-specific instructions.
 */
async function writeIntegrationGuide(
  dir: string,
  report: EvalReport
): Promise<boolean> {
  const guide = generateGuide(report);
  const guidePath = `${dir}/SBTC_INTEGRATION.md`;

  await Bun.write(guidePath, guide);
  console.log("  [pr-gen] Created SBTC_INTEGRATION.md");

  // If TypeScript and we know the framework, also add a sample config
  if (
    (report.language === "typescript" || report.language === "javascript") &&
    report.framework
  ) {
    const sample = generateSampleConfig(report);
    if (sample) {
      const samplePath = `${dir}/x402-sbtc-config.example.ts`;
      await Bun.write(samplePath, sample);
      console.log("  [pr-gen] Created x402-sbtc-config.example.ts");
    }
  }

  return true;
}

function generateGuide(report: EvalReport): string {
  const frameworkInstructions = getFrameworkInstructions(report);

  return `# sBTC x402 Integration Guide

This guide shows how to add sBTC payment support to this project using the [x402 protocol](https://www.x402.org/).

## Overview

x402 enables HTTP-native payments where clients pay per API call. Adding sBTC support lets your users pay with Bitcoin-backed tokens on the Stacks network.

## Quick Start

${frameworkInstructions}

## sBTC Payment Configuration

Add this to your x402 payment accepts array:

\`\`\`typescript
{
  scheme: "exact",
  network: "stacks-mainnet",
  asset: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR.token-sbtc::sbtc",
  amount: "1000", // price in sats (1 sat = 0.00000001 BTC)
  payTo: "YOUR_STACKS_ADDRESS", // your Stacks address to receive payments
  maxTimeoutSeconds: 300,
  extra: {
    facilitator: "https://facilitator.stacksx402.com",
    tokenType: "sBTC"
  }
}
\`\`\`

## What is sBTC?

- **1:1 Bitcoin peg** — each sBTC is backed by real BTC
- **Stacks network** — fast (~30s blocks), programmable, Bitcoin-secured
- **SIP-010 token** — standard fungible token on Stacks

## Verification

Once integrated, [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed) will verify your endpoint with a real sBTC payment and post the results. The test sBTC is yours to keep.

## Resources

- [x402 Protocol Spec](https://www.x402.org/)
- [x402 Stacks SDK](https://www.npmjs.com/package/x402-stacks)
- [sBTC Documentation](https://docs.stacks.co/stacks-101/sbtc)

---
*Generated by [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed)*
`;
}

function getFrameworkInstructions(report: EvalReport): string {
  switch (report.framework) {
    case "hono":
      return `### Hono

\`\`\`bash
npm install x402-hono
\`\`\`

\`\`\`typescript
import { paymentMiddleware } from "x402-hono";

app.use("/api/*", paymentMiddleware({
  accepts: [/* sBTC config above */],
}));
\`\`\``;

    case "express":
      return `### Express

\`\`\`bash
npm install x402-express
\`\`\`

\`\`\`typescript
import { paymentMiddleware } from "x402-express";

app.use("/api/*", paymentMiddleware({
  accepts: [/* sBTC config above */],
}));
\`\`\``;

    case "cloudflare-worker":
      return `### Cloudflare Worker (Hono)

\`\`\`bash
npm install x402-hono
\`\`\`

\`\`\`typescript
import { paymentMiddleware } from "x402-hono";

app.use("/api/*", paymentMiddleware({
  accepts: [/* sBTC config above */],
}));
\`\`\``;

    default:
      return `### General

Install the x402 middleware for your framework:

\`\`\`bash
# TypeScript/JavaScript
npm install x402-express  # or x402-hono

# Python
pip install x402-python
\`\`\`

Then add the payment middleware to your API routes with the sBTC configuration below.`;
  }
}

function generateSampleConfig(report: EvalReport): string | null {
  if (!report.framework) return null;

  return `// x402 sBTC Payment Configuration
// Copy the relevant parts into your existing payment setup

export const sbtcPaymentConfig = {
  scheme: "exact",
  network: "stacks-mainnet",
  asset: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR.token-sbtc::sbtc",
  amount: "1000", // price in sats
  payTo: "YOUR_STACKS_ADDRESS", // replace with your Stacks address
  maxTimeoutSeconds: 300,
  extra: {
    facilitator: "https://facilitator.stacksx402.com",
    tokenType: "sBTC",
  },
};

// Example: Add to existing x402 accepts array
// accepts: [
//   existingConfig,
//   sbtcPaymentConfig,
// ]
`;
}

function generatePRBody(report: EvalReport): string {
  return `## Add sBTC Payment Support via x402

This PR adds sBTC payment configuration for the x402 protocol, enabling Bitcoin-backed micropayments for your API.

### What's included

- \`SBTC_INTEGRATION.md\` — Step-by-step integration guide${report.framework ? `\n- \`x402-sbtc-config.example.ts\` — Sample payment configuration` : ""}

### About sBTC

sBTC is a 1:1 Bitcoin-pegged token on the Stacks network. Adding it to your x402 payment config lets users pay with Bitcoin-backed value.

### Evaluation

| Property | Value |
|----------|-------|
| Framework | ${report.framework || "unknown"} |
| Has x402 | ${report.hasX402 ? "yes" : "no"} |
| Difficulty | ${report.difficulty} |

### Next Steps

1. Review the integration guide
2. Add your Stacks address to the payment config
3. Deploy and reply to the Appleseed issue — we'll verify with a real sBTC payment

---
*Generated by [sBTC Appleseed](https://github.com/pbtc21/sbtc-appleseed)*`;
}
