---
name: gt-type-upgrade
description: >-
  Document and migrate code after the COTI gt* value-type upgrade: vendored MpcCore,
  removed @coti-io/coti-contracts, gtUint* as user-defined value types (not structs),
  ctUint128/256 shape changes, PodToken callback nonce fix, and test harness decoders.
  Use when updating READMEs, PodPattern, audit docs, skills, comments, or external
  integrations after gt-type migration, or when docs still reference coti-contracts
  imports, struct gtUint*, or old ct/it layouts.
---

# gt* Type Upgrade — Documentation & Migration

## When To Use

Apply this skill when:

- Updating **documentation** after the gt* / MpcCore migration in this repo.
- Fixing **stale references** to `@coti-io/coti-contracts`, struct-style `gtUint*`, or old ciphertext shapes.
- Onboarding **external integrators** (apps, indexers, tests) to the new type model.
- Reviewing a PR that touches MPC types, `MpcCore`, `PodERC20`, or COTI-side garbled ops.

For the full change inventory and per-file doc checklist, read [reference.md](reference.md) and [doc-checklist.md](doc-checklist.md).

## What Changed (Summary)

| Area | Before | After |
|------|--------|-------|
| MpcCore source | `@coti-io/coti-contracts` npm package | Vendored `contracts/utils/mpc/MpcCore.sol` + `MpcInterface.sol` |
| `gtUint8`…`gtUint256`, `gtBool` | Often `struct` + `memory`/`calldata` | **User-defined value types** (`type gtUint256 is uint256`) — pass **without** `memory`/`calldata` on gt* |
| `ctUint128` | Struct / array limbs in some paths | `type ctUint128 is uint256` (single limb) |
| `ctUint256` | Varies by upstream version | **Struct** `{ ctUint128 ciphertextHigh; ctUint128 ciphertextLow; }` |
| `itUint*` / `utUint*` | Unchanged conceptually | Still **structs** (`ciphertext` + `signature` or dual ct) |
| `gtString` / `ctString` | — | Still **structs** (UDVT arrays not possible) |
| TS SDK | Older decrypt helpers | `@coti-io/coti-sdk-typescript` `^1.0.7`; use `decryptUint256({ ciphertextHigh, ciphertextLow }, key)` |
| solc (Hardhat) | `path: soljson.js` WASM | Native binary: `preferWasm: false`, no `path` override |
| PodToken PoD mirror | First callback nonce `0` skipped | `PodErc20CotiMother` sets `_tokenNonce[id] = 1` on `registerToken` |

## Documentation Update Workflow

Copy this checklist and track progress:

```
Doc upgrade progress:
- [ ] Step 1: Grep for stale references (see patterns below)
- [ ] Step 2: Update in-repo markdown (doc-checklist.md)
- [ ] Step 3: Update NatSpec / comments in touched Solidity
- [ ] Step 4: Update Cursor skills that embed type or path facts
- [ ] Step 5: Note breaking changes for external consumers
- [ ] Step 6: Verify compile + targeted tests
```

### Step 1 — Find stale references

```bash
rg -l 'coti-contracts|gtUint\d+ memory|gtBool memory|struct gtUint' --glob '*.{md,sol,ts,json}'
rg -l 'github.com/coti-io/coti-contracts' .
```

### Step 2 — Replace link targets

| Stale | Replace with |
|-------|----------------|
| `@coti-io/coti-contracts` import | `import "../utils/mpc/MpcCore.sol"` (adjust relative path) |
| `github.com/coti-io/coti-contracts/.../MpcCore.sol` | In-repo path: `contracts/utils/mpc/MpcCore.sol` |
| `gtUint256 memory x` in **new** code/docs | `gtUint256 x` (value type) |
| `ctUint128` as 4-limb struct in test decoders | Single `uint256` ciphertext (see decoders below) |

### Step 3 — Solidity doc / comment rules

When documenting or reviewing MPC functions:

