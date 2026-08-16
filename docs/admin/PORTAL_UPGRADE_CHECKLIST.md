# Privacy Portal upgrade checklist

Operational runbook for upgrading a **Privacy Portal** clone while keeping the same pToken (no COTI mother re-registration).

Canonical code (sibling [coti-contracts](../../coti-contracts)): `PrivacyPortalFactory.createPortalWithExistingPToken`, `PrivacyPortal.retireDepositsForUpgrade`, `PodErc20Mintable.setMinter`.

Related: [PORTAL_PAUSE_RESCUE_RUNBOOK.md](./PORTAL_PAUSE_RESCUE_RUNBOOK.md) for custodial pause → in-flight withdraw → full pause → sized rescue.

## Goals

- Upgrade portal logic (new implementation) without replacing the pToken or re-registering on the mother.
- Keep pToken holders redeemable against a single collateral pool after admin migrates funds.
- Soft sequencing: freeze old portal → remount → migrate → open new portal.

## Preconditions

- [ ] Factory admin (`DEFAULT_ADMIN_ROLE`) and operator keys available.
- [ ] New `PrivacyPortal` implementation deployed and verified.
- [ ] **Old portal implementation already exposes** `retireDepositsForUpgrade`, `pause` / `paused`, and (for native) `nativeWrappedUnderlying`. Minimal clones permanently point at the impl used at clone time — `setPortalImplementation` does **not** upgrade existing clones. Remount only works if the *current* old clone already has these entrypoints (i.e. you are remounting from an impl that already includes this feature set, or this is a fresh factory deployment).
- [ ] Confirm pToken `owner()` is this factory (`PTokenNotOwnedByFactory` otherwise).
- [ ] Note current addresses: `portalForUnderlying`, `pTokenForUnderlying`, balances, fee overrides, limits.
- [ ] If the portal is **native-wrapped** (WAVAX/WETH wrap path): remount **must** keep `nativeWrappedUnderlying = true` (ERC20-only WETH mode is rejected). Wrap mode cannot flip either direction on remount.
- [ ] Communicate maintenance window: deposits/withdrawals unavailable on this underlying until new portal is unpaused.
- [ ] **Cross-factory handoff:** before `transferPTokenOwnership` to another factory, pause and drain the source factory’s portal; the destination attach path does not pause the source portal.

## M-31 — Never remount with in-flight withdraw / rescue

Withdraw callbacks encode the **portal address at request time**. After remount + collateral move, a success callback still targets the **old** portal; release can fail and the user is stuck. This is an **ops-only** control (no protocol remount API change in this wave).

**Hard gate before `createPortalWithExistingPToken` / `retireDepositsForUpgrade` / sized rescue that empties the old vault:**

- [ ] Pause deposits early (`isDepositEnabled = false` and/or full `pause()`).
- [ ] Inventory all pending withdrawals / TransferPending / `pendingBurnAmount` on the old portal.
- [ ] Finalize or kill every in-flight withdraw (and any mid-flight rescue) until pending set is empty.
- [ ] Confirm no open PoD request still expects a withdraw callback to the old portal.
- [ ] Only then remount with the existing pToken; migrate collateral; open the new portal.

**Never** remount while withdraw or rescue is mid-flight. Prefer delaying remount over stranding users.

## Fee / limit state (not auto-carried)

Remount deploys a **fresh** portal clone. The following are **not** copied from the old portal:

| State | Old portal | New portal after remount |
|-------|------------|---------------------------|
| Deposit / withdraw fee overrides | Kept on old (unused) | Factory defaults until re-set |
| Min/max deposit & withdraw limits | Kept on old | Defaults (`min=1`, `max=type(uint256).max`) |
| Per-portal blacklist | Kept on old | Empty (factory blacklist still applies) |
| `accumulatedPortalFees` | Stays on old — sweep before or after via admin | Starts at 0 |
| `pendingBurnAmount` / in-flight burns | Stays on old | Starts at 0 |

**Before opening the new portal**, re-apply any intentional overrides/limits on the new clone (portal admin/operator setters). Document the chosen values in the change ticket.

## Step-by-step

### 1. Freeze the old portal

