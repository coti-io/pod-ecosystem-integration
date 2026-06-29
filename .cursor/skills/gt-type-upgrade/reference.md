# gt* Type Upgrade — Reference

## Vendored MPC Core

| File | Role |
|------|------|
| `contracts/utils/mpc/MpcCore.sol` | Types (`gt*`, `ct*`, `it*`, `ut*`) + `MpcCore` library |
| `contracts/utils/mpc/MpcInterface.sol` | Precompile / interface bindings used by `MpcCore` |

**Removed dependency:** `@coti-io/coti-contracts` (no longer in `package.json`).

**Kept dependency:** `@coti-io/coti-sdk-typescript` `^1.0.7` for off-chain encrypt/decrypt in tests and tooling.

## Type Layout (current `MpcCore.sol`)

### Value types (no `memory` / `calldata` on gt* / narrow ct*)

```solidity
type gtBool is uint256;
type gtUint8 is uint256;
type gtUint16 is uint256;
type gtUint32 is uint256;
type gtUint64 is uint256;
type gtUint128 is uint256;
type gtUint256 is uint256;

type ctBool is uint256;
type ctUint8 is uint256;
type ctUint16 is uint256;
type ctUint32 is uint256;
type ctUint64 is uint256;
type ctUint128 is uint256;
```

### Struct types (keep `memory` / `calldata`)

```solidity
struct ctUint256 {
    ctUint128 ciphertextHigh;
    ctUint128 ciphertextLow;
}

struct itUint256 {
    ctUint256 ciphertext;
    bytes signature;
}
// itUint128, itUint64, … — same pattern (ct + signature)
```

### Strings (still structs)

`gtString`, `ctString` use `gtUint64[]` / `ctUint64[]` arrays because Solidity UDVTs cannot wrap dynamic arrays.

## Role of each type family

| Family | Where | Purpose |
|--------|-------|---------|
| `gt*` | COTI MPC execution | Garbled / secret-shared values in `MpcCore.*` ops |
| `ct*` | Cross-chain payloads, PoD storage | User-specific or system ciphertext |
| `it*` | PoD client → COTI | User-encrypted input + signature |
| `ut*` | Tests / advanced flows | Dual ciphertext (system + user) |

## Contracts importing vendored MpcCore

All use relative `import ".../utils/mpc/MpcCore.sol"`:

- `contracts/mpc/coti-side/MpcExecutor.sol`, `MpcExecutorCotiTest.sol`, `IPodExecutorOps.sol`
- `contracts/mpc/PodLibBase.sol`, `PodLib64.sol`, `PodLib128.sol`, `PodLib256.sol`
- `contracts/mpccodec/MpcAbiCodec.sol`
- `contracts/token/perc20/IPodERC20.sol`, `PodERC20.sol`
- `contracts/token/perc20/cotiside/IPodErc20CotiSide.sol`, `PodErc20CotiMother.sol`
- `contracts/examples/**` (MpcAdder, PodAdder128/256, PodTest*, Millionaire)
- `contracts/mocks/**` (codec harnesses, probes, mocks)

## PodToken callback nonce fix

**File:** `contracts/token/perc20/cotiside/PodErc20CotiMother.sol`

```solidity
uint256 private constant INITIAL_TOKEN_NONCE = 1;
// registerToken:
_tokenNonce[id] = INITIAL_TOKEN_NONCE;
```

**PoD consumer:** `contracts/token/perc20/PodERC20.sol`

- `transferCallback`, `syncBalancesCallback` apply balance ciphertext when `balanceNonces[account] < nonce`.
- Document that COTI nonces start at 1 post-registration so the first callback applies.

## Hardhat / compile

**File:** `hardhat.config.ts` (and `hardhat.config.chain1.ts`, `chain2.ts`)

- `solidity.version`: `0.8.28`
- `preferWasm: false` — use native solc on linux-arm64
- **Do not** set `solidity.path` to `soljson.js` (WASM OOM on aarch64 with large `MpcCore.sol`)

## Test harness changes

| File | Change |
|------|--------|
| `test/system/mpc-test-utils.ts` | `decodePodCtUint128Struct` → single `uint256`; `decodePodCtUint256Struct` → `{ ciphertextHigh, ciphertextLow }`; `resolveCotiTestnetPrivateKey`, scoped `onboardUser` AES keys |
| `test/system/mpc-pod-ops.ts` | Uses updated decoders for respond payloads |
| `test/tokens/test-token-utils.ts` | `readDecryptedBalance` treats uninitialized `(0,0)` ct as `0n` |
| `test/privacy/privacy-portal-system-utils.ts` | Single `seedZeroBalanceOnPod` sync (nonce fix makes double-sync unnecessary) |
| `hardhat.config.ts` | `collectTestPrivateKeys()` registers all env-funded wallets |

## TypeScript decoder reference

```ts
// 128-bit ct from abi.encode — one word
export const decodePodCtUint128Struct = (data: `0x${string}`): bigint => {
  const [v] = decodeAbiParameters([{ type: "uint256", name: "ciphertext" }], data);
  return v as bigint;
};

// 256-bit ct from abi.encode — tuple
export const decodePodCtUint256Struct = (data: `0x${string}`) => {
  const [t] = decodeAbiParameters([{
    type: "tuple",
    components: [
      { name: "ciphertextHigh", type: "uint256" },
      { name: "ciphertextLow", type: "uint256" },
    ],
  }], data);
  return t as { ciphertextHigh: bigint; ciphertextLow: bigint };
};

// balanceOf / allowance ct from contract read
export const decodeCtUint256 = (encryptedResult: unknown) => ({
  ciphertextHigh: BigInt(getTupleField(encryptedResult, "ciphertextHigh", 0) ?? 0),
  ciphertextLow: BigInt(getTupleField(encryptedResult, "ciphertextLow", 1) ?? 0),
});
```

## Gated system tests

| Env flag | Test file |
|----------|-----------|
| `PP_SYSTEM_TESTS=1` | `test/privacy/privacy-portal-system.ts` |
| `POD_TOKEN_SYSTEM_TESTS=1` | `test/tokens/pod-token.ts` |
| `POD_TOKEN_LATE_ONBOARD_TESTS=1` | `test/tokens/pod-token-late-onboard.ts` |

Run cross-chain suites with `{ concurrency: 1 }` and sequential file execution to avoid COTI nonce / wallet contention.
