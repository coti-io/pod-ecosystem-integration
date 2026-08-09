# Privacy Portal pause / rescue runbook

Custodial pause and rescue are **admin process**, not an on-chain timelock. Use a multisig; size drains carefully against outstanding obligations.

## Recommended sequence

1. **Pause deposits** (or set `isDepositEnabled=false` / soft-disable) so no new escrow opens.
2. **Allow in-flight withdrawals** to complete (users with TransferPending / pending burns).
3. **Full pause** once deposits are stopped and withdrawals have drained or been cancelled.
4. **Rescue / drain** only what is safe:
   - Collateral balance minus outstanding deposit escrows, pending burns, and known in-flight withdraw amounts.
   - Do not assume `balance == free liquidity`.
5. Document the drain amount, remaining obligations, and who authorized the rescue.

## Notes

- There is no in-contract delay on admin pause/rescue this wave — ops discipline is the control.
- Stuck Pending deposits after mother registration lag: use `adminRefundPendingDeposit` (invalidates pending mint first).
- Stuck Pending pToken approvals/transfers: owner may `killStaleRequest` after `requestKillMinAge`; portal escrow still needs portal-side recovery if collateral is locked.
