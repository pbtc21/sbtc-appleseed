# Accept Bitcoin Payments via x402 + sBTC

**What:** Add sBTC (Bitcoin on Stacks) as a payment option for your x402 endpoints.

**Why:** Your users get a Bitcoin-native payment rail — no intermediary fees, Bitcoin-grade security, and the sBTC lands directly in your wallet. This doesn't replace your existing payment setup — it adds one more option alongside USDC/SOL/ETH.

**Verification:** Once you're live, we'll send a real sBTC payment to your endpoint and report the result here. The sBTC from that test is yours to keep.

---

## Integration Steps

### 1. Install the SDK

```bash
npm install x402-stacks
# or
bun add x402-stacks
```

### 2. Add sBTC to your accepted payments

In your x402 middleware or payment configuration, add a Stacks entry to your `accepts[]` array:

```typescript
{
  scheme: "exact",
  network: "stacks:1",
  asset: "SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-sbtc",
  amount: "1000", // in smallest unit (sats)
  payTo: "YOUR_STACKS_ADDRESS",
  maxTimeoutSeconds: 300,
  extra: {
    facilitator: "https://facilitator.stacksx402.com",
    tokenType: "sBTC"
  }
}
```

### 3. Route payments by network

When you receive a `Payment-Signature` header, decode the base64 JSON payload and check `payload.network`:

```typescript
const decoded = JSON.parse(atob(paymentSignature));
if (decoded.accepted?.network?.startsWith("stacks:")) {
  // Route to Stacks facilitator for settlement
  const response = await fetch("https://facilitator.stacksx402.com/settle", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      signed_transaction: decoded.payload.transaction,
      token_type: "SBTC",
      expected_recipient: "YOUR_STACKS_ADDRESS",
      min_amount: requiredAmount,
      network: "mainnet",
      resource: decoded.resource?.url
    })
  });
  const result = await response.json();
  if (result.success) {
    // Payment verified — serve the resource
  }
}
```

For the v1 flow (simpler), check the `X-PAYMENT` header instead:

```typescript
import { X402PaymentVerifier } from "x402-stacks";

const verifier = new X402PaymentVerifier(
  "https://facilitator.stacksx402.com",
  "mainnet"
);
const result = await verifier.settlePayment(signedTxHex, {
  expectedRecipient: "YOUR_STACKS_ADDRESS",
  minAmount: BigInt(requiredAmount),
  tokenType: "sBTC"
});
```

### 4. Set environment variables

```
STACKS_FACILITATOR_URL=https://facilitator.stacksx402.com
```

### 5. Test it

Call your endpoint without payment — you should get a 402 response that includes `stacks:1` and sBTC in the accepted methods.

---

## Resources

- **Crosschain example** (copy-paste patterns): https://github.com/aibtcdev/x402-crosschain-example
- **x402-stacks SDK**: https://www.npmjs.com/package/x402-stacks
- **Facilitator**: https://facilitator.stacksx402.com
- **Working PR example** (OpenFacilitator): https://github.com/rawgroundbeef/OpenFacilitator/pull/6
- **sBTC contract**: `SP3K8BC0PPEVCV7NZ6QSRWPQ2JE9E5B6N3PA0KBR9.token-sbtc`

## Need a Stacks wallet?

```bash
# Generate a new keypair
npx x402-stacks generate-keypair
```

Or use any Stacks wallet (Leather, Xverse) to get an address starting with `SP...`.

---

Reply here when your endpoint is ready and we'll run the verification test.
