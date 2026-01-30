import type { Config } from "./config";
import { updateEndpoint, getEndpoint } from "./db";
import { randomUUID } from "crypto";

export interface McpVerifyResult {
  repoUrl: string;
  hasMcp: boolean;
  mcpPackage: string | null;
  files: string[];
  eligible: boolean;
}

export interface EvalReport {
  repoUrl: string;
  repoName: string;
  framework: string | null;
  language: string;
  hasX402: boolean;
  hasSbtc: boolean;
  hasMcp: boolean;
  x402Package: string | null;
  mcpPackage: string | null;
  paymentConfig: string | null;
  difficulty: "easy" | "medium" | "hard";
  recommendation: string;
  files: EvalFile[];
}

interface EvalFile {
  path: string;
  relevance: string;
}

/**
 * Evaluate a GitHub repo for x402/sBTC integration readiness.
 * Clones repo, scans for patterns, returns evaluation report.
 */
export async function evaluateRepo(
  repoUrl: string,
  config: Config
): Promise<EvalReport> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const repoName = `${owner}/${repo}`;
  // Use randomUUID to prevent temp directory race condition (TOCTOU)
  const tmpDir = `/tmp/appleseed-eval-${randomUUID()}`;

  console.log(`  [evaluate] Cloning ${repoName}...`);

  try {
    // Shallow clone
    const clone = Bun.spawn(
      ["gh", "repo", "clone", repoName, tmpDir, "--", "--depth=1"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await clone.exited;

    // Scan for patterns
    const language = await detectLanguage(tmpDir);
    const framework = await detectFramework(tmpDir, language);
    const x402Info = await detectX402(tmpDir);
    const sbtcInfo = await detectSbtc(tmpDir);
    const mcpInfo = await detectMcp(tmpDir);

    const difficulty = getDifficulty(framework, x402Info.hasX402, sbtcInfo.hasSbtc);
    const recommendation = getRecommendation(framework, x402Info, sbtcInfo, mcpInfo);

    const report: EvalReport = {
      repoUrl,
      repoName,
      framework,
      language,
      hasX402: x402Info.hasX402,
      hasSbtc: sbtcInfo.hasSbtc,
      hasMcp: mcpInfo.hasMcp,
      x402Package: x402Info.package,
      mcpPackage: mcpInfo.package,
      paymentConfig: x402Info.configFile,
      difficulty,
      recommendation,
      files: [...x402Info.files, ...sbtcInfo.files, ...mcpInfo.files],
    };

    // Update DB
    const ep = getEndpoint(config.dbPath, repoUrl);
    if (ep) {
      updateEndpoint(config.dbPath, ep.url, {
        status: "evaluating",
        notes: JSON.stringify({
          framework,
          hasX402: x402Info.hasX402,
          hasSbtc: sbtcInfo.hasSbtc,
          difficulty,
        }),
      });
    }

    // Cleanup
    Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });

    return report;
  } catch (err) {
    // Cleanup on error
    Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });
    throw err;
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

