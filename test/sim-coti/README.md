# sim-coti test runners

Thin entry points that set `COTI_BACKEND=sim` and load the matching system/gated test module.

## CI suite (`npm run test:sim-coti`)

| Runner | Status |
|--------|--------|
| `mpc-adder.ts` | ✅ shared spec + `createSimCotiContext` |
| `mpc-adder-128.ts` | ✅ incl. large 128-bit values |
| `mpc-adder-256.ts` | ✅ IT256 validate + cross-chain add256 |
| `mpc-adder-retry-pausable.ts` | ✅ |
| `inbox-raise.ts` | ✅ |
| `mpc-executor-coti.ts` | ✅ |
| `simCOTI/test/smoke.test.ts`, `parity.test.ts` | ✅ unit/smoke (includes IT256 round-trip) |

## Cloned — run manually (not in CI yet)

| Runner | Blocker |
|--------|---------|
| `millionaire.ts` | `Millionaire.sol` not in linked contracts |
| `mpc-pod-ops.ts` | `PodTest64/128/256.sol` not in linked contracts |
| `privacy-portal-system.ts` | partial — multi-step / transfer flows still flaky in sim |
| `pod-token.ts` | partial — 7+ cases pass (incl. encrypted mint); transfer pending-state issues remain |
| `pod-token-late-onboard.ts` | late-onboard + state isolation |

```bash
# Example: run a manual sim clone
COTI_BACKEND=sim PP_SYSTEM_TESTS=1 npx hardhat test test/sim-coti/privacy-portal-system.ts
COTI_BACKEND=sim POD_TOKEN_SYSTEM_TESTS=1 npx hardhat test test/sim-coti/pod-token.ts
```

### IT256 signing notes

- **Inbox / pod-token paths:** `buildEncryptedInput256(ctx, value)` defaults to `inboxCoti` + `batchProcessRequests` selector.
- **Direct COTI contract writes:** pass the validating contract address + function selector embedded in the IT signature:

```typescript
await buildEncryptedInput256(ctx, amount, {
  validatingContract: cotiContractAddress,
  functionSelector: toFunctionSelector("myMethod(/* itUint256 arg types */)"),
});
```

See `.cursor/skills/pod-sim-coti/` for harness API and architecture.
