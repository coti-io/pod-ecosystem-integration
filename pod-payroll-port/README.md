# PoD Payroll Port (`pod-payroll-port/`)

Phase 2 port of Sablier payroll user-story tests to PoD (simCOTI + Hardhat).

## Principles

- **`sablier-payroll/`** is frozen — Phase 1 reference (`npm run test:sablier-payroll`)
- **Story files** under `test/stories/` are verbatim copies — do not edit assertion logic
- Evolve **contracts** + **`test/lib`** only
- Merkle leaf: `hash(index, recipient, hash(ct))` via `amountCommitment` (see `test/lib/merkle.ts`)

## Run

```bash
npm run test:pod-payroll-port
```

Requires `COTI_BACKEND=sim`, linked contracts (`npm run link:contracts`), and synced port contracts (`pod-payroll-port/scripts/sync-contracts.sh` — run automatically by npm script).

## Layout

```
pod-payroll-port/
  contracts/avax/   PayrollVault, PayrollCampaignFacade, PodClaimStore
  contracts/coti/   PrivatePayrollCoti
  test/stories/     S01–S31 (35 tests, copied from sablier-payroll)
  test/lib/         PoD scenario, merkle, facade, async mining
  docs/             Architecture + iteration gap reports
```

## Architecture (summary)

| Layer | Role |
|-------|------|
| **PayrollCampaignFacade** | Sablier-shaped API (`claim`, `claimTo`, `clawback`, `hasClaimed`, …) |
| **PayrollVault** | AVAX inbox client (async COTI verify + payout callback) |
| **PrivatePayrollCoti** | COTI verify, encrypted roster, `spent[runId][index]` |
| **test/lib** | Dual-chain deploy, merkle builder, `wrapCampaignFacade` async mining |

Iteration 2 passes all stories with full async cross-chain claim mining (see `docs/iterations/ITERATION_02_GAPS.md`).