- [ ] `oldPortal.pause()` (factory admin) — blocks deposits **and** withdrawals.
- [ ] Confirm `oldPortal.paused() == true`.
- [ ] Optional: snapshot ERC20/native balances and pending escrow / withdrawal IDs.

Remount **reverts** with `OldPortalNotPaused` if this step is skipped.

### 2. Rotate implementation (if upgrading logic)

- [ ] `factory.setPortalImplementation(newImpl)`.
- [ ] Do **not** rotate `podTokenImplementation` expecting existing pTokens to change — remount keeps the same pToken instance.

### 3. Remount

```text
factory.createPortalWithExistingPToken(underlying, existingPToken, nativeWrappedUnderlying)
```

Effects:

- Requires old portal paused.
- Calls `retireDepositsForUpgrade` on old: `isDepositEnabled = false`, **`factory` cleared to `address(0)`** (deposits can never be re-enabled via `setIsDepositEnabled`).
- Clones + initializes new portal; **`pauseByFactory()`** so new starts paused.
- `pToken.setMinter(newPortal)`.
- Updates `portalForUnderlying` / `portalForPToken` to the new portal.
- Emits `PortalCreated` and `PortalReplaced`.

- [ ] Verify maps point at new portal; `pToken.minter() == newPortal`.
- [ ] Verify `oldPortal.factory() == address(0)` and `oldPortal.bindingFactory() == factory`.
- [ ] Verify `oldPortal.unpause()` reverts (`FactoryNotConfigured`) — detached portals stay closed.
- [ ] Verify `newPortal.paused() == true`.
- [ ] Record `PortalReplaced` old/new addresses for indexers and support.

### 4. Migrate funds (admin)

Soft model: no on-chain atomic sweep. Typical path while old remains paused:

- [ ] Sweep portal fees from old if needed: `withdrawPortalFees`.
- [ ] `oldPortal.rescueERC20(underlying, amount)` / `rescueNative` → `rescueRecipient`.
- [ ] Transfer rescued collateral into **new** portal address (so withdrawable backing matches pToken supply expectations).
- [ ] Handle residual: failed-mint refunds on old (`refundFailedDeposit` still works without active factory binding), pending burns on old (batch burn / finalize on old as needed).
- [ ] Confirm old underlying balance is at the intended residual (ideally dust-only) before opening new.

### 5. Re-apply config on new portal

- [ ] Fee overrides / limits / portal blacklist as required (see table above).
- [ ] Sanity-check `estimateDepositFees` / `estimateWithdrawFees` on the new portal.

### 6. Open the new portal

- [ ] `newPortal.unpause()` (factory admin).
- [ ] Spot-check deposit + withdraw on a small amount.
- [ ] Update UI / SDK / docs addresses to the new portal (factory lookups already return it).

### 7. Post-upgrade

- [ ] Keep old portal paused; it is detached (`factory == 0`) and cannot re-enable deposits.
- [ ] Indexers: treat `PortalReplaced` as the cutover; do not send users to the old portal for new flow.
- [ ] Monitor mother / mint success rates after cutover.

## Failure / rollback notes

- **Remount without pause:** reverts; no state change.
- **Native → ERC20 remount:** reverts `NativePortalRequiresNative` / `NativeWrapMismatch`.
- **Unpause new before migrate:** users may withdraw against incomplete collateral or deposit into an underfunded pool — **do not skip step 4**.
- **Rollback:** there is no automatic remount-back. Would require another remount to a previous impl (again pause → remount → migrate), or leave traffic on the new portal and fix forward.

## Interfaces

| Consumer | Interface |
|----------|-----------|
| Portal clones (fees, pause flags, blacklist) | `IPrivacyPortalFactory` |
| Ops / upgrade tooling | `IPrivacyPortalFactoryAdmin` |
| Portal instance | `IPrivacyPortal` |

## Related tests

- Unit (coti-contracts): `test/pod/privacy/PrivacyPortalFactory.portalRemount.test.ts`, `PrivacyPortalFactory.createPortalWithExistingPToken.test.ts`
- E2E (this repo): `npm run test:pp-remount` → `test/privacy/privacy-portal-remount-system.ts`
