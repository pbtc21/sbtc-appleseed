# sBTC Appleseed

An sBTC adoption engine that finds x402 payment endpoints, helps them integrate sBTC, verifies they work with real payments, and monitors them over time.

## What It Does

Appleseed automates the entire lifecycle of sBTC adoption outreach:

```
discover → outreach → evaluate → verify → monitor
    ↓          ↓          ↓          ↓         ↓
  find      open       analyze    pay &    ongoing
 targets    issues    + gen PR   confirm   health
```

1. **Discover** — Searches GitHub for projects using x402 payment protocol
2. **Outreach** — Opens issues on repos offering to help add sBTC support
3. **Evaluate** — Analyzes codebases and can auto-generate PRs with sBTC integration
4. **Verify** — Sends real sBTC payments to confirm endpoints work correctly
5. **Monitor** — Scheduled health checks with Telegram alerts when things break

## Quick Start

```bash
# Clone and install
git clone https://github.com/pbtc21/sbtc-appleseed.git
cd sbtc-appleseed
bun install

# Configure (copy and edit)
cp .env.example .env

# Run commands
bun run appleseed discover --limit 20
bun run appleseed list
bun run appleseed verify -e https://some-endpoint.com
bun run appleseed monitor --once
```

## Commands

| Command | What it does |
|---------|--------------|
| `discover` | Search GitHub for x402 projects, score them, add to registry |
| `add <url>` | Manually register an endpoint |
| `list` | Show all tracked endpoints with status |
| `verify` | Probe and pay an endpoint (or batch with `--all`) |
| `outreach` | Open a GitHub issue proposing sBTC integration |
| `evaluate` | Analyze a repo's code for x402 patterns |
| `monitor` | Run health checks on all tracked endpoints |
| `digest` | Send summary to Telegram |

## Telegram Bot

Run the bot for interactive control from your phone:

```bash
bun run bot
```

**Commands:**
- `/status` — Wallet balance + endpoint counts
- `/list` — All tracked endpoints
- `/check <url>` — Probe any endpoint
- `/help` — Show commands

The bot also sends alerts when monitored endpoints go down or recover.

## Configuration

```bash
# Required
APPLESEED_PRIVATE_KEY=     # Stacks private key for payments

# Optional
STACKS_NETWORK=mainnet     # mainnet or testnet
MAX_SBTC_PER_VERIFY=50000  # Max sats per verification (default: 50k)
FEE_MULTIPLIER=1.5         # Transaction fee multiplier

# Telegram (for alerts + bot)
TELEGRAM_BOT_TOKEN=        # From @BotFather
TELEGRAM_CHAT_ID=          # Your chat ID (bot tells you on /start)
```

## How Verification Works

```
1. Probe endpoint → expect HTTP 402 with payment requirements
2. Check if sBTC is in accepted payment methods
3. Sign and broadcast sBTC transfer on Stacks
4. Wait for confirmation (~30 seconds)
5. Retry request with payment proof
6. Confirm endpoint returns 200 with content
```

If `--dry-run` is passed, it probes without paying.

## Pipeline States

Endpoints move through these statuses:

```
discovered → contacted → evaluating → pr_opened → awaiting_verification → verified → monitoring
                                                                                         ↓
                                                                                      broken
```

## Example Workflows

**Find and track new endpoints:**
```bash
bun run appleseed discover --language ts --limit 50
bun run appleseed list --status discovered
```

**Reach out to a project:**
```bash
bun run appleseed outreach https://some-endpoint.com --repo https://github.com/org/repo
```

**Evaluate and generate a PR:**
```bash
bun run appleseed evaluate https://github.com/org/repo --auto
```

**Verify all monitored endpoints:**
```bash
bun run appleseed verify --all
```

**Run continuous monitoring:**
```bash
bun run appleseed monitor  # runs forever, checks every 30 min
```

## Why Appleseed?

The x402 payment protocol enables pay-per-call APIs. sBTC brings Bitcoin to that ecosystem. Appleseed bridges the gap by:

- Finding projects already using x402 (but not sBTC)
- Making it easy for them to add sBTC support
- Proving it works with real payments
- Keeping the ecosystem healthy with monitoring

It's automated sBTC evangelism — fund a wallet, let it run, grow the network.

## Tech Stack

- **Runtime:** Bun
- **Database:** SQLite (bun:sqlite)
- **Payments:** x402-stacks SDK
- **Notifications:** Telegram Bot API
- **GitHub:** gh CLI for issues/PRs

## License

MIT