- **Garbled (MPC-internal):** `gtUint64`, `gtUint128`, `gtUint256`, `gtBool` — value types, assigned and passed like `uint256`.
- **User encrypted inputs:** `itUint256 calldata` — still a struct; keep `calldata`/`memory` as today.
- **User decryptable outputs:** `ctUint256 memory` — struct with `ciphertextHigh` / `ciphertextLow` (`ctUint128` each).
- **COTI-side only:** `MpcCore.onBoard` / `offBoard` / `offBoardToUser` bridge `ct*` ↔ `gt*`.

Document the PodToken nonce rule wherever PoD balance mirroring is explained:

> COTI callback nonces start at **1** when a pToken namespace is registered. PoD applies balance updates only when `balanceNonces[account] < nonce`; both default to `0`, so nonce `0` never applies.

### Step 4 — TypeScript / test documentation

Document these harness patterns for integrators and test authors:

**ctUint128** (executor respond payloads, 128-bit results):

```ts
// abi.encode(ctUint128) → single uint256
decodePodCtUint128Struct(data: `0x${string}`): bigint
```

**ctUint256** (balances, allowances, 256-bit results):

```ts
// abi.encode(ctUint256) → tuple (ciphertextHigh, ciphertextLow)
decodePodCtUint256Struct(data: `0x${string}`): { ciphertextHigh: bigint; ciphertextLow: bigint }
```

**balanceOf on PoD** — viem returns the struct directly; use `decodeCtUint256` then `decryptUint256`.

**Uninitialized PoD balance** — storage default `(0,0)` is not user ciphertext; treat as balance `0` before first mirrored callback (see `readDecryptedBalance` in `test/tokens/test-token-utils.ts`).

**AES key scoping** — reuse `COTI_AES_KEY` / `USER_AES_KEY_*` only when `*_FOR_PRIVATE_KEY` matches the active wallet (`onboardUser` in `test/system/mpc-test-utils.ts`).

### Step 5 — External consumer notes

Add a short “Breaking changes” section when publishing docs:

1. Remove `@coti-io/coti-contracts` dependency; vendor or import from this repo’s `contracts/utils/mpc/`.
2. Regenerate ABI bindings if function signatures changed (`gt*` param locations).
3. Update off-chain decoders for `ctUint128` / `ctUint256` shapes.
4. Expect first PodToken sync/mint callback to use nonce ≥ 1 after registration.

### Step 6 — Verify

```bash
npx hardhat compile
npx hardhat test test/tokens/coti-mother.ts
npm run test:pp-system          # PP_SYSTEM_TESTS=1
npm run test:pod-token          # POD_TOKEN_SYSTEM_TESTS=1 (optional, long)
```

## Solidity Migration Patterns

### Imports

```solidity
// Old
import "@coti-io/coti-contracts/contracts/utils/mpc/MpcCore.sol";

// New
import "../../utils/mpc/MpcCore.sol";
```

### gt* parameters and locals

```solidity
// Old
function foo(gtUint256 memory value) internal { ... }
gtUint256 memory a = MpcCore.setPublic256(x);

// New
function foo(gtUint256 value) internal { ... }
gtUint256 a = MpcCore.setPublic256(x);
```

### ctUint256 still uses memory struct

```solidity
ctUint256 memory ct = MpcCore.offBoard(garbled);
// ct.ciphertextHigh, ct.ciphertextLow — both ctUint128 (uint256)
```

## Examples

**PodPattern.md** — change the MpcCore link from `coti-contracts` GitHub to `contracts/utils/mpc/MpcCore.sol` and add one line that gt* garbled types are value types on COTI.

**README.md** — add a “Dependencies” or “MPC types” subsection: vendored MpcCore, no `coti-contracts` npm package, pointer to `contracts/PodPattern.md`.

**Audit docs under `ai_audit/`** — update any signature tables listing `gtUint256 memory` → `gtUint256`; flag nonce-0 PodToken issue as fixed via `INITIAL_TOKEN_NONCE`.

## Additional Resources

- [reference.md](reference.md) — type layout reference, affected contracts, test files
- [doc-checklist.md](doc-checklist.md) — per-document update list for this repo
