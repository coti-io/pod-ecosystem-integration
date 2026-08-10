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
  → FeeManager (CREATE3; Inbox DELEGATECALL target — every chain)
  → MpcAbiReEncode (CREATE3; COTI only)
  → Inbox (CreateX CREATE3+init with helper addresses; same address family)
  → PriceOracle (+ seed feeds / manual prices + refreshCache)
  → feeConfig (min-fee templates) + gasPriceBounds
  → wireInboxOracle
  → configureRoles / miners
  → MpcAdder (source) + MpcExecutor (COTI)
  → configureAdder (point adder at COTI executor)
```

The `inbox` deploy target CREATE3-deploys **FeeManager** (and on COTI **MpcAbiReEncode**) before atomic Inbox init. Apps and CMS still configure **only the Inbox address**; record `chains.<id>.feeManager` in deployConfig for ops/verification.
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
  maxStaleness: 0            # 0 = disable on-chain age check (prefer non-zero in prod)
  feeds:
    inboxLocal:
      bandBase: "ETH"        # or "AVAX"
      bandQuote: "USDC"      # pegged quote, not a pure USD index
    collateral:
      USDC: { pegUsd: "1" }
      WETH:
        bandBase: "ETH"
        bandQuote: "USDC"
```

**maxStaleness:** `0` intentionally disables the on-chain age check (upstream Band/Chainlink validity may still apply). Prefer a non-zero value in production unless the feed already encodes expiry.

**Band quotes:** default quote symbol is a **USDC/USDT-style peg**, not a pure USD index. Collateral fee math inherits that peg dependency.

**Oracle health:** inbox fee sends stay fail-open on non-zero cache. Operators monitor `getPricesUSDWithMeta` / `getOracleHealth` and may run a refresh/alert bot (see pod-explorer oracle health docs).

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

## Fee config (required before traffic)

Inbox storage starts with **zero** min-fee templates. Until `updateMinFeeConfigs` runs, creates that validate fees will not work as intended. There is **no** atomic constructor fee init this wave — fees are an explicit post-deploy step.

**Procedure (every chain):**

1. Deploy Inbox (+ oracle seed / `wireInboxOracle` as needed).
2. Ensure `chains.<id>.feeConfig.local` / `.remote` and `chains.<id>.gasPriceBounds` are set in deployConfig (SoT).
3. Run CLI target **`feeConfig`** — applies `updateMinFeeConfigs` and `setGasPriceBounds` from that config.
4. Verify with `--verify-all` (or `verify:deployments`) that on-chain templates and bounds match deployConfig.
5. Only then open the lane to users / miners.

Constant-fee legs must also clear the worst-case floor assert (`constantFee ≥ priced execution + max-size ingest`). Variable legs must keep `errorLength ≤ 256` (on-chain returndata cap).

`chains.<id>.feeConfig.local` / `.remote` — min-fee templates applied by `feeConfig` target.

`chains.<id>.gasPriceBounds` — **required in deployConfig** (no silent inbox defaults). On COTI (non-EIP-1559) also require a non-zero ceiling:

```yaml
gasPriceBounds:
  minPriorityFeeWei: "0"
  minGasPriceWei: "2000000000"
  maxGasPriceWei: "50000000000"   # 0 disables ceiling on EIP-1559 sources only
```

## Verify

```bash
DEPLOY_CONFIG=deployConfig.mainnet.yaml DEPLOY_CLI_NETWORK=avalanche npm run deploy:cli -- --verify-all
DEPLOY_CONFIG=deployConfig.mainnet.yaml DEPLOY_CLI_NETWORK=cotiMainnet npm run deploy:cli -- --verify-all
```

Explorers: Snowscan (Etherscan V2), Cotiscan Blockscout, Etherscan — see `hardhat.config.ts` `chainDescriptors`.

## Salt / address family (SoT)

**Single source of truth:** `deployConfig.*.yaml` (or `deployConfig.json`).

| Field | Role |
| --- | --- |
| `inboxSalt.label` | CREATE3 salt family (e.g. `pod.inbox.v2.3`) — **required**; never a code constant |
| `inboxSalt.salt` / `guardedSalt` / `address` | Resolved deterministic inputs (CLI persists these after precompute) |
| `feeManagerSalt.label` | CREATE3 salt for {FeeManager} (every chain; DELEGATECALL target) — bump independently when FeeManager bytecode changes |
| `mpcAbiCodecSalt.label` | CREATE3 salt for {MpcAbiReEncode} (COTI only) — bump independently of inboxSalt |
| `chains.<id>.inbox` | Deployed Inbox address for that chain (must match CREATE3 prediction for the label) |
| `chains.<id>.feeManager` | Deployed FeeManager (ops/verification; not a second dApp binding) |

Consumers (SDK defaults, network docs, scripts) **derive** salt/address from this config — do not invent a second hardcoded inbox address. Bump `inboxSalt.label` (and clear salt/guardedSalt/address) if Inbox bytecode changes before a fresh address-family deploy. `feeManagerSalt.label` and `mpcAbiCodecSalt.label` are independent.

After inbox deploy, verify explorer stubs: fee admin methods still appear on Inbox, and `inbox.feeManager()` points at the deployed FeeManager.