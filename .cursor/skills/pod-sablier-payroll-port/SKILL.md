# PoD Sablier Payroll Port

Port Sablier payroll user-story tests to PoD (`pod-payroll-port/`) without editing story files.

## When to use

- Implementing or debugging `pod-payroll-port/`
- Iterating on `PayrollCampaignFacade`, `PrivatePayrollCoti`, or `test/lib`
- After changes, run `npm run test:pod-payroll-port`

## AVAX vs COTI

| Chain | Contracts | Responsibility |
|-------|-----------|----------------|
| Hardhat (AVAX surrogate) | `PayrollCampaignFacade`, `PayrollVault`, `PodClaimStore`, `PodErc20Mintable` | Sablier API, pToken payout, inbox outbound |
| simCOTI | `PrivatePayrollCoti`, `PodErc20CotiMother` | Encrypted roster verify, garbled pToken state |
| Privacy Portal | **Test infra only** | Corporate treasury seed / `mint` top-ups — **payroll contracts never call portal** |

## Funding model (iteration 4)

1. **Treasury seed** — `seedCorporateTreasury(employer)` once per scenario (portal → employer pToken)
2. **Campaign fund** — employer `token.transfer(facade, amount)` → `creditPool(amount)` + facade ETH
3. **Story `mint`** — treasury top-up via portal to employer (not direct to facade)
4. **Claim payout** — facade `payoutTo` (pToken only) after COTI verify

## Merkle (PoD)

```
inner = keccak256(abi.encode(index, recipient, amountCommitment))
leaf  = keccak256(bytes.concat(inner))
amountCommitment = keccak256(abi.encode(ctUint256))
```

## Async claim path

1. **Fund** — treasury pToken transfer + `creditPool` + facade ETH
2. **Prepare** — `PodClaimStore.setPayload` with `itUint256` + `proofHandle = abi.encode(proof, index)`
3. **Claim tx** — facade pre-checks (time, merkle, **`poolBalance`**) → vault `requestPayout` → `ClaimInstant`
4. **Mine payroll** — COTI `verifyAndCredit(gtUint256, proofHandle)` → vault callback → `payoutTo` (`estimateFee()`)
5. **Mine pToken** — `mineAfterPayoutTransfer`
6. **Sync** — `tokenAdapter.syncAccount` for decrypted story balances

### IT signing

- **Claim**: `inboxCoti` + `batchProcessRequests`
- **Register**: `PrivatePayrollCoti` + `registerLeaf(...)` selector
- **pToken transfer**: per-account `prepareSimIT256` + onboard all wallets on simCOTI

## Test lib map

| File | Role |
|------|------|
| `portal-setup.ts` | Deploy portal + pToken; `seedCorporateTreasury`, `portalDepositTo` |
| `pod-scenario.ts` | Treasury seed, `fundFacade` via pToken transfer, facade registry |
| `pod-token-adapter.ts` | Story ERC20 API; `mint` = treasury top-up; transfer → `onCampaignFunded` |
| `campaign-facade.ts` | Double mine after claim |
| `async.ts` | `mineAfterPayoutClaim` + `mineAfterPayoutTransfer` |

## Do not

- Edit `pod-payroll-port/test/stories/`
- Edit `sablier-payroll/` (frozen Phase 1)
- Route campaign funding through Privacy Portal (treasury → pToken transfer only)

## References

- Gap reports: `pod-payroll-port/docs/iterations/ITERATION_01_GAPS.md` … `ITERATION_04_GAPS.md`
