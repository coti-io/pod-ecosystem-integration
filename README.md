# PoD Ecosystem Integration

Integration tests, deploy scripts, and a **multi-repo dev workspace** for the COTI PoD stack.

## Repositories

| Repo | Role |
|------|------|
| [coti-pod-inbox-contracts](../coti-pod-inbox-contracts) | Inbox implementation, fee manager, miner |
| [coti-contracts](../coti-contracts) | dApp contracts (`contracts/pod/`) |
| **pod-ecosystem-integration** (this repo) | E2E tests, deploy orchestration, workspace |

## Setup

Clone all repos as **siblings** under the same parent directory:

```
workspaces/
  coti-pod-inbox-contracts/
  coti-contracts/
  pod-ecosystem-integration/   ← you are here
```

```bash
npm install          # runs link:contracts via postinstall
npx hardhat compile
```

Run `npm run link:contracts` after changing sibling repos — it rsyncs inbox + pod sources into `contracts/` (required before compile). Shared APIs (`IInbox`, `MpcAbiCodec`, …) come from **`@coti-io/coti-contracts`** (`file:../coti-contracts`); do not re-vendor them under the inbox repo.

## VS Code / Cursor workspace

Open [`pod-ecosystem.code-workspace`](./pod-ecosystem.code-workspace) for multi-root editing across all repos.

## Tests

| Command | Description |
|---------|-------------|
| `npm run test:erc7984` | ERC-7984 compat (local) |
| `npm run test:pp-system` | Privacy Portal system (`PP_SYSTEM_TESTS=1`) |
| `npm run test:pp-mainnet-smoke` | Read-only mainnet config + optional code checks |
| `npm run test:pod-token` | pToken cross-chain (`POD_TOKEN_SYSTEM_TESTS=1`) |
| `npm run test:executor-coti` | COTI MPC executor |

Inbox-only tests live in **coti-pod-inbox-contracts** (`test:inbox-events`, `test:inbox-fee`, etc.).

## Deploy

Configuration (YAML):

- `deployConfig.testnet.yaml` — default (`DEPLOY_CONFIG` unset)
- `deployConfig.mainnet.yaml` — Ethereum + Avalanche + COTI mainnet

Mainnet guides: [`docs/mainnet/`](./docs/mainnet/).
Dry-run orchestration (forks → services → PP): see sibling
`pod-integration-tests/deployments/builder/MAINNET.md`.

```bash
npm run deploy:cli
DEPLOY_CONFIG=deployConfig.mainnet.yaml npm run deploy:cli
npm run fork:cli -- setup --source avalanche --coti mainnet
npm run deploy:cli:pack                 # → dist/deploy-cli.js
npm run verify:deployments:config       # fees / oracles / wiring dump
npm run verify:deployments              # + MpcAdder.add round-trips
```

Inbox deploy scripts: run from **coti-pod-inbox-contracts** (`deploy:inbox`, `relay`).

## Shared PoD APIs

Canonical copies live in **coti-contracts** (`contracts/pod/…`). Change them there, then:

```bash
# inbox + PEI both use file:../coti-contracts
cd ../coti-pod-inbox-contracts && npm install && npx hardhat compile
cd ../pod-ecosystem-integration && npm install && npm run link:contracts && npx hardhat compile
```

