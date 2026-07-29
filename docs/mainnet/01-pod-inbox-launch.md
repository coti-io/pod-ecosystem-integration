# PoD Inbox mainnet launch (Inbox + Oracle + Adder + Executor)

Step-by-step for deploying the PoD messaging stack on **COTI mainnet** (`2632500`) and a source chain (**Avalanche** `43114` and/or **Ethereum** `1`).

## Prerequisites

1. **CreateX** at `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` on every target chain.
   - COTI mainnet CreateX was launched with the pcaversaccio pre-signed tx:
     - tx: `0xb6274b80bc7cda162df89894c7748a5cb7ba2eaa6004183c41a1837c3b072f1e`
     - explorer: https://mainnet.cotiscan.io/address/0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed
2. Fund the **PoD deployer** (`deployConfig.roles.owner` / `inboxSalt.deployer`, typically `0xdf9f8f…`) with native gas on each chain.
3. Config: `DEPLOY_CONFIG=deployConfig.mainnet.yaml`
4. Keys in `.env`: `ETHEREUM_PRIVATE_KEY` / `AVALANCHE_PRIVATE_KEY` / `COTI_MAINNET_PRIVATE_KEY` (or `PRIVATE_KEY`), plus RPC URLs.

Dry-run first (optional):

```bash
npm run fork:cli -- setup --source avalanche --coti mainnet
# set forks.enabled: true in deployConfig.mainnet.yaml
DEPLOY_CONFIG=deployConfig.mainnet.yaml DEPLOY_CLI_NETWORK=forkSource npm run deploy:cli
```

## Order of operations

```
CreateX (once per chain)
  → Inbox (CreateX CREATE3, same address family)
  → PriceOracle (+ seed feeds / manual prices + refreshCache)
  → feeConfig (min-fee templates) + gasPriceBounds
  → wireInboxOracle
  → configureRoles / miners
  → MpcAdder (source) + MpcExecutor (COTI)
  → configureAdder (point adder at COTI executor)
```

CLI (interactive or batch):

```bash
export DEPLOY_CONFIG=deployConfig.mainnet.yaml

# COTI side
DEPLOY_CLI_NETWORK=cotiMainnet \
DEPLOY_CLI_TARGETS=inbox,priceOracle,feeConfig,wireInboxOracle,configureRoles,mpcExecutor \
  npm run deploy:cli

# Avalanche side
DEPLOY_CLI_NETWORK=avalanche \
DEPLOY_CLI_TARGETS=inbox,priceOracle,feeConfig,wireInboxOracle,configureRoles,mpcAdder,configureAdder \
  npm run deploy:cli

# Ethereum side (same pattern)
DEPLOY_CLI_NETWORK=ethereum DEPLOY_CLI_TARGETS=inbox,priceOracle,feeConfig,wireInboxOracle,configureRoles,mpcAdder,configureAdder \
  npm run deploy:cli
```

The CLI banner always prints **LIVE vs FORKED**, chain id, and deploy wallet — confirm before broadcasting.

## Oracle choice

Under `chains.<chainId>.oracle`:

### Chainlink

```yaml
oracle:
  adapter: chainlink
  maxStaleness: 3600
  fetchInterval: 300
  legs:
    localToken: "0x..."      # WETH / WAVAX
    remoteToken: "0x...C071" # COTI sentinel
    portalNative: "0x..."
  feeds:
    inboxLocal:
      chainlink: "0x..."     # native/USD aggregator
    collateral:
      USDC: { pegUsd: "1" }
      WETH: { chainlink: "0x..." }   # or WAVAX
  manualLegs: {}
```

### Band

```yaml
oracle:
  adapter: band
  bandStdRef: "0x..."        # StdReference proxy
  maxStaleness: 0            # 0 = use Band’s own expiry
  feeds:
    inboxLocal:
      bandBase: "ETH"        # or "AVAX"
      bandQuote: "USD"
    collateral:
      USDC: { pegUsd: "1" }
      WETH:
        bandBase: "ETH"
        bandQuote: "USD"
```

### Manual / plain (typical on COTI)

```yaml
oracle:
  adapter: plain
  manualLegs:
    localUsdSpot: "0.05"     # COTI/USD
    remoteUsdSpot: "3000"    # remote native/USD
  feeds:
    inboxLocal: {}
    collateral:
      USDC: { pegUsd: "1" }
```

After deploy: CLI `priceOracle` seeds feeds/manual legs and calls `refreshCache`. Re-run when prices drift.

## Fee config

`chains.<id>.feeConfig.local` / `.remote` — min-fee templates applied by `feeConfig` target.

`chains.<id>.gasPriceBounds` — **required on COTI** (non-EIP-1559):

```yaml
gasPriceBounds:
  minPriorityFeeWei: "0"
  minGasPriceWei: "2000000000"
  maxGasPriceWei: "50000000000"   # 0 disables ceiling on EIP-1559 sources
```

## Verify

```bash
DEPLOY_CONFIG=deployConfig.mainnet.yaml DEPLOY_CLI_NETWORK=avalanche npm run deploy:cli -- --verify-all
DEPLOY_CONFIG=deployConfig.mainnet.yaml DEPLOY_CLI_NETWORK=cotiMainnet npm run deploy:cli -- --verify-all
```

Explorers: Snowscan (Etherscan V2), Cotiscan Blockscout, Etherscan — see `hardhat.config.ts` `chainDescriptors`.

## Salt / address family

`inboxSalt.label` (currently `pod.inbox.v2.2`) drives CREATE3 address. Bump the label (and clear salt fields) if Inbox bytecode changes before a fresh mainnet family deploy.
