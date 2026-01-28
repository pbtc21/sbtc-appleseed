# Add sBTC to Your x402 Endpoints

You already accept x402 payments — adding sBTC takes one change.

## What to do

Add a Stacks entry to your `accepts[]` array:

```typescript
{
  scheme: "exact",
  network: "stacks:1",
  asset: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-sbtc",
  amount: "1000",
  payTo: "YOUR_STACKS_ADDRESS",
  maxTimeoutSeconds: 300,
  extra: {
    facilitator: "https://facilitator.stacksx402.com",
    tokenType: "sBTC"
  }
}
```

Then route Stacks payments to the facilitator. Check the `Payment-Signature` payload — if `network` starts with `stacks:`, settle via:

```
POST https://facilitator.stacksx402.com/settle
```

That's it. Your endpoint now accepts Bitcoin payments alongside everything else.

## Quick setup

```bash
npm install x402-stacks
```

**Crosschain routing example**: https://github.com/aibtcdev/x402-crosschain-example

**Working PR** (full integration): https://github.com/rawgroundbeef/OpenFacilitator/pull/6

---

Reply here when live — we'll send a real sBTC test payment and report the result.
