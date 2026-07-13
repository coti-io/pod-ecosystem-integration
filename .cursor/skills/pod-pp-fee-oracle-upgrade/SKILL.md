---
name: pod-pp-fee-oracle-upgrade
description: >-
  Migrate Privacy Portal UI from the pre-fee/oracle version. Use when upgrading
  deposit/withdraw integrations, calculating portal fees plus PoD inbox fees,
  reading live ETH/AVAX prices from PoDPriceOracle on Sepolia or Fuji, or when
  the user mentions portal fee, oracle pricing, estimateDepositFees,
  estimateWithdrawFees, or upgrading an older PrivacyPortal integration.
---

# Privacy Portal Fee + Oracle Upgrade (UI)

## When To Use

Use this skill when a UI was built against **pre-fee / pre-oracle** Privacy Portal and must be updated for:

- New `portalFee` argument on deposit and withdraw.
- Combined quoting: **portal protocol fee** + **PoD inbox fee** (from `pToken.estimateFee`).
- Live USD prices via `PoDPriceOracle` (Band on Sepolia, Chainlink on Fuji).

For async request lifecycle, permit signing, and polling patterns, also read the sibling skill `pod-privacy-portal` (`reference.md`, `ui-patterns.md`). **Do not** copy fee helpers from older `ui-patterns.md` — they predate portal fees and inline burn fees on withdraw.

## What Changed (Summary)

| Area | Old UI | New UI |
|------|--------|--------|
| ERC20 deposit args | `(recipient, amount, mintCallbackFee)` | `(recipient, amount, portalFee, mintCallbackFee)` |
| ERC20 deposit `value` | `mintTotalFee` | `portalFee + mintTotalFee` |
| Native deposit `value` | `amount + mintTotalFee` | `amount + portalFee + mintTotalFee` |
| Withdraw args | included `burnFee`, `burnCallbackFee` | `(recipient, amount, portalFee, transferFee, transferCallbackFee, permit…)` — **no burn in user tx** |
| Withdraw `value` | `transferFee + burnFee` | `portalFee + transferTotalFee` |
| Fee quote source | `pToken.estimateFee()` only | **Portal:** `estimateDepositFees` / `estimateWithdrawFees` index `[0]` (portal fee only). **PoD:** inbox `calculateTwoWayFeeRequiredInLocalToken` with `getGasPrice()` |
| Burn | user paid burn in same withdraw tx | owner/keeper calls `burnAccumulatedPTokens` separately |

Portal fees can be **dynamic** when factory fee config has `percentageBps > 0` and the factory's `priceOracle` returns live USD rates.

## Upgrade Checklist

1. **Refresh ABIs** from current `PrivacyPortal`, `PrivacyPortalFactory`, `IPodPriceOracle` (vendored under `pod-ecosystem-integration/contracts/` after `npm run link:contracts`).
2. **Replace fee quoting** — quote **portal fee** and **PoD inbox fee** separately; sum for `msg.value`. Do not use `pToken.estimateFee()` or the PoD legs of `portal.estimateDepositFees` via plain `readContract` (see § PoD fee pitfall below).
3. **Add `portalFee` to writeContract args** — pass the quoted `portalFee`; set `value` to portal + PoD totals (see table above).
4. **Remove burn fee from withdraw UI** — drop burn lines from fee breakdown and `requestWithdrawWithPermit` args; optionally show admin `pendingBurnAmount` / `estimateBatchBurnFees` for ops dashboards only.
5. **Wire oracle display (optional)** — read `factory.priceOracle()` → `getLivePrices(nativeToken, underlying)` for live ETH/AVAX and collateral USD in the fee preview.
6. **Load addresses from `deployConfig.json`** — not stale `PrivacyPortalConfig.json` snapshots.

## Fee Model

Two independent fee layers; the UI sums them for `msg.value`:

```
totalNativeFee = portalFee + podInboxTotalFee
```

- **Portal fee (`portalFee`)** — protocol fee retained by the portal/factory. From packed fee config (`fixedFee`, `percentageBps`, `maxFee`) and live oracle when `percentageBps > 0`. Quote via `portal.estimateDepositFees(amount)[0]` (or `[portalFee, usedDynamicPricing, ,]`).
- **PoD inbox fee (`mintTotalFee` / `transferTotalFee`)** — native fee for the pToken async inbox request. Quote via **inbox** `calculateTwoWayFeeRequiredInLocalToken` with **current gas price**, not `pToken.estimateFee()` in a read call.

### PoD fee pitfall (`tx.gasprice = 0`)

