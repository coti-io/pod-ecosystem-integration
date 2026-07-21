# PoD Sablier Payroll UI — reference

Live Fuji+COTI addresses and explorer `#code` links: see `SKILL.md` (source verified 2026-07-19).

## Contracts the UI talks to (Fuji)

| Contract | Purpose |
|----------|---------|
| `PayrollCampaignFactory` | `createCampaign(admin, merkleRoot, token, start, expiration, name, minFeeUSD)` |
| `PayrollCampaignFacade` | Fund credit, claim, clawback, reads |
| `PodClaimStore` | `submitPayload(facade, index, verifyIt, proofHandle)` before claim |
| pToken (`PodERC20` / pMTT) | Public `transfer(to, amount, callbackFee)` for fund + payout settle |
| `MockSablierComptroller` / comptroller | `convertUSDFeeToWei` / receive claim fee |

UI does **not** call `PrivatePayrollCoti` or `MpcExecutor` directly.

## Critical facade API (iter 08)

```solidity
function requestCreditPool(uint256 amount, uint256 callbackFeeWei) external payable; // admin
function poolCreditedTotal() external view returns (uint256);
function onPoolCredited(uint256 amount) external; // vault only

function claim(uint256 index, address recipient, itUint256 itAmount, bytes32[] proof) external payable;
function claimTo(uint256 index, address to, itUint256 itAmount, bytes32[] proof) external payable;
// itAmount is ABI-compat only; COTI verifies via claimStore IT

function clawback(address to, uint256 amount, uint256 callbackFeeWei) external payable; // admin
function payoutTo(address to, uint256 amount) external payable; // vault only; public pToken transfer

function hasClaimed(uint256 index) external view returns (bool);
function calculateMinFeeWei() external view returns (uint256);
```

**Removed (do not call):** `ackPoolCredit`, any local `MpcCore.*`, encrypted `payoutTo(itUint256)`, stored `inboxFeeWei` / `callbackFeeWei` on facade.

## Fund sequence (employer / admin)

**Do not** stop after `pToken.transfer` — the facade balance is not the COTI pool until `requestCreditPool` completes.

```ts
// 1) Public fund — amount is public on the wire (live Fuji path)
const gasPrice = await publicClient.getGasPrice();
const { totalValueWei, callbackFeeWei } = await pToken.read.estimateFee({ gasPrice });
await pToken.write.transfer([facade, amount, callbackFeeWei], {
  account: employer,
  value: totalValueWei,
  gasPrice,
});
// wait Transfer settle / syncBalances

// 2) Credit COTI encrypted pool via inbox (required) — quote live, never read stored fees
const before = await facade.read.poolCreditedTotal();
const [totalFeeWei, , payrollCallbackFeeWei] = await vault.read.estimateFee({ gasPrice });
await facade.write.requestCreditPool([amount, payrollCallbackFeeWei], {
  account: admin,
  value: totalFeeWei,
  gasPrice,
});
// poll until PoolCredited / poolCreditedTotal advances:
while ((await facade.read.poolCreditedTotal()) < before + amount) {
  await sleep(2000);
}

// 3) Keep native AVAX on facade for later claim inbox fees
```

## Claim sequence (employee)

```ts
// 1) Build verify IT (claimant-signed amount) for claimStore — see port test harness
await claimStore.write.submitPayload([facade, index, verifyIt, proofHandle], { account: claimant });

// 2) claim with dummy/compat itAmount + merkle proof + comptroller fee in msg.value
//    (inbox fee is paid from facade float via live vault.estimateFee at claim gasPrice)
await facade.write.claim([index, claimant, itAmount, proof], {
  account: claimant,
  value: minFeeWei,
});

// 3) Async: poll hasClaimed(index) + pToken balance sync (Submitted → Processing → Paid)
```

## Clawback (admin)

```ts
const gasPrice = await publicClient.getGasPrice();
const [totalFeeWei, , callbackFeeWei] = await vault.read.estimateFee({ gasPrice });
await facade.write.clawback([to, amount, callbackFeeWei], {
  account: admin,
  value: totalFeeWei,
  gasPrice,
});
// mine COTI clawbackPool + public payout callback
```

## Create campaign

```ts
await factory.write.createCampaign(
  [admin, merkleRoot, pToken, start, expiration, name, minFeeUSD],
  { account: creator }
);
// Then register each leaf on COTI PrivatePayrollCoti + facade.registerLeaf (ops / backend)
```

## Fees to show in UI

| Fee | Source | Paid with |
|-----|--------|-----------|
| Claim protocol fee | `facade.calculateMinFeeWei()` / `minFeeUSD` | `msg.value` on `claim` → comptroller |
| Inbox two-way (credit / claim / clawback) | **Live** `vault.estimateFee({ gasPrice })` (oracle × gasPrice) | AVAX `msg.value` or facade float |
| pToken transfer / callback | **Live** `pToken.estimateFee({ gasPrice })` | AVAX on fund / payout |

**Anti-pattern:** baking `inboxFeeWei` / `callbackFeeWei` into factory/facade at deploy — fees go stale vs `tx.gasprice` and token oracle prices (`TargetFeeTooLow`).

## Anti-patterns (false greens / live breaks)

| Bad | Why |
|-----|-----|
| Hard-coded / stored PoD fees | Stale vs live gasPrice + oracle → `TargetFeeTooLow` |
| `ackPoolCredit(it)` on Fuji | Calls `0x64`; empty on Fuji → revert ~28k gas |
| Encrypted `pToken.transfer(it)` for fund and assuming pool is credited | Transfer may settle; **pool ledger does not** without `requestCreditPool` |
| Treating `ClaimInstant` as paid | Fires before COTI verify + payout callback |
| Injecting sim `0x64` on AVAX in tests | Masks the live architecture bug |
| Calling `PrivatePayrollCoti` from the browser | Wrong chain; use inbox + relayer |

## Related skills

- `pod-privacy-portal` — treasury seed / pToken deposit via portal
- `pod-pp-fee-oracle-upgrade` — portal fee + oracle quotes for deposits
