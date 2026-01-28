# PRD: sBTC Appleseed v2 (Completed)

> **Status:** All phases implemented. See [README](../README.md) for usage.

## Overview

**Spec:** `specs/appleseed-v2.md`

Appleseed v1 probes and pays a single x402 endpoint manually via CLI. v2 turns it into a full-service sBTC adoption engine: local endpoint registry, real sBTC payments, batch verification, scheduled monitoring, Telegram alerts, GitHub issue automation, and setup evaluation with PR generation.

## Architecture

```
CLI (index.ts)
  ├── discover [--language X]     (new: find sales targets)
  ├── verify --endpoint <url>     (existing, enhanced)
  ├── verify --all / --status X   (new: batch)
  ├── add <url> [--repo <gh>]     (new: register endpoint)
  ├── list [--status X]           (new: dashboard)
  ├── monitor                     (new: scheduler loop)
  ├── outreach <url>              (new: open GH issue)
  └── evaluate <repo>             (new: analyze + PR)

Storage (SQLite via bun:sqlite)
  └── endpoints table (pipeline state machine)

Notifications (Telegram Bot API)
  ├── Alerts on failure
  ├── Confirmations on verification
  └── Daily digest

Payment (extended pay.ts)
  ├── STX transfer (existing)
  ├── STX contract-call (existing)
  └── sBTC SIP-010 transfer (new)
```

## Implementation Phases

### Phase 1: Foundation — Local DB + sBTC Payments
Everything else builds on having a registry and real sBTC payments.

- [ ] **1.1** Create `src/db.ts` — SQLite database via `bun:sqlite`
  - Table: `endpoints` (id, url, repo_url, issue_url, pr_url, status, token_type, last_check, last_result, total_spent, notes, created_at, updated_at)
  - Status enum: `discovered | contacted | evaluating | pr_opened | awaiting_verification | verified | monitoring | broken`
  - Helper functions: `addEndpoint()`, `getEndpoint()`, `listEndpoints()`, `updateEndpoint()`, `getEndpointsByStatus()`
  - DB file: `~/.appleseed/endpoints.db` (outside project dir)

- [ ] **1.2** Add sBTC SIP-010 transfer to `src/pay.ts`
  - New function `paySbtcTransfer()` using `makeContractCall` to `SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::transfer`
  - Args: `(amount uint) (sender principal) (recipient principal) (memo (optional (buff 34)))`
  - Post-condition: sender sends exactly `amount` of sbtc-token
  - Route in `payV1`/`payV2` when `tokenType` is `sBTC` or asset matches sbtc identifiers
  - Reuse existing broadcast → poll → retry flow

- [ ] **1.3** Add fee management to `src/pay.ts`
  - New `estimateFee()` helper: query Hiro fee estimation, apply multiplier from config
  - Add `FEE_MULTIPLIER` env var (default: 1.5)
  - Pass explicit fee to `makeContractCall` / `makeSTXTokenTransfer`
  - Track fees spent per verification in DB

- [ ] **1.4** Add retry logic to `src/pay.ts`
  - Wrap broadcast in retry with exponential backoff (3 attempts, 5s/15s/45s)
  - Distinguish transient errors (timeout, nonce conflict) from permanent (insufficient funds, bad contract)
  - Log retry attempts

- [ ] **1.5** Update `src/config.ts`
  - Add: `FEE_MULTIPLIER`, `DB_PATH`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
  - Keep backward-compatible defaults

### Phase 2: Discovery — Find Sales Targets
Fill the pipeline with x402 endpoints to convert.

- [ ] **2.1** Create `src/discover.ts` — GitHub code search
  - Search GitHub for repos containing x402 patterns: `PaymentRequired`, `x402Version`, `Payment-Signature`, `402 payment`, `facilitator` + `accepts`
  - Filter by language (TypeScript, JavaScript, Python, Go, Rust)
  - Extract endpoint URLs from code, READMEs, and deploy configs
  - Deduplicate against existing DB entries
  - Uses `gh api search/code` and `gh api search/repositories`

