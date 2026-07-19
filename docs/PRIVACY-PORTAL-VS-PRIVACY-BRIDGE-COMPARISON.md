# PrivacyPortal vs PrivacyBridge — admin / operator surface

Role model (not 1-1):

| Concern | PrivacyBridge (PB) | Privacy Portal (PP) |
|---------|--------------------|---------------------|
| Admin | `Ownable.owner` (+ `DEFAULT_ADMIN_ROLE`) on the bridge | Factory `DEFAULT_ADMIN_ROLE` via `isAdmin` (portal has no Ownable) |
| Operator | `OPERATOR_ROLE` on the bridge | Factory `OPERATOR_ROLE` via `isOperator` |
| Scope | Per-bridge instance | Factory roles apply to **all** portals |

## Admin / operator function map

| Functionality | Function in PB | Function in PP Factory | Function in PP instance |
|---------------|----------------|------------------------|-------------------------|
| Pause user flows | `pause()` (`onlyOwner`) | `pause()` (`DEFAULT_ADMIN_ROLE`) — pauses deposits/withdrawals on all portals | `pause()` (`onlyFactoryAdmin`) — this portal only |
| Unpause user flows | `unpause()` (`onlyOwner`) | `unpause()` (`DEFAULT_ADMIN_ROLE`) | `unpause()` (`onlyFactoryAdmin`) |
| Add blacklist entry | `addToBlacklist(account)` (`onlyOwner`) | `addToBlacklist(account)` (`DEFAULT_ADMIN_ROLE`) — factory-wide | `addToBlacklist(account)` (`onlyFactoryAdmin`) — portal-local |
| Remove blacklist entry | `removeFromBlacklist(account)` (`onlyOwner`) | `removeFromBlacklist(account)` (`DEFAULT_ADMIN_ROLE`) | `removeFromBlacklist(account)` (`onlyFactoryAdmin`) |
| Per-tx deposit/withdraw limits | `setLimits(minDeposit, maxDeposit, minWithdraw, maxWithdraw)` (`onlyOwner`) | | `setLimits(...)` (`onlyFactoryAdmin`) |
| Soft-disable deposits | `setIsDepositEnabled(enabled)` (`onlyOperator`) | | `setIsDepositEnabled(enabled)` (`onlyFactoryOperator`) |
| Deposit fee parameters | `setDepositDynamicFee(fixed, bps, max)` (`onlyOperator`) | `setDefaultDepositFee(...)` (`OPERATOR_ROLE`) | `setDepositFee(...)` (`onlyFactoryOperator`) — per-portal override |
| Withdraw fee parameters | `setWithdrawDynamicFee(fixed, bps, max)` (`onlyOperator`) | `setDefaultWithdrawFee(...)` (`OPERATOR_ROLE`) | `setWithdrawFee(...)` (`onlyFactoryOperator`) — per-portal override |
| Clear deposit fee override | | | `clearDepositFeeOverride()` (`onlyFactoryOperator`) |
| Clear withdraw fee override | | | `clearWithdrawFeeOverride()` (`onlyFactoryOperator`) |
| Set price oracle | `setPriceOracle(oracle)` (`onlyOwner`) | `setPriceOracle(oracle)` (`DEFAULT_ADMIN_ROLE`) | |
| Set max oracle age / staleness | `setMaxOracleAge(maxOracleAge)` (`onlyOwner`) | | |
| Sweep accumulated protocol fees | `withdrawCotiFees(amount)` / native `withdrawFees(amount)` (`onlyOwner`) | | `withdrawPortalFees(amount)` (`onlyFactoryAdmin`) |
| Rescue native (paused) | `rescueNative(amount)` (`onlyOwner`, whenPaused) | | `rescueNative(amount)` (`onlyFactoryAdmin`, whenPaused) |
| Rescue ERC20 (paused) | `rescueERC20(token, amount)` (`onlyOwner`, whenPaused) | | `rescueERC20(token, amount)` (`onlyFactoryAdmin`, whenPaused) |
| Rotate fee recipient | *(immutable at deploy)* | *(immutable at deploy)* | |
| Rotate rescue recipient | *(immutable at deploy)* | `setRescueRecipient(addr)` (`DEFAULT_ADMIN_ROLE`) | |
| Grant / revoke operator | `addOperator` / `removeOperator` (`DEFAULT_ADMIN_ROLE`) | `grantRole` / `revokeRole` (`OPERATOR_ROLE`) | |
| Transfer admin / ownership | `transferOwnership(newOwner)` (`onlyOwner`; revokes all roles then re-grants to new owner) | `grantRole` / `revokeRole` (`DEFAULT_ADMIN_ROLE`) | |
| Allow / deny portal deployers | | `setDeployer(deployer, allowed)` (`DEFAULT_ADMIN_ROLE`) | |
| Create portal + pToken | | `createPortal(...)` (`onlyDeployer`) | |
| Configure inbox / COTI routing | | `configureRouting(inbox, cotiChainId, mother)` (`DEFAULT_ADMIN_ROLE`) | |
| Reconfigure existing pToken peers | | `configurePToken(pToken, inbox, cotiSide)` (`DEFAULT_ADMIN_ROLE`) | |
| Transfer pToken Ownable | | `transferPTokenOwnership(pToken, newOwner)` (`DEFAULT_ADMIN_ROLE`) | |
| Batch-burn pending private supply | | | `burnAccumulatedPTokens(amount, burnCallbackFee)` (`onlyFactoryAdmin`) |

## Notes

- PB fee and rescue destinations are fixed at construction. PP fee recipient is also fixed at factory deploy; rescue recipient can still be rotated via `setRescueRecipient`.
- PP fee knobs are split: factory defaults for new quotes, optional per-portal overrides (+ clear back to defaults).
- PP has dual pause and dual blacklist (factory + instance). Either pause/blacklist path can block users.
- Portal instance admin/operator checks always read live factory roles (`isAdmin` / `isOperator`); there is no per-portal Ownable.
