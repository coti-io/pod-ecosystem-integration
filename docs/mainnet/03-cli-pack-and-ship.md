# Packing and shipping the deploy CLI

## Build

```bash
cd pod-ecosystem-integration
npm run deploy:cli:pack
# → dist/deploy-cli.js (+ sourcemap)
```

## What to copy to the deploy server

Minimum tree:

```
pod-deploy/
  dist/deploy-cli.js
  deployConfig.mainnet.yaml          # or testnet
  deployConfig.testnet.yaml          # optional
  hardhat.config.ts
  package.json
  package-lock.json
  artifacts/                         # after `npm run compile` / link:contracts
  contracts/ or linked packages      # as required by hardhat compile
  node_modules/                      # or npm ci on server
  .env                               # keys + RPC URLs (never commit)
```

Hardhat / viem / yaml stay **external** to the bundle — install deps on the server with `npm ci`.

## Run on server

```bash
export DEPLOY_CONFIG=deployConfig.mainnet.yaml
export PRIVATE_KEY=0x...
# network-specific keys/RPCs as in hardhat.config.ts

node --import tsx dist/deploy-cli.js
# or, after compile:
node dist/deploy-cli.js --verify-all
```

Interactive banner shows **LIVE / FORKED**, chain id, and deploy wallet — confirm before any mainnet broadcast.

## Fork dry-run on a jump host

```bash
npm run fork:cli -- setup --source avalanche --coti mainnet
# set forks.enabled: true in YAML
DEPLOY_CLI_NETWORK=forkSource node dist/deploy-cli.js
```