- [ ] **2.2** GitHub topic + ecosystem search
  - Search repos tagged: `x402`, `http-402`, `pay-per-call`, `micropayments`
  - Search npm for packages depending on `x402-*` or `@anthropic/x402`
  - Check Cloudflare Workers directory for x402 workers
  - Scan facilitator logs if public (e.g. facilitator.stacksx402.com)

- [ ] **2.3** Probe discovered targets
  - For each discovered repo: extract likely endpoint URLs (from README, wrangler.toml, deploy configs)
  - Dry-run probe each URL to confirm it returns 402
  - Score targets: already has Stacks/sBTC (high priority), has x402 but no Stacks (medium), mentions x402 (low)

- [ ] **2.4** Add `discover` CLI command
  - `bun run appleseed discover [--language ts|js|python|go] [--limit 50]`
  - Searches, probes, scores, inserts into DB as `discovered`
  - Summary output: N found, N new, N already tracked
  - `bun run appleseed discover --dry-run` to preview without inserting

### Phase 3: CLI Commands — Registry + Batch + Dashboard
Wire the DB into the CLI so endpoints can be managed.

- [ ] **3.1** Add `add` command to `src/index.ts`
  - `bun run appleseed add <url> [--repo <github-url>] [--token sBTC|STX]`
  - Inserts into DB with status `discovered`
  - Dry-run probes the endpoint to validate it returns 402

- [ ] **3.2** Add `list` command
  - `bun run appleseed list [--status <status>]`
  - Table output: URL, status, last check, last result, total spent
  - Color-coded status (green=verified, red=broken, yellow=pending)

- [ ] **3.3** Extend `verify` for batch mode
  - `bun run appleseed verify --all` — runs against all endpoints in `awaiting_verification` or `monitoring` status
  - `bun run appleseed verify --status <status>` — runs against specific status
  - Sequential execution with summary at end
  - Updates DB after each verification (status, last_check, last_result, total_spent)

- [ ] **3.4** Refactor CLI entry point
  - Move from single `verify` command to sub-command routing: `add`, `list`, `verify`, `monitor`, `outreach`, `evaluate`
  - Update package.json scripts: `"appleseed": "bun run src/index.ts --"`
  - Keep `verify --endpoint` working for backward compat

### Phase 4: Telegram Bot
Alerts and status checks via Telegram.

- [ ] **4.1** Create Telegram bot via BotFather
  - Create bot, get token
  - Set up commands: `/status`, `/list`, `/check <url>`
  - Store token in `.env`

- [ ] **4.2** Create `src/telegram.ts`
  - `sendMessage(text)` — POST to `api.telegram.org/bot<token>/sendMessage`
  - `sendAlert(endpoint, error)` — formatted failure message with endpoint URL and error
  - `sendVerified(endpoint, txId)` — formatted success with explorer link
  - `sendDigest(endpoints[])` — daily summary table

- [ ] **4.3** Wire alerts into existing flows
  - After verify failure: `sendAlert()`
  - After verify success (first time): `sendVerified()`
  - Status transition `verified → broken`: alert
  - Status transition `broken → verified`: recovery alert

- [ ] **4.4** Create `src/bot.ts` — Telegram bot polling loop
  - `getUpdates()` long-polling
  - Handle `/status` — show endpoint counts by status + wallet balance
  - Handle `/list` — show all endpoints with status emoji
  - Handle `/check <url>` — trigger immediate verification
  - Run via `bun run bot`

### Phase 5: Scheduled Monitoring
Unattended operation.

- [ ] **5.1** Create `src/monitor.ts`
  - `runMonitorCycle()` — check all endpoints that are due
  - `verified`/`monitoring` endpoints: check if >6h since last_check
  - `broken` endpoints: check if >1h since last_check
  - Run verifications, update DB, send Telegram alerts on state change

- [ ] **5.2** Add `monitor` CLI command
  - `bun run appleseed monitor` — single cycle (for cron)
  - `bun run appleseed monitor --daemon` — continuous loop with sleep between cycles
  - Generate crontab entry suggestion on first run

- [ ] **5.3** Daily digest
  - At end of monitor cycle (or at configured hour), send Telegram digest
  - Counts: total, verified, broken, pending
  - List any newly broken endpoints
  - Wallet balance + total spent

