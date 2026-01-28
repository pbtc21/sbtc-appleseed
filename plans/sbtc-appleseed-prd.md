# PRD: sBTC Appleseed (v1 — Historical)

> **Note:** This is the original v1 PRD. See `appleseed-v2-prd.md` for the full adoption engine.

## Overview

Spec: `specs/sbtc-appleseed.md`

Two deliverables:
1. **GitHub issue template** — integration guide for adding sBTC acceptance to any x402 agent
2. **Verification script** — CLI tool that pays an agent's x402 endpoint with real sBTC, checks if the resource is delivered, and posts the result to a GitHub issue

Plus CRM updates on every action.

## Architecture

```
                          ┌─────────────────────┐
  bun run verify          │  Appleseed Wallet    │
  --endpoint <url>        │  (funded with sBTC)  │
  --issue <gh-issue-url>  └──────────┬───────────┘
                                     │
         ┌───────────────────────────┼────────────────────────────┐
         │                           │                            │
    Step 1: Probe              Step 2: Pay                  Step 3: Report
    GET endpoint               Sign sBTC tx                 gh issue comment
    → expect 402               → Payment-Signature header   → success/failure
    → parse accepts[]          → facilitator settles        → update CRM
    → find stacks:1/sBTC       → GET with payment proof
                               → expect 200 + resource
```

**Script runs locally via Bun CLI.** No Worker needed for v1 — this is an operator tool, not a public service.

### Protocol Handling

The script must handle **both** x402 protocol versions since agents in the wild use either:

| | v1 | v2 |
|---|---|---|
| **402 body** | Flat `X402PaymentRequired` object | `{ x402Version: 2, accepts: [...] }` |
| **Payment header** | `X-PAYMENT: <hex>` | `Payment-Signature: <base64 JSON>` |
| **Detection** | No `x402Version` field or `x402Version: 1` | `x402Version: 2` |

The script detects which version from the 402 response and uses the correct header format.

## Implementation Phases

### Phase 1: Project Setup + Issue Template

- [ ] **1.1** Init project: `~/dev/personal/sbtc-appleseed/`, `bun init`, `package.json`, `tsconfig.json`
- [ ] **1.2** Write the GitHub issue template as a markdown file (`templates/integration-guide.md`) with placeholders for agent-specific details: `{{AGENT_NAME}}`, `{{REPO}}`, `{{EXISTING_CHAIN}}`, `{{ENDPOINT_EXAMPLE}}`
- [ ] **1.3** Write a short variant for agents that already use x402 on another chain (`templates/crosschain-addon.md`) — shorter, assumes x402 familiarity
- [ ] **1.4** Write a variant for agents using OpenFacilitator (`templates/open-facilitator.md`) — just says "merge Stacks support PR, done"

### Phase 2: Verification Script — Probe + Parse

- [ ] **2.1** Create `src/types.ts` — interfaces for both v1 and v2 402 responses, verification results, config
- [ ] **2.2** Create `src/probe.ts` — `probeEndpoint(url): ProbeResult`
  - `GET url` with no payment headers
  - Detect v1 vs v2 from response body
  - Parse accepted payment methods
  - Find sBTC/stacks:1 option (or report "sBTC not accepted")
  - Return: `{ version, accepts, sbtcOption, raw402Body }`
- [ ] **2.3** Write probe tests against a mock 402 response (both v1 and v2 formats)

### Phase 3: Verification Script — Pay + Verify

- [ ] **3.1** Create `src/pay.ts` — `payEndpoint(url, sbtcOption, wallet): PayResult`
  - **v1 path**: Use `X402PaymentClient.signSBTCTransfer()` → build `X-PAYMENT` header → `GET url` with header
  - **v2 path**: Use `X402PaymentClient.signPayment()` → build `Payment-Signature` base64 payload → `GET url` with header
  - Check response: HTTP 200? Non-empty body?
  - Return: `{ success, statusCode, bodyLength, txId, error }`
- [ ] **3.2** Create `src/wallet.ts` — load Appleseed wallet from env var (`APPLESEED_PRIVATE_KEY`)
  - Uses `privateKeyToAccount()` from x402-stacks
  - Validate balance before attempting payment (via Hiro API)
  - Return wallet address + balance for logging
- [ ] **3.3** Create `src/config.ts` — env vars, defaults, max payment guard
  - `APPLESEED_PRIVATE_KEY` — required
  - `GITHUB_TOKEN` — for posting issue comments
  - `MAX_SBTC_PER_VERIFY` — safety cap (default: 50000 sats = 0.0005 BTC)
  - `STACKS_NETWORK` — mainnet/testnet (default: mainnet)
  - `FACILITATOR_URL` — default: `https://facilitator.stacksx402.com`

