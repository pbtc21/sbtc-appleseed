# Spec: sBTC Appleseed v2

## Problem

sBTC adoption on x402 is bottlenecked by developer effort. Devs have x402 endpoints that accept EVM payments but not sBTC. Nobody is going to each of them, showing them how, doing the work, verifying it, and keeping it healthy. Appleseed v1 can probe and pay a single endpoint manually. That doesn't scale.

## Solution

Appleseed v2 becomes a full-service sBTC adoption engine. It discovers x402 endpoints, opens GitHub issues with integration guides, evaluates the dev's setup, does the integration work (opens PRs), verifies with real sBTC payments, monitors continuously, and alerts via Telegram when anything breaks. One tool that takes an endpoint from "never heard of sBTC" to "verified and monitored."

## Core Features

### 1. Real sBTC Payments
Currently pays STX only. Add actual sBTC token transfer path using the sBTC SIP-010 contract so verification proves real sBTC flow works end-to-end.

### 2. Endpoint Registry & CRM
A local DB (SQLite via Bun) tracking every endpoint through the pipeline:
- `discovered` → `contacted` → `evaluating` → `pr_opened` → `awaiting_verification` → `verified` → `monitoring` → `broken`
- Stores: endpoint URL, repo, contact issue, PR link, last check, last status, payment history

### 3. Batch Verification
Run against all registered endpoints in one command:
```bash
bun run verify --all
bun run verify --status awaiting_verification
```

### 4. Scheduled Monitoring
Cron-style recurring checks (via system cron or built-in scheduler):
- Verified endpoints: check every 6 hours
- Recently broken: check every hour
- Configurable per-endpoint

### 5. Telegram Bot Alerts
A Telegram bot that:
- Sends alert when a monitored endpoint goes down
- Sends confirmation when a new endpoint passes verification
- Daily digest of endpoint health
- Responds to `/status` command for on-demand check

### 6. Setup Evaluation & PR Generation
Given a repo URL, Appleseed:
- Clones the repo
- Identifies the x402 middleware/handler
- Evaluates what's needed to add sBTC support
- Generates a PR with the integration code
- Posts the PR link in the GitHub issue

### 7. GitHub Issue Automation
- Open outreach issues on repos with x402 endpoints (using existing templates)
- Track issue state (opened, responded, PR merged, verified)
- Post verification results as comments

### 8. Fee Management
- Configurable priority fee multiplier for slow blocks
- Track fee spending per endpoint
- Budget alerts when wallet runs low

### 9. Retry Logic
- Automatic retry on transient failures (network timeout, mempool congestion)
- Exponential backoff
- Distinguish between "endpoint broken" vs "network hiccup"

### 10. Dashboard (CLI)
Rich terminal output showing:
- All endpoints and their pipeline status
- Recent verification results
- Wallet balance and spend history
- Next scheduled checks

## Out of Scope (v2)

- Web UI dashboard (CLI-only for now)
- Multi-chain support beyond Stacks
- Automated endpoint discovery (manual addition for now, auto-discovery is v3)
- Payment to devs/bounties
- Multi-wallet support

## Success Criteria

1. Can register 10+ endpoints and verify them all in one command
2. Real sBTC payment succeeds end-to-end on at least 3 endpoints
3. Telegram alerts fire within 5 minutes of an endpoint breaking
4. Monitoring runs unattended for 7 days without intervention
5. At least one PR auto-generated and merged by a dev

## Technical Notes

- **Runtime**: Bun (already in use)
- **Database**: SQLite via `bun:sqlite` for endpoint registry
- **Telegram**: Bot API via HTTP (no framework needed, it's just REST calls)
- **Scheduler**: System cron calling `bun run monitor` or built-in `setInterval`
- **sBTC contract**: `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token` (SIP-010 transfer)
- **PR generation**: `gh` CLI for fork/branch/PR, template-based code changes
- **Fee estimation**: Query Hiro fee estimation API, apply configurable multiplier
- **Existing code**: Extend current probe/pay/report/crm modules rather than rewrite
