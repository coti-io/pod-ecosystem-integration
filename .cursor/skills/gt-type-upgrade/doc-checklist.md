# gt* Type Upgrade — Documentation Checklist

Use this list when applying the [gt-type-upgrade](SKILL.md) skill. Mark each item after updating.

## Priority 1 — User-facing / contributor docs

| File | What to update |
|------|----------------|
| `README.md` | Mention vendored `MpcCore` (no `@coti-io/coti-contracts`); link to `contracts/PodPattern.md`; note `preferWasm: false` if documenting local compile |
| `contracts/PodPattern.md` | Replace `coti-contracts` GitHub link with `contracts/utils/mpc/MpcCore.sol`; document gt* as value types; note `ctUint256` struct shape; PodToken nonce starts at 1 |
| `package.json` scripts comments (if any) | Remove references to installing `coti-contracts` |

## Priority 2 — Investigation / ops docs

| File | What to update |
|------|----------------|
| `docs/coti-offboard-to-user-investigation.md` | Confirm `decodeCtUint256` / fingerprint wording matches struct `{ ciphertextHigh, ciphertextLow }` (each `ctUint128` = one uint256) |
| `scripts/privacyPortal/README.md` | Any MpcCore import paths or type mentions |
| `.cursor/skills/pod-privacy-portal/reference.md` | pToken balance ciphertext shape; async mint callback nonce behavior |
| `.cursor/skills/inbox-multichain-upgrade/SKILL.md` | No gt* changes required unless examples embed old struct syntax |

## Priority 3 — Audit artifacts (`ai_audit/`)

Update signature tables and prose where they still say:

- `import "@coti-io/coti-contracts/..."`
- `gtUint256 memory` / `gtUint64 memory`
- Old `ctUint128` multi-limb layout inconsistent with current `MpcCore.sol`

High-value audit paths:

| Path | Contracts |
|------|-----------|
| `ai_audit/v1/token/perc20/` | `PodERC20`, `IPodERC20`, `PodErc20CotiSide`, mother |
| `ai_audit/v1/mpc/coti-side/` | `MpcExecutor` |
| `ai_audit/v1/examples/` | `MpcAdder`, `PodAdder128/256`, `Millionaire`, `PodTest*` |
| `ai_audit/v2/` | Top-level audit summary if it lists dependencies |

Add audit note for **PodToken nonce fix**: first callback before fix used nonce `0` and was ignored on PoD; fixed via `INITIAL_TOKEN_NONCE = 1` in `registerToken`.

## Priority 4 — Inline NatSpec / comments (grep-driven)

Run:

```bash
rg 'coti-contracts|gtUint\d+ memory|gtBool memory' contracts/ test/ --glob '*.{sol,ts}'
```

Update any remaining:

- Import comments pointing at npm package
- `@dev` notes describing struct-based gt types
- Test comments describing double-sync workarounds (remove if nonce fix is deployed)

Key Solidity files with nonce / balance mirror docs:

- `contracts/token/perc20/PodERC20.sol` — `transferCallback`, `syncBalancesCallback` NatSpec
- `contracts/token/perc20/cotiside/PodErc20CotiMother.sol` — `_tokenNonce`, `registerToken`, event `nonce` fields

## Priority 5 — External integration docs (if publishing)

When writing changelog or migration guide for downstream teams, include:

### Breaking changes

1. **Dependency:** drop `@coti-io/coti-contracts`; vendor `MpcCore.sol` + `MpcInterface.sol`.
2. **ABI / signatures:** `gt*` parameters are value types — regenerate bindings; remove erroneous `tuple` wrapping where tools assumed structs.
3. **Off-chain decode:** `ctUint128` = one `uint256`; `ctUint256` = two-limb tuple.
4. **PodToken:** first balance mirror requires registration (nonce ≥ 1); do not rely on nonce `0` callbacks.
5. **Compile:** avoid WASM solc for large MPC contracts on arm64.

### Non-breaking clarifications

- `itUint*` structs unchanged for client encrypt paths.
- `MpcCore` API names (`setPublic256`, `offBoardToUser`, `onBoard`, …) unchanged.
- Inbox multichain request-id layout unchanged (see `inbox-multichain-upgrade` skill).

## Verification checklist

After doc pass:

```bash
# No stale package references in markdown
rg 'coti-contracts' --glob '*.md' && echo "FAIL: stale refs" || echo "OK"

npx hardhat compile
npx hardhat test test/tokens/coti-mother.ts
```

Optional full cross-chain:

```bash
npm run test:pp-system
npm run test:pod-token
```

## Template — migration blurb for PR / release notes

```markdown
### MPC gt* type upgrade

- Vendored `MpcCore` / `MpcInterface` under `contracts/utils/mpc/`; removed `@coti-io/coti-contracts`.
- `gtUint*` and `gtBool` are user-defined value types — use without `memory`/`calldata`.
- `ctUint128` is a single `uint256`; `ctUint256` remains a two-limb struct for user decrypt.
- PodToken: COTI callback nonces now start at 1 on pToken registration so the first PoD balance update applies.
- Tests: updated ct decoders and balance read helpers; bump `@coti-io/coti-sdk-typescript` to ^1.0.7.
```
