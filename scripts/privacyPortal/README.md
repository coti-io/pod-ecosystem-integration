# Privacy Portal Deployment Scripts

All scripts use the existing Hardhat network config and `deployConfig.json` inbox addresses unless an env override is supplied.

## Supported collateral (Sepolia + Fuji)

| Private pToken | Sepolia underlying | Fuji underlying | Test funds |
|----------------|------------------|-----------------|------------|
| pMTT | Mock MTT (deployed) | Mock MTT (deployed) | minted by deploy-cli |
| pUSDC | Circle USDC `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | Circle USDC `0x5425890298aed601595a70AB815c96711a31Bc65` | [Circle Faucet](https://faucet.circle.com) |
| pWETH | WETH `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` | — | wrap Sepolia ETH via `deposit()` |
| pWAVAX | — | WAVAX `0xd00ae08403B9bbb9124bB305C09058E32C39A48c` | [Fuji AVAX faucet](https://core.app/tools/testnet-faucet/) + `deposit()` |

Canonical addresses live in `canonical-collateral.ts` (shared with `deploy-cli.ts`).

### Native ETH / AVAX (wrap / unwrap in-contract)

When the factory creates a portal with `nativeWrappedUnderlying = true` (pWETH / pWAVAX):

**Deposit — one transaction:**

```solidity
portal.depositNative(recipient, amount, mintCallbackFee) payable
// msg.value = amount + mintFee  (mintFee forwarded to pToken.mint)
```

The portal calls `WETH.deposit{value: amount}()` / `WAVAX.deposit{value: amount}()` internally, then mints pTokens.

**Withdraw — unwrap in release:**

After the pToken transfer succeeds, `_releaseWithdrawal` calls `underlying.withdraw(amount)` and forwards native coin to the recipient. No separate unwrap tx for the user.

ERC-20 `{deposit}` remains available if the user already holds WETH/WAVAX.

## Interactive deploy CLI

```bash
npm run deploy:cli
```

PP token targets (per chain): underlying setup → portal factory → COTI mother → portal clone.

- **Mock** (pMTT): deploys `MockERC20Decimals` and mints 1M to deployer.
- **Canonical** (pUSDC, pWETH, pWAVAX): records the official ERC-20 address from `canonical-collateral.ts`.

### Verification flags

By default the CLI verifies each contract on the block explorer right after it deploys.

```bash
# Deploy without verifying (verify later); the menu header shows "verification: OFF".
npm run deploy:cli -- --noverify

# Verify every deployed-but-unverified contract on the selected network, then exit.
npm run deploy:cli -- --verify-all
```

- `--noverify` skips the post-deploy explorer verification step (deploys still record addresses).
- `--verify-all` walks all configured contracts for the chosen network, skips ones already verified, verifies the rest, and exits (no interactive menu). Combine with `DEPLOY_CLI_NETWORK=<net>` for non-interactive/CI runs.
- Env equivalents (handy in CI): `DEPLOY_CLI_NOVERIFY=1`, `DEPLOY_CLI_VERIFY_ALL=1`.

## Factories

```bash
npx hardhat run scripts/privacyPortal/deploy-source-factory.ts --network sepolia
npx hardhat run scripts/privacyPortal/deploy-coti-mother.ts --network cotiTestnet
```

Or deploy both via `deploy-cli` targets (`PpFactory`, `PpCotiMother`, …).

Useful env:

- `SOURCE_NETWORK` defaults to `sepolia`
- `COTI_NETWORK` defaults to `cotiTestnet`
- `FACTORY_OWNER` defaults to deployer (also used as `PodErc20CotiMother` owner on deploy)
- `SOURCE_INBOX`, `COTI_INBOX`, or `INBOX` override `deployConfig.json`
- `COTI_CHAIN_ID` defaults to the connected COTI chain for two-network scripts

### PpMotherAllow fails on COTI

`setAllowedFactory` is `onlyOwner`. The deploy-cli signs with the **on-chain mother owner** (`PRIVATE_KEY` / `0xdF9F…` if that account deployed the mother).

If you see `gas required exceeds allowance (2993)` (or a similar small number), the owner key is usually correct but the account is **out of COTI for gas**. On COTI testnet that number is roughly `balance / gasPrice` — your owner has ~0.000025 COTI but the tx needs ~50k gas (~0.0004 COTI at current prices).

1. Fund `0xdF9F8FcA4591227C092FCBAb45A846C19fb6d1ae` via the COTI testnet faucet (Discord: `testnet <address>`).
2. Or send COTI from a funded wallet (e.g. miner `MINER_ADDRESS` / `0x075445…` in `.env`) to the mother owner.
3. Re-run **PpMotherAllow** on COTI Testnet.

The deploy-cli now pre-checks balance and reports `Insufficient native balance for gas` instead of the opaque RPC error.

## Per-token Deployment

Deploy the full token pair (mother registration is automatic via factory):

```bash
UNDERLYING_TOKEN=0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238 \
PTOKEN_NAME="Private USDC" \
PTOKEN_SYMBOL="pUSDC" \
PTOKEN_DECIMALS=6 \
npx hardhat run scripts/privacyPortal/deploy-token.ts
```

All deployed addresses are printed and appended to `deployment.log`.

## Sync Token List

`PrivacyPortalConfig.json` is the reference config for supported portal tokens. Example entry:

```json
{
  "erc20": "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  "name": "Private USDC",
  "symbol": "pUSDC",
  "decimals": 6,
  "privacyPortal": "",
  "pToken": ""
}
```

Then run:

```bash
npm run deploy:privacy:sync
```

The sync script deploys missing factories/mother, creates portal + pToken clones, and writes addresses back to `PrivacyPortalConfig.json`.

Use `PRIVACY_PORTAL_CONFIG=path/to/file.json` to sync a different config file.
