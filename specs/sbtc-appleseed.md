# Spec: sBTC Appleseed

## Problem

AI agents are building an autonomous economy on USDC/Solana/Base. sBTC has real x402 infrastructure ($2.4M+ volume, facilitators, SDKs, crosschain middleware) but the best agents don't know it exists. Nobody is making first contact and *proving* it works.

## Solution

**sBTC Appleseed** is two things:

1. **A GitHub issue** filed on target agent repos — clear, concise instructions for adding sBTC acceptance via the x402 crosschain middleware pattern
2. **A verification script** that sends real sBTC to the agent's x402 endpoint, confirms the resource is delivered, and posts the result back to the GitHub issue

The sBTC spent during verification *is* the seed. Every successful test is a real payment that lands in the agent's wallet. No grant applications, no onboarding flows, no yield vaults. Just: "here's how to accept Bitcoin payments" → they do it → we pay them to prove it works → they keep the money.

## How It Works

```
1. Identify target agent (CRM research)
2. File GitHub issue with integration guide
3. Agent follows guide, adds sBTC to accepts[]
4. Agent replies "ready" or we detect the 402 response
5. Verification script runs:
   a. Calls the agent's endpoint without payment
   b. Confirms HTTP 402 with sBTC in accepted payments
   c. Signs and sends sBTC payment via x402 flow
   d. Checks if resource is delivered (HTTP 200 + body)
   e. Posts result to GitHub issue as a comment
6. Update CRM status
```

## Core Features

### Feature 1: GitHub Issue Template

A well-crafted issue filed on the agent's repo. Contains:

- **What**: "Accept Bitcoin payments via x402 + sBTC"
- **Why**: Additional revenue stream, no platform fees, Bitcoin-backed
- **How**: Step-by-step using crosschain middleware pattern
  - Install `x402-stacks` alongside existing `@x402/evm` or `@x402/svm`
  - Add `{ scheme: "exact", network: "stacks:1", asset: "sBTC", amount: ... }` to `accepts[]`
  - Route `Payment-Signature` header by `network.startsWith("stacks:")` → Stacks middleware
  - Set `STACKS_FACILITATOR_URL=https://facilitator.stacksx402.com`
- **Verification**: "Once live, we'll send a real sBTC payment to your endpoint and report the result here"
- **Reference**: Links to crosschain example repo, SDK docs, OpenFacilitator PR #6

The issue should be technically precise but readable. A developer should be able to follow it in one sitting.

### Feature 2: Verification Script

A CLI tool (or Cloudflare Worker endpoint) that:

**Input:**
- `endpoint_url` — the agent's x402 endpoint to test
- `github_issue_url` — where to post the result
- `max_sbtc` — maximum sBTC to spend on verification (default: configurable per tier)

**Flow:**
1. `GET endpoint_url` — expect HTTP 402 response
2. Parse 402 body — confirm `sBTC` or `stacks:1` appears in accepted payment methods
3. Extract payment requirements (amount, recipient address, network)
4. Sign sBTC transfer using a funded wallet (the Appleseed wallet)
5. Submit payment via x402 flow (Payment-Signature header → facilitator broadcasts)
6. Retry `GET endpoint_url` with payment proof
7. Check response: HTTP 200? Body contains expected resource?
8. Compose result report
9. Post comment to GitHub issue via `gh` CLI or GitHub API

**Output (GitHub comment):**

On success:
```
## sBTC Payment Verification ✓

Endpoint: `https://agent.example.com/api/data`
Payment: 0.0001 sBTC sent to SP...
Transaction: [view on explorer](https://explorer.hiro.so/txid/...)
Resource delivered: Yes (HTTP 200, 1.2KB response)

Your endpoint is live and accepting sBTC payments via x402.
The sBTC from this test is yours to keep.
```

On failure:
```
## sBTC Payment Verification ✗

Endpoint: `https://agent.example.com/api/data`
Step failed: [specific step]
Details: [what went wrong — e.g. "402 response missing stacks:1 network",
  "payment sent but resource not delivered", etc.]

See the integration guide above for troubleshooting.
Happy to help — reply here with questions.
```

### Feature 3: CRM Integration

After each verification attempt (pass or fail), update the agent's CRM record:

- Status: "Contacted" → "Onboarding" (issue filed) → "Won" (verification passed) or stays "Onboarding" (failed, needs retry)
- Notes: auto-append verification result with timestamp
- New fields:
  - `issueUrl` — link to the GitHub issue
  - `endpointUrl` — the x402 endpoint being tested
  - `verificationStatus` — `pending` / `passed` / `failed`
  - `verificationTxId` — on-chain proof
  - `sbtcSent` — total sBTC sent to this agent

## Budget

$5,000 of sBTC in the Appleseed wallet. Each verification test costs a small amount of sBTC (whatever the agent prices their endpoint at — typically 0.001-0.01 STX equivalent). The bulk of the budget goes to agents whose endpoints are priced higher or who we test multiple times.

At ~$0.50-5.00 per verification, the $5K budget covers hundreds of agent tests. Agents keep every payment.

## Out of Scope (v1)

- Automated agent discovery (manual research + CRM for now)
- Auto-filing issues (manual for quality — each issue should reference the specific agent's stack)
- Continuous monitoring (one-shot verification per agent)
- Multi-endpoint testing (one endpoint per agent)
- Leaderboards or public dashboards

## Success Criteria

- [ ] Issue template written and tested on 3 repos
- [ ] Verification script works end-to-end (402 detection → payment → resource check → GitHub comment)
- [ ] Appleseed wallet funded with sBTC
- [ ] 10 issues filed, 5 verifications completed, 3 passing
- [ ] CRM reflects all activity

## Technical Notes

**Integration guide content** — based on real working pattern:
- Reference: `aibtcdev/x402-crosschain-example` (FROM_EVM.md, FROM_SOLANA.md)
- SDK: `npm install x402-stacks` (v2.0.1+)
- Facilitator: `https://facilitator.stacksx402.com`
- Working PR example: `rawgroundbeef/OpenFacilitator#6`
- Spec alignment: coinbase/x402 v2 + aibtcdev Stacks extensions

**Verification script stack:**
- TypeScript, runs as CLI (`bun run verify`) or Cloudflare Worker endpoint
- Uses `x402-stacks` client SDK to handle the payment flow
- Uses GitHub API (`gh api` or `octokit`) to post issue comments
- Funded by a single Appleseed wallet (Stacks address with sBTC balance)
- Logs all transactions for audit trail

**LLM guidance for issue creation** (from user's research):
- Always review agent's existing x402 setup first (chain, SDK, framework)
- Use the comparison table (EVM vs Solana vs Stacks payment models)
- Recommend two-path strategy (immediate crosschain middleware + long-term native)
- Phase the implementation: routing → verify/settle → crosschain responses → discovery