### Phase 6: GitHub Automation + Setup Evaluation
The outreach and PR generation engine.

- [ ] **6.1** Create `src/outreach.ts`
  - `openOutreachIssue(repoUrl, endpointUrl)` — opens issue using template from `templates/`
  - Picks template based on endpoint probe results (crosschain-addon if already x402, integration-guide if not)
  - Updates DB: status → `contacted`, stores issue URL

- [ ] **6.2** Add `outreach` CLI command
  - `bun run appleseed outreach <endpoint-url> --repo <github-url>`
  - Probes endpoint first, picks right template
  - Opens issue, records in DB

- [ ] **6.3** Create `src/evaluate.ts`
  - `evaluateRepo(repoUrl)` — clones repo, scans for x402 middleware
  - Identifies framework (Express, Hono, Cloudflare Worker, etc.)
  - Checks if sBTC is already in `accepts[]`
  - Returns evaluation report: what exists, what's missing, difficulty estimate

- [ ] **6.4** Create `src/pr-generator.ts`
  - `generateSbtcPR(repoUrl, evaluation)` — forks, branches, applies changes, opens PR
  - Template-based: inject sBTC into existing accepts array, add Stacks network routing
  - Uses `gh` CLI for fork/branch/PR creation
  - Updates DB: status → `pr_opened`, stores PR URL

- [ ] **6.5** Add `evaluate` CLI command
  - `bun run appleseed evaluate <repo-url>`
  - Prints evaluation report
  - Prompts (or `--auto`) to generate PR

## Files to Create/Modify

| File | Action | Purpose |
|------|--------|---------|
| `src/db.ts` | Create | SQLite endpoint registry |
| `src/discover.ts` | Create | GitHub search for x402 sales targets |
| `src/telegram.ts` | Create | Telegram Bot API client |
| `src/bot.ts` | Create | Telegram bot polling loop |
| `src/monitor.ts` | Create | Scheduled monitoring logic |
| `src/outreach.ts` | Create | GitHub issue automation |
| `src/evaluate.ts` | Create | Repo analysis + evaluation |
| `src/pr-generator.ts` | Create | Fork/branch/PR generation |
| `src/index.ts` | Modify | Sub-command routing, batch verify |
| `src/pay.ts` | Modify | sBTC transfer, fee mgmt, retry |
| `src/config.ts` | Modify | New env vars |
| `src/types.ts` | Modify | New interfaces (Endpoint, EvalReport) |
| `src/crm.ts` | Modify | Sync with local DB |
| `src/wallet.ts` | Modify | Budget tracking helpers |
| `package.json` | Modify | New scripts, bun:sqlite |

## Dependencies

| Package | Purpose | Status |
|---------|---------|--------|
| `bun:sqlite` | Local endpoint registry | Built into Bun |
| `@stacks/transactions` | sBTC SIP-010 calls | Already installed (via x402-stacks) |
| `@stacks/network` | Network config | Already installed |
| `x402-stacks` | STX signing | Already installed |

No new npm dependencies needed. Telegram Bot API and GitHub API are plain HTTP.

## Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| sBTC transfer fails due to wrong contract args | Test with small amount first; post-conditions prevent overspend |
| Wallet runs out of sBTC | Budget tracking + Telegram alert when balance < 10k sats |
| Endpoint flaps (up/down rapidly) | Require 2 consecutive failures before marking `broken`; cooldown on alerts |
| PR generation breaks target repo | Always fork first; never push to their main; PR is just a suggestion |
| Rate limiting on Hiro API | Add backoff; cache nonce locally; spread batch checks over time |
| Telegram bot token leaked | Store in .env only; never log; .gitignore |
| GitHub search rate limits (30 req/min for code search) | Throttle discover queries; cache results in DB; run discovery infrequently |

## Rollback Plan

- Each phase is independently deployable
- v1 CLI (`verify --endpoint`) keeps working at every phase
- DB is additive — existing manual workflow always works without it
- Telegram is optional — alerts fail silently if unconfigured
- Git branches per phase for easy revert