`pToken.estimateFee()` (and therefore `mintTotalFee` / `transferTotalFee` inside `estimateDepositFees` / `estimateWithdrawFees`) passes **`tx.gasprice`** to the inbox. In `eth_call`, Etherscan read, and typical `readContract` calls, gas price is **0** → PoD legs show **0**. Portal fee (index 0) is still correct.

**UI must quote PoD fees with an explicit gas price:**

```ts
const gasPrice = await publicClient.getGasPrice();
const [targetFeeWei, callbackFeeWei] = await publicClient.readContract({
  address: inbox,
  abi: inboxFeeAbi,
  functionName: "calculateTwoWayFeeRequiredInLocalToken",
  args: [512n, 512n, 300_000n, 300_000n, gasPrice],
});
const podTotalFee = targetFeeWei + callbackFeeWei;
```

Constants match `PodERC20` (`FEE_ESTIMATE_*`).

### Combined quote (deposit)

```ts
const [portalFee, usedDynamic] = await publicClient.readContract({
  address: portal,
  abi: privacyPortalAbi,
  functionName: "estimateDepositFees",
  args: [amount],
}).then(([pf, dyn]: [bigint, boolean]) => [pf, dyn] as const);

const pod = await quotePodInboxFee(publicClient, pToken, podPTokenAbi);
const msgValue = portalFee + pod.totalFeeWei; // ERC20 deposit
// depositNative: value = amount + portalFee + pod.totalFeeWei
```

Pass `pod.callbackFeeWei` as `mintCallbackFee` / `transferCallbackFee`; pass `portalFee` explicitly.

### Portal fee can be zero

Factory deploy defaults are often `fixedFee = 0`, `percentageBps = 0` — portal fee stays **0** until factory owner calls `setDefaultDepositFee` / `setDefaultWithdrawFee`. Oracle presence alone does not enable dynamic fees without non-zero `percentageBps`.

### Portal fee formula (when dynamic)

Mirrors `PrivacyPortalFeeLib.resolvePortalFee`:

1. `txValueUsd = amount * collateralUsd / 10^decimals`
2. `percentageFeeUsd = txValueUsd * percentageBps / 1_000_000`
3. `percentageFeeNative = percentageFeeUsd * 1e18 / nativeUsd`
4. `fee = max(fixedFee, percentageFeeNative)` capped at `maxFee`

If `percentageBps == 0` or either oracle rate is `0`, fee falls back to `fixedFee` only (`usedDynamicPricing == false`).

On-chain validation: `portalFee` must be `>= floor` and `<= maxFee` from effective config (portal override or factory default).

## Oracle Reads (Sepolia + Fuji)

Read live prices through **`PoDPriceOracle`** (same contract for portal factory and inbox on each chain). UI typically resolves:

```ts
const factory = portalFactoryAddress; // from deployConfig
const [oracle, nativeToken] = await Promise.all([
  publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "priceOracle" }),
  publicClient.readContract({ address: factory, abi: factoryAbi, functionName: "nativeToken" }),
]);
const underlying = await publicClient.readContract({ address: portal, abi: portalAbi, functionName: "underlying" });

const [nativeUsd, collateralUsd] = await publicClient.readContract({
  address: oracle,
  abi: podPriceOracleAbi,
  functionName: "getLivePrices",
  args: [nativeToken, underlying],
});
// Each price is 18-decimal USD per 1 whole token (1e18 ≈ $1.00)
```

| Chain | Chain ID | Oracle adapter | Native token (portal) | Live adapter (debug) |
|-------|----------|----------------|-------------------------|----------------------|
| Sepolia | `11155111` | Band | WETH `0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9` | BandLiveOracle |
| Fuji | `43113` | Chainlink | WAVAX `0xd00ae08403B9bbb9124bB305C09058E32C39A48c` | ChainlinkLiveOracle |

Current deployed addresses: **`deployConfig.json`** → `chains.<chainId>.priceOracle`, `privacyPortalFactory`, `oracle.liveAdapter`.

**Sanity checks:** ETH/AVAX spot roughly $1k–$10k (18-decimal scale); USDC ≈ `1e18`. Zero price means feed unset/stale — portal fee reverts to fixed-only; show a warning in UI.

Direct single-token read: `getLivePrice(token)`.

## Read Next

- `reference.md` — ABI diffs, revert reasons, factory/oracle wiring, address map.
- `examples.md` — full viem deposit/withdraw + oracle price display snippets.

## Related

- `pod-privacy-portal` — end-to-end PP UI (lifecycle, events, polling).
- `scripts/oracle-tokens.ts` — native/collateral token constants per chain.
- `scripts/privacyPortal/canonical-collateral.ts` — official testnet underlying addresses.
