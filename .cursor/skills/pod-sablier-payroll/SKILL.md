---
name: pod-sablier-payroll
description: Build UI integrations for PoD Sablier Merkle Instant payroll (PayrollCampaignFactory, PayrollCampaignFacade, claim/fund flows). Use when implementing payroll create wizard, campaign admin panels, employee claims, pToken funding, wallet role gating, or when the user mentions Sablier payroll, PayrollCampaignFactory, PayrollCampaignFacade, or PoD airdrop campaigns.
---

# PoD Sablier Payroll UI Integration

## When To Use

Use this skill when building a frontend for:

- Creating a new payroll/airdrop campaign via `PayrollCampaignFactory`
- Campaign page: eligibility, claim / claimTo, admin fund & clawback
- Identifying wallet roles (creator, admin, employer, employee)
- Wiring addresses from Fuji/Sepolia payroll deployment manifests

## Core Model

Shared infra (vault, claimStore, comptroller, `PrivatePayrollCoti`, inbox) is **ops-deployed once**. The UI never redeploys those.

Per campaign the UI calls:

1. **Off-chain:** build merkle roster (`index`, `recipient`, `amount` → root + proofs + amount commitments)
2. **On-chain:** `factory.createCampaign(admin, merkleRoot, pToken, start, expiration, name, minFeeUSD)`
3. **Post-create (admin / backend):** COTI `registerRun` + `registerLeaf` (owner key today) and facade `registerLeaf`
4. **Fund:** employer pToken `transfer` to facade → sync → `ackPoolCredit(it)` + native fee top-up
5. **Claim:** employee `PodClaimStore.submitPayload` → `facade.claim` / `claimTo` → poll until `hasClaimed`

Source tx success ≠ payout complete. Model claim as async (Submitted → Processing → Paid).

## Read First

In this skill folder:

- `reference.md` — addresses, ABIs, roles, create/claim sequences

Canonical docs in sibling `pod-dapp-ports/sablier-payroll-pod/docs/`:

- `AIRDROP_CAMPAIGN_UI_CHECKLIST.md`
- `ARCHITECTURE.md`
- `MERKLE_POD.md`
- `PRODUCTION_DEPLOY.md`

Deployment manifests:

- `pod-dapp-ports/sablier-payroll-pod/deployments/production-payroll-avalancheFuji.json`
- `pod-dapp-ports/sablier-payroll-pod/deployments/production-payroll-sepolia.json`

Prefer app-local config if newer than the skill snapshot.

## Wallet Roles

| Role | How to detect | UI |
|------|---------------|-----|
| Creator | `CampaignCreated.creator` | “My created campaigns” |
| Admin | `facade.admin()` | Admin panel (register leaves, clawback) |
| Employer | Same as admin for MVP | Fund + `ackPoolCredit` |
| Employee | Off-chain merkle roster for campaign | Claim CTA |
| Infra owner | `vault.owner()` | Not in create wizard |

Create wizard: any wallet; form field for `admin` (default = connected). Admin panel only if `connected === admin()`.

## UX Rules

- Do **not** redeploy vault / inbox / portal from the UI — call `createCampaign` only.
- After create, show `{ facade, runId }` from receipt `CampaignCreated` or `factory.campaigns(i)`.
- Leaf registration still needs a backend/ops path with COTI owner today — document as post-create step.
- Claim: show pending until `hasClaimed(index)` is true after COTI + pToken mining.
- Fees: protocol `calculateMinFeeWei()` plus pToken / vault inbox fees for PoD.

## Do Not Assume

- Do not treat this as continuous Sablier Lockup streams — it is Merkle **Instant** claim.
- Do not put plaintext salary amounts on-chain in PoD events (commitments only).
- Do not skip `ackPoolCredit` after encrypted fund transfer.
- Do not expect `createCampaign` to register COTI leaves.