async function detectLanguage(dir: string): Promise<string> {
  const checks: [string, string][] = [
    ["package.json", "typescript"],
    ["tsconfig.json", "typescript"],
    ["requirements.txt", "python"],
    ["Pipfile", "python"],
    ["go.mod", "go"],
    ["Cargo.toml", "rust"],
  ];

  for (const [file, lang] of checks) {
    const proc = Bun.spawn(["test", "-f", `${dir}/${file}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await proc.exited) === 0) {
      // Check if it's TypeScript specifically
      if (lang === "typescript") {
        const tsCheck = Bun.spawn(["test", "-f", `${dir}/tsconfig.json`], {
          stdout: "pipe",
          stderr: "pipe",
        });
        return (await tsCheck.exited) === 0 ? "typescript" : "javascript";
      }
      return lang;
    }
  }
  return "unknown";
}

async function detectFramework(
  dir: string,
  language: string
): Promise<string | null> {
  if (language === "typescript" || language === "javascript") {
    const pkgProc = Bun.spawn(["cat", `${dir}/package.json`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const pkgText = await new Response(pkgProc.stdout).text();
    try {
      const pkg = JSON.parse(pkgText);
      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      if (deps["hono"]) return "hono";
      if (deps["express"]) return "express";
      if (deps["next"]) return "next";
      if (deps["fastify"]) return "fastify";
      if (deps["@cloudflare/workers-types"] || deps["wrangler"]) return "cloudflare-worker";
    } catch {
      // Not valid JSON
    }

    // Check wrangler.toml
    const wrProc = Bun.spawn(["test", "-f", `${dir}/wrangler.toml`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if ((await wrProc.exited) === 0) return "cloudflare-worker";
  }

  if (language === "python") {
    const reqProc = Bun.spawn(["cat", `${dir}/requirements.txt`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const reqs = await new Response(reqProc.stdout).text();
    if (reqs.includes("flask")) return "flask";
    if (reqs.includes("fastapi")) return "fastapi";
    if (reqs.includes("django")) return "django";
  }

  if (language === "go") return "go-http";

  return null;
}

async function detectX402(dir: string): Promise<{
  hasX402: boolean;
  package: string | null;
  configFile: string | null;
  files: EvalFile[];
}> {
  const files: EvalFile[] = [];
  let hasX402 = false;
  let pkg: string | null = null;
  let configFile: string | null = null;

  // Search for x402 patterns
  const patterns = [
    "x402Version",
    "PaymentRequired",
    "Payment-Signature",
    "X-PAYMENT",
    "x402-",
    "402 payment",
    "facilitator",
  ];

  for (const pattern of patterns) {
    const proc = Bun.spawn(
      ["grep", "-rl", "--include=*.ts", "--include=*.js", "--include=*.py", "--include=*.go", pattern, dir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const matches = stdout.trim().split("\n").filter(Boolean);

    for (const file of matches) {
      hasX402 = true;
      const relPath = file.replace(`${dir}/`, "");
      if (!files.find((f) => f.path === relPath)) {
        files.push({ path: relPath, relevance: `Contains "${pattern}"` });
      }
    }
  }

  // Check for x402 packages
  const pkgProc = Bun.spawn(["cat", `${dir}/package.json`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const pkgText = await new Response(pkgProc.stdout).text();
  try {
    const pkgJson = JSON.parse(pkgText);
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    const x402Pkgs = Object.keys(deps).filter(
      (d) => d.includes("x402") || d.includes("402")
    );
    if (x402Pkgs.length > 0) {
      hasX402 = true;
      pkg = x402Pkgs[0];
    }
  } catch {
    // No package.json or not JSON
  }

  // Look for payment config files
  const configNames = ["payment.config", "x402.config", "402.config"];
  for (const name of configNames) {
    const proc = Bun.spawn(
      ["find", dir, "-name", `${name}*`, "-type", "f"],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    if (stdout.trim()) {
      configFile = stdout.trim().split("\n")[0].replace(`${dir}/`, "");
      break;
    }
  }

  return { hasX402, package: pkg, configFile, files };
}

async function detectSbtc(dir: string): Promise<{
  hasSbtc: boolean;
  files: EvalFile[];
}> {
  const files: EvalFile[] = [];
  let hasSbtc = false;

  const patterns = [
    "sbtc",
    "sBTC",
    "stacks-mainnet",
    "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR",
    "token-sbtc",
  ];

  for (const pattern of patterns) {
    const proc = Bun.spawn(
      ["grep", "-rl", "--include=*.ts", "--include=*.js", "--include=*.py", "--include=*.go", pattern, dir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const matches = stdout.trim().split("\n").filter(Boolean);

    for (const file of matches) {
      hasSbtc = true;
      const relPath = file.replace(`${dir}/`, "");
      if (!files.find((f) => f.path === relPath)) {
        files.push({ path: relPath, relevance: `Contains "${pattern}"` });
      }
    }
  }

  return { hasSbtc, files };
}

async function detectMcp(dir: string): Promise<{
  hasMcp: boolean;
  package: string | null;
  files: EvalFile[];
}> {
  const files: EvalFile[] = [];
  let hasMcp = false;
  let pkg: string | null = null;

  // Check for .mcp.json config file
  const mcpConfigProc = Bun.spawn(
    ["find", dir, "-name", ".mcp.json", "-o", "-name", "mcp.json"],
    { stdout: "pipe", stderr: "pipe" }
  );
  const mcpConfigOut = await new Response(mcpConfigProc.stdout).text();
  if (mcpConfigOut.trim()) {
    hasMcp = true;
    for (const f of mcpConfigOut.trim().split("\n").filter(Boolean)) {
      files.push({ path: f.replace(`${dir}/`, ""), relevance: "MCP config file" });
    }
  }

  // Check for MCP patterns in code
  const patterns = [
    "@aibtc/mcp-server",
    "mcp-server",
    "mcpServers",
    "stacks-mcp",
  ];

  for (const pattern of patterns) {
    const proc = Bun.spawn(
      ["grep", "-rl", "--include=*.ts", "--include=*.js", "--include=*.json", "--include=*.md", pattern, dir],
      { stdout: "pipe", stderr: "pipe" }
    );
    const stdout = await new Response(proc.stdout).text();
    const matches = stdout.trim().split("\n").filter(Boolean);

    for (const file of matches) {
      hasMcp = true;
      const relPath = file.replace(`${dir}/`, "");
      if (!files.find((f) => f.path === relPath)) {
        files.push({ path: relPath, relevance: `Contains "${pattern}"` });
      }
      if (pattern === "@aibtc/mcp-server") {
        pkg = "@aibtc/mcp-server";
      }
    }
  }

  // Check package.json for MCP packages
  const pkgProc = Bun.spawn(["cat", `${dir}/package.json`], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const pkgText = await new Response(pkgProc.stdout).text();
  try {
    const pkgJson = JSON.parse(pkgText);
    const deps = { ...pkgJson.dependencies, ...pkgJson.devDependencies };
    const mcpPkgs = Object.keys(deps).filter(
      (d) => d.includes("mcp") || d.includes("@aibtc")
    );
    if (mcpPkgs.length > 0) {
      hasMcp = true;
      pkg = mcpPkgs.find(p => p.includes("@aibtc")) || mcpPkgs[0];
    }
  } catch {
    // No package.json or not JSON
  }

  return { hasMcp, package: pkg, files };
}

function getDifficulty(
  framework: string | null,
  hasX402: boolean,
  hasSbtc: boolean
): "easy" | "medium" | "hard" {
  if (hasSbtc) return "easy"; // Already has sBTC, just verify
  if (hasX402) return "easy"; // Has x402, just add sBTC to accepts
  if (framework && ["hono", "express", "cloudflare-worker"].includes(framework)) {
    return "medium"; // Known framework, can add x402 middleware
  }
  return "hard"; // Unknown setup
}

function getRecommendation(
  framework: string | null,
  x402Info: { hasX402: boolean; package: string | null },
  sbtcInfo: { hasSbtc: boolean },
  mcpInfo: { hasMcp: boolean; package: string | null }
): string {
  const parts: string[] = [];

  // MCP status
  if (mcpInfo.hasMcp) {
    parts.push(`Has Stacks MCP${mcpInfo.package ? ` (${mcpInfo.package})` : ""} - eligible for airdrop.`);
  } else {
    parts.push("No Stacks MCP found. Add @aibtc/mcp-server for agent verification.");
  }

  // sBTC/x402 status
  if (sbtcInfo.hasSbtc) {
    parts.push("Already has sBTC support.");
  } else if (x402Info.hasX402) {
    parts.push(`Has x402 via ${x402Info.package || "custom"}. Add sBTC to accepts.`);
  } else if (framework) {
    const middleware: Record<string, string> = {
      hono: "x402-hono",
      express: "x402-express",
      "cloudflare-worker": "x402-hono (Hono on Workers)",
      next: "x402-next",
      fastify: "x402-express (compatible adapter)",
    };
    const pkg = middleware[framework] || "x402 middleware";
    parts.push(`No x402 found. Add ${pkg} with sBTC config.`);
  } else {
    parts.push("No x402/sBTC found. Manual integration needed.");
  }

  return parts.join(" ");
}

/**
 * Print evaluation report to console.
 */
export function printReport(report: EvalReport): void {
  console.log(`\n  --- Evaluation Report ---`);
  console.log(`  Repo: ${report.repoName}`);
  console.log(`  Language: ${report.language}`);
  console.log(`  Framework: ${report.framework || "unknown"}`);
  console.log(`  Has MCP: ${report.hasMcp ? "yes" : "no"}${report.mcpPackage ? ` (${report.mcpPackage})` : ""}`);
  console.log(`  Has x402: ${report.hasX402 ? "yes" : "no"}${report.x402Package ? ` (${report.x402Package})` : ""}`);
  console.log(`  Has sBTC: ${report.hasSbtc ? "yes" : "no"}`);
  console.log(`  Difficulty: ${report.difficulty}`);
  console.log(`  Recommendation: ${report.recommendation}`);

  if (report.files.length > 0) {
    console.log(`\n  Relevant files:`);
    for (const f of report.files.slice(0, 10)) {
      console.log(`    ${f.path} — ${f.relevance}`);
    }
  }
  console.log("");
}

/**
 * Quick MCP verification for a GitHub repo.
 * Used by aibtc-agent to verify agents have Stacks MCP setup.
 */
export async function verifyMcp(repoUrl: string): Promise<McpVerifyResult> {
  const { owner, repo } = parseRepoUrl(repoUrl);
  const repoName = `${owner}/${repo}`;
  const tmpDir = `/tmp/appleseed-mcp-${randomUUID()}`;

  try {
    // Shallow clone
    const clone = Bun.spawn(
      ["gh", "repo", "clone", repoName, tmpDir, "--", "--depth=1"],
      { stdout: "pipe", stderr: "pipe" }
    );
    await clone.exited;

    const mcpInfo = await detectMcp(tmpDir);

    // Cleanup
    Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });

    return {
      repoUrl,
      hasMcp: mcpInfo.hasMcp,
      mcpPackage: mcpInfo.package,
      files: mcpInfo.files.map(f => f.path),
      eligible: mcpInfo.hasMcp,
    };
  } catch (err) {
    Bun.spawn(["rm", "-rf", tmpDir], { stdout: "pipe", stderr: "pipe" });
    return {
      repoUrl,
      hasMcp: false,
      mcpPackage: null,
      files: [],
      eligible: false,
    };
  }
}
