# Deployment Update — Repo File Map

Paths assume sibling checkouts under the same parent as `pod-ecosystem-integration`
(default `POD_REPOS_ROOT=..`). Update SoT first, then these consumers.

## SoT — always

| Path | Inbox | PP / pToken |
|------|:-----:|:-----------:|
| `pod-ecosystem-integration/deployConfig.json` → `inboxSalt.*` | yes | — |
| `…/chains.<id>.inbox` | yes | — |
| `…/chains.7082400.cotiExecutor`, `cotiMother` | yes* | — |
| `…/chains.<id>.priceOracle`, `oracle.*`, `feeConfig`, `gasPriceBounds` | yes* | yes* |
| `…/portalImplementation`, `podTokenImplementation`, `privacyPortalFactory` | — | yes |
| `…/privacyPortalTokens.<symbol>.*` | — | yes |
| `…/portalFee`, `privacyPortalFactoryConstructor` | — | yes |

\*Only when that infra was redeployed or rewired in the same rollout.

## Inbox consumers

| Repo | Path | Field / note |
|------|------|----------------|
| PEI | `scripts/createx.ts` | `INBOX_SALT_LABEL` == `inboxSalt.label` |
| PEI | `scripts/verify-deployments.ts` | Must read inbox/mother from SoT; no legacy `0xAb625…` hardcode |
| PEI | `scripts/deploy-cli.ts`, `scripts/deploy-full-testnet.ts` | Use SoT / CreateX; follow inbox runbook |
| PEI | `scripts/sot-drift/check.mjs` | Guard scopes: `pei`, `sdk`, `contracts`, `inbox`, `explorer`, `ports`, `docs` |
| coti-sdk-pod | `src/consts.ts` | `DEFAULT_INBOX_ADDRESS` (and chain maps if present) |
| coti-contracts | `contracts/pod/PodNetworkConstants.sol` | `INBOX`, `COTI_TESTNET_MPC_EXECUTOR` — **EIP-55** |
| coti-pod-inbox-contracts | `contracts/PodNetworkConstants.sol` | same |
| pod-explorer | `src/config/explorer.ts` | `SHARED_INBOX_ADDRESS` / per-network inbox |
| pod-dapp-ports | `sablier-payroll-pod/deployments/production-payroll-avalancheFuji.json` | `inboxSource`, `inboxCoti`, `mpcExecutor` |
| documentation | `privacy-on-demand/networks/{sepolia,fuji,coti-testnet}.md` | Inbox table rows |

Historical Sepolia payroll manifests may still show legacy inbox **by design** —
do not “fix” bannered historical files unless the user asks.

## Privacy Portal / pToken consumers

| Repo | Path | Field / note |
|------|------|----------------|
| PEI | `deployConfig.json` `privacyPortalTokens` | keys `p.MTT` / `p.USDC` / … ; fields `underlying`, `portal`, `pToken`, `motherRegistrationRequestId` |
| PEI | `scripts/privacyPortal/README.md` | Ops docs; keep aligned with SoT |
| PEI | `scripts/privacyPortal/deploy-*.ts`, `canonical-collateral.ts`, `sync-token-list.ts` | Deploy / list sync |
| PEI | remount / PP system tests under `test/privacy/` | Snapshots and factory assumptions |
| PEI | `.cursor/skills/pod-privacy-portal/` | May contain **stale address snapshots** — prefer SoT; update skill snapshot if editing |
| pod-dapp-ports | Fuji payroll JSON | `privacyPortal`, `pToken`, related payroll contracts if redeployed |
| documentation | network pages / PoD guides | Portal / pToken tables when published |
| contract-manager / hot-wallet | ABIs or addresses only if that deployment pins PP contracts | Out of default fan-out unless user asks |

## Drift guard commands

```bash
# From pod-ecosystem-integration
npm run check:sot-drift
npm run check:sot-drift -- --scope=all

# From a consumer (expects sibling PEI)
npm run check:sot-drift   # or: node scripts/check-sot-drift.mjs
```

Env: `POD_DEPLOY_CONFIG`, `POD_REPOS_ROOT`, `SOT_DRIFT_SCOPE`.

## Deploy-cli reminder (live redeploy only)

Source-chain example order (from `scripts/privacyPortal/README.md`):

```text
inbox → priceOracle → feeConfig → wireInboxOracle
  → ppPortalImpl → ppTokenImpl → ppPortalFactory → wireFactoryOracle → ppPortalFee
```

Then create portals/tokens and record `privacyPortalTokens` + mother registration ids
back into SoT.

## Anti-patterns

- Updating explorer/SDK for a **PP-only** remount.
- Lowercase addresses in Solidity constants.
- Copying addresses into docs before SoT is updated.
- Treating `PrivacyPortalConfig.json` skill snapshots as SoT.
- Auto-committing Solidity without explicit user approval when policy requires it.