### Phase 4: Verification Script — Report to GitHub

- [ ] **4.1** Create `src/report.ts` — `postReport(issueUrl, result): void`
  - Parse `issueUrl` → extract `owner/repo` and issue number
  - Compose markdown comment (success or failure template)
  - Post via `gh api repos/{owner}/{repo}/issues/{number}/comments`
  - Include: endpoint tested, payment amount, tx ID with explorer link, HTTP status, resource delivered (yes/no + size)
- [ ] **4.2** Create success + failure comment templates in `src/templates.ts`

### Phase 5: CLI Wiring + CRM

- [ ] **5.1** Create `src/index.ts` — CLI entry point
  - Parse args: `--endpoint <url>` `--issue <github-issue-url>` `--max-sbtc <sats>`
  - Run: probe → pay → report
  - Pretty-print each step to stdout as it runs
  - Exit 0 on success, 1 on failure
- [ ] **5.2** Create `src/crm.ts` — update CRM after verification
  - Call x402 CRM API to update provider record
  - Set `verificationStatus`, `verificationTxId`, `sbtcSent`, `endpointUrl`, `issueUrl`
  - If CRM API isn't available or fails, log warning but don't block
- [ ] **5.3** Add `bun run verify` script to `package.json`
- [ ] **5.4** End-to-end test: run against one of the existing live x402 endpoints (e.g. `x402.pbtc21.dev`) to validate the full flow

## Files to Create

| File | Purpose |
|------|---------|
| `package.json` | Bun project config, scripts |
| `tsconfig.json` | TypeScript config |
| `.env.example` | Document required env vars |
| `templates/integration-guide.md` | Full issue template for new agents |
| `templates/crosschain-addon.md` | Short template for existing x402 agents |
| `templates/open-facilitator.md` | Template for OpenFacilitator users |
| `src/types.ts` | All interfaces |
| `src/config.ts` | Env loading, defaults, safety caps |
| `src/wallet.ts` | Appleseed wallet loader + balance check |
| `src/probe.ts` | 402 detection, v1/v2 parsing, sBTC option extraction |
| `src/pay.ts` | Sign + send sBTC, verify resource delivery |
| `src/report.ts` | Compose + post GitHub issue comment |
| `src/crm.ts` | Update CRM record |
| `src/templates.ts` | Success/failure comment markdown |
| `src/index.ts` | CLI entry point |

## Dependencies

| Package | Purpose |
|---------|---------|
| `x402-stacks` | sBTC signing, payment client, account utils |
| `@stacks/transactions` | Low-level Stacks tx building (peer dep of x402-stacks) |
| `@stacks/network` | Network config (peer dep) |
| `typescript` | Type checking |

No `octokit` needed — we use `gh api` via shell exec (simpler, already authenticated).

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| Agent's 402 format doesn't match v1 or v2 exactly | Probe step logs raw 402 body; report includes diagnostic detail so we can iterate |
| Facilitator rejects payment (tx format, insufficient funds) | Wallet balance check before payment; max payment cap prevents overspend |
| Agent endpoint is slow (Stacks settlement ~3s-10min) | Configurable timeout; script waits for facilitator response before retrying with proof |
| GitHub API rate limit | Using `gh` CLI which handles auth; rate limit unlikely for manual operation |
| Agent prices endpoint higher than expected | `--max-sbtc` flag caps spend; script aborts and reports if price exceeds cap |
| CRM API not available or schema mismatch | CRM update is best-effort; script succeeds regardless |
| v1 vs v2 detection is ambiguous | Check for `x402Version` field first; fall back to v1 if absent; log which version detected |

## Rollback Plan

This is a standalone CLI tool with no infrastructure. "Rollback" = stop running it. sBTC payments that already went through are final (by design — agents keep them). The Appleseed wallet private key is the only sensitive piece; keep it in `.env`, never commit it.

## Post-v1 Ideas (Not Building Now)

- **Watch mode**: Script monitors GitHub issue for "ready" comments, auto-triggers verification
- **Batch mode**: `bun run verify-all` reads a list of endpoints from CRM and runs them sequentially
- **Dashboard**: Cloudflare Worker showing all seeded agents and verification status
- **Auto-discovery**: Scan for new x402 endpoints and auto-file issues
