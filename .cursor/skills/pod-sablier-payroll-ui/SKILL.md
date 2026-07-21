---
name: pod-sablier-payroll-ui
description: >-
  Build or upgrade hrpayroll / Sablier Instant campaign UI for PoD PayrollCampaignFacade
  on Fuji (or Sepolia). Use when implementing fund, claim, clawback, factory createCampaign,
  poolCreditedTotal polling, or when the user mentions ackPoolCredit, requestCreditPool,
  PayrollCampaignFacade, sablier-payroll-pod, or Fuji payroll fund failures.
---

# PoD Sablier Payroll Campaign UI

## When To Use

Use this skill for **campaign UI** against `PayrollCampaignFacade` + factory (not Privacy Portal deposits — that is `pod-privacy-portal`).

Triggers: fund campaign, claim / claimTo, clawback, create campaign wizard, Fuji payroll, `requestCreditPool`, old `ackPoolCredit` / MpcCore bugs.

## Architecture (iteration 08 — required)

Fuji is a **PoD client chain**: **no** code at `0x64`. Do **not** call local `MpcCore` / `ackPoolCredit` on the facade.

| Step | Fuji (UI) | COTI (relayer / inbox) |
|------|-----------|-------------------------|
| Fund | Public `pToken.transfer(facade, amount)` → settle | — |
| Credit pool | `facade.requestCreditPool(amount)` + inbox AVAX | `PrivatePayrollCoti.creditPool` → `onPoolCredited` |
| Claim | merkle / fee / `submitPayload` / `claim` | `verifyAndCredit` (+ pool deduct) |
| Payout | — | callback → `payoutTo(to, uint256)` public transfer |

Poll **`poolCreditedTotal`** after fund (not local encrypted pool / not `ackPoolCredit`).

## Deployed addresses (Fuji + COTI testnet)

Prefer app config / `pod-dapp-ports/sablier-payroll-pod/deployments/production-payroll-avalancheFuji.json`. Snapshot after live-fee redeploy (`updatedAt` 2026-07-20):

| Role | Address | Explorer |
|------|---------|----------|
| Inbox (Fuji + COTI) | `0xAb625bE229F603f6BBF964474AFf6d5487e364De` | — |
| MpcExecutor | `0x68e151b78d51cea01eef6ee354579e044606a739` | Cotiscan |
| PrivatePayrollCoti | `0xeddbb52a6b92db6ba088c39a96dd0b1a76082ecb` | [Cotiscan](https://testnet.cotiscan.io/address/0xeddbb52a6b92db6ba088c39a96dd0b1a76082ecb#code) |
| PayrollVault | `0xd43b8c9015565f3c3f453e574418e17302c73dd9` | [Snowscan](https://testnet.snowscan.xyz/address/0xd43b8c9015565f3c3f453e574418e17302c73dd9#code) |
| PodClaimStore | `0x3b765d5d29093c08236566d954f52eaadfe5a4a2` | [Snowscan](https://testnet.snowscan.xyz/address/0x3b765d5d29093c08236566d954f52eaadfe5a4a2#code) |
| PayrollCampaignFactory | `0x17cad9fce18ef750e8626c2d1ee9be97f3d375e5` | [Snowscan](https://testnet.snowscan.xyz/address/0x17cad9fce18ef750e8626c2d1ee9be97f3d375e5#code) |
| Template facade | `0x401b9514a3CCA82c790d7F360F28C1B33F04227D` | [Snowscan](https://testnet.snowscan.xyz/address/0x401b9514a3CCA82c790d7F360F28C1B33F04227D#code) |
| Comptroller | `0x79f8cc90e9a1ce76335e75bc057ed6b446679010` | [Snowscan](https://testnet.snowscan.xyz/address/0x79f8cc90e9a1ce76335e75bc057ed6b446679010#code) |
| pMTT | `0x8F34570CEAD49273D5DA8A0E25e728eCC28af267` | Snowscan |
| PrivacyPortal (pMTT) | `0x64D99D761aC68D1a495B4f7E5bE7277586EDFE78` | Snowscan |

Chain ids: Fuji `43113`, COTI testnet `7082400`. **Live fees:** quote via `PayrollVault.estimateFee({ gasPrice })` — no stored `inboxFeeWei`.

## UX rules

1. **Fund is two steps:** public transfer settle → `requestCreditPool` → wait `PoolCredited` / `poolCreditedTotal`.
2. **Never** call `ackPoolCredit` (removed). Never expect Fuji MPC / AccountOnboard for pool.
3. **Claim** is async: `ClaimInstant` = submitted; **Paid** only when `hasClaimed` + balance sync after dual-chain mine.
4. Quote **comptroller fee** (`calculateMinFeeWei`) **and** live inbox fee (`vault.estimateFee` / inbox calculate at current `gasPrice`) separately — never use baked `inboxFeeWei` storage.
5. Top up facade with native AVAX for claim inbox fees (claim pays inbox from facade float using a live quote).
6. Create campaigns via **`PayrollCampaignFactory.createCampaign`**; register COTI leaves after create.

## Read next

- `reference.md` — ABIs, fee fields, state machine, anti-patterns
- Port docs: `pod-dapp-ports/sablier-payroll-pod/docs/USER_FLOWS.md` — networks, contracts, inbox callbacks
- Port docs: `pod-dapp-ports/sablier-payroll-pod/docs/AIRDROP_CAMPAIGN_UI_CHECKLIST.md`
- Port docs: `pod-dapp-ports/sablier-payroll-pod/docs/ARCHITECTURE.md`
- Port docs: `pod-dapp-ports/sablier-payroll-pod/docs/iterations/ITERATION_08_GAPS.md`
