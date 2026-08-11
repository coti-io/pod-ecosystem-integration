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
npm install          # file: deps → ../coti-pod-inbox-contracts, ../coti-contracts, ../sim-coti-node
npx hardhat compile
```

Hardhat compiles Solidity from those packages via `solidity.npmFilesToBuild` in `hardhat.config.ts` (Hardhat 3 does not allow `paths.sources` under `node_modules`). No `link-contracts` mirror. After editing a sibling repo, recompile here (re-run `npm install` only if `package.json` / lockfile changed).

## VS Code / Cursor workspace

Open [`pod-ecosystem.code-workspace`](./pod-ecosystem.code-workspace) for multi-root editing across all repos.

## Tests

Hardhat scripts set `NODE_OPTIONS=--max-old-space-size=8192` to avoid Node OOM. Live-RPC / system suites stay gated (`COTI_BACKEND=sim`, `*_SYSTEM_TESTS`, etc.) unless secrets + flags are present.

| Command | Description |
|---------|-------------|
| `npm test` / `test:ci:in-mem` | Default in-mem Hardhat (system suites skipped) |
| `npm run test:ci:sim` | Sim inbox estimate + mine gas (`COTI_BACKEND=sim`) |
| `npm run test:erc7984` | ERC-7984 compat (local) |
| `npm run test:pp-system` | Privacy Portal system (`PP_SYSTEM_TESTS=1`) |
| `npm run test:pp-mainnet-smoke` | Read-only mainnet config + optional code checks |
| `npm run test:pod-token` | pToken cross-chain (`POD_TOKEN_SYSTEM_TESTS=1`) |
| `npm run test:executor-coti` | COTI MPC executor |

Inbox-only tests live in **coti-pod-inbox-contracts** (`test:inbox-events`, `test:inbox-fee`, etc.).

### GitHub Actions

`.github/workflows/ci.yml` checks out this repo plus sibling `file:` deps (`coti-pod-inbox-contracts`, `coti-contracts`, `sim-coti-node`) and runs **in-mem** and **sim** jobs.

| Trigger | Sibling refs |
|---------|----------------|
| PEI `pull_request` / `push` to `main` | siblings default to `main` |
| `workflow_dispatch` | optional `inbox_ref` / `contracts_ref` / `sim_ref` |
| `repository_dispatch` type `pod-contracts-changed` | uses `client_payload.repo` + `sha` for the changed sibling |

**Secrets**

- `CROSS_REPO_PAT` — PAT that can read `coti-io/*` and private `cotitech-io/sim-coti-node` (required for sim checkout; also used for sibling checkouts).
- Sender repos (`coti-pod-inbox-contracts`, `coti-contracts`) need `PEI_DISPATCH_PAT` with permission to create `repository_dispatch` on this repo.

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

Canonical copies live in **coti-contracts** (`contracts/pod/…`). This workspace depends on it via `file:../coti-contracts` (and the inbox via `file:../coti-pod-inbox-contracts`). Change sources in those repos, then:

```bash
cd ../coti-pod-inbox-contracts && npm install && npx hardhat compile
cd ../pod-ecosystem-integration && npx hardhat compile
```

