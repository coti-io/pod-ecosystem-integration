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

## Funding model (iteration 5)

1. **Treasury seed** — `seedCorporateTreasury(employer)` once per scenario (portal → employer pToken)
2. **Campaign fund** — employer encrypted `token.transfer(facade)` → employer `ackPoolCredit(amount)` + facade ETH
3. **Story `mint`** — treasury top-up via portal to employer (not direct to facade)
4. **Claim payout** — encrypted `payoutTo(itUint256)` after COTI verify

## Merkle (PoD)

```
inner = keccak256(abi.encode(index, recipient, amountCommitment))
leaf  = keccak256(bytes.concat(inner))
amountCommitment = keccak256(abi.encode(ctUint256))
```

## Async claim path

1. **Fund** — treasury encrypted pToken transfer + `ackPoolCredit` + facade ETH + balance sync
2. **Prepare** — claimant `PodClaimStore.submitPayload` with verify IT + payout IT + `proofHandle`
3. **Claim tx** — facade pre-checks → vault `requestPayout` → `ClaimInstant` (S16 same-block)
4. **Mine payroll** — COTI `verifyAndCredit` → vault `payoutTo(itUint256)` (vault forwards inbox fee)
5. **Mine pToken** — `mineAfterPayoutTransfer`
6. **Sync** — `tokenAdapter.syncAccount` for decrypted story balances

### IT signing

- **Claim verify**: `inboxCoti` + `batchProcessRequests`
- **Register**: `PrivatePayrollCoti` + `registerLeaf(...)` selector
- **pToken transfer / payout / clawback**: per-account `prepareSimIT256` (facade uses registered sim key)

## Test lib map

| File | Role |
|------|------|
| `portal-setup.ts` | Deploy portal + pToken; `seedCorporateTreasury`, `portalDepositTo` |
| `pod-scenario.ts` | Treasury seed, `fundFacade` via pToken transfer, facade registry |
| `pod-token-adapter.ts` | Story ERC20 API; `mint` = treasury top-up; facade transfer → fund + `ackPoolCredit` |
| `campaign-facade.ts` | Claimant payload + double mine; encrypted clawback wrapper |
| `async.ts` | `mineAfterPayoutClaim` + `mineAfterPayoutTransfer` |

## Do not

- Edit `pod-payroll-port/test/stories/`
- Edit `sablier-payroll/` (frozen Phase 1)
- Route campaign funding through Privacy Portal (treasury → pToken transfer only)

## References

- Gap reports: `pod-payroll-port/docs/iterations/ITERATION_01_GAPS.md` … `ITERATION_05_GAPS.md`
