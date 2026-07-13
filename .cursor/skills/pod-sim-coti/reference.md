# simCOTI Reference

## What simCOTI Replaces

| Live COTI | simCOTI |
|-----------|---------|
| Garbled MPC precompile @ `0x64` | `SimExtendedOperations` injected via `hardhat_setCode` |
| AES + RSA onboarding | Deterministic AES from `(privateKey, chainId)` + fake RSA shares |
| Contract-scoped `gt*` handles | SimState cells keyed by `msg.sender` |
| Native IT signature verify | ECDSA over sim IT hash (69-byte sig: selector + ECDSA) |

Decrypted values and revert conditions should match; ciphertext bytes will not.

## Precompile Injection Flow

1. Deploy `SimState` (holds gt cells, user keys, hints).
2. Deploy `SimExtendedOperations` (logic).
3. Deploy `SimPrecompileProxy` pointing at state + impl.
4. `hardhat_setCode(MPC_PRECOMPILE, proxyRuntimeBytecode)`.

Entry point: `injectSimCotiPrecompile(viem)` in `simCOTI/hardhat/injectPrecompile.ts`. Idempotent per viem instance.

## Hardhat Networks

| Name | Type | Chain ID | Role |
|------|------|----------|------|
| `hardhat` | EDR | 31337 | Sepolia / source-chain surrogate |
| `simCoti` | EDR | 7082401 | Local COTI MPC side |
| `localSepolia` | HTTP | 31337 | Optional node mode @ 8545 |
| `localSimCoti` | HTTP | 7082401 | Optional node mode @ 8546 |
| `cotiTestnet` | HTTP | 7082400 | Live COTI (when `COTI_BACKEND=testnet`) |

Plugin: `simCOTI/hardhat/plugin.js` registered in root `hardhat.config.ts`.

## Package Layout

```
simCOTI/
  contracts/
    SimState.sol              External storage (EDR 0x64 fix)
    SimPrecompileProxy.sol    Delegatecall shell @ 0x64
    SimExtendedOperations.sol Fake ExtendedOperations (Phase 1 + 2)
    SimAccountOnboard.sol     Onboard wrapper
  sdk/
    index.js                  SimWallet, deriveSimAesKey, decrypt helpers
    crypto.js                 simEncrypt*, buildSimItSignature
  hardhat/
    injectPrecompile.ts       Main injection API
    injectPrecompileEthers.ts Hardhat 2 / ethers path (coti-contracts)
  test/
    smoke.test.ts             Minimal precompile round-trip
    parity.test.ts            Behavioral parity checks
```

Integration repo mirrors contracts to `contracts/simCOTI/` via `scripts/link-contracts.sh`.

## Test Harness (`test/sim-coti/sim-coti-utils.ts`)

### Network lifecycle

- `resolveSimCotiNetworkMode()` — `inprocess` (default) or `node`.
- `startSimCotiNetworks({ mode?, sepoliaPort?, cotiPort? })` — returns `{ sepoliaViem, cotiViem, stop? }`.
- `initSimCoti(cotiViem)` — alias for `injectSimCotiPrecompile`.
- `resetSimCotiNetworks()` — clear caches + stop spawned nodes.

### Crypto helpers

- `deriveUserAesKey(pk, chainId?)` — deterministic sim AES key.
- `registerUserOnSim(cotiViem, address, aesKey)` — required before `ValidateCiphertext`.
- `onboardSimUser(cotiViem, pk)` — derive + register in one call.
- `createSimWallet(pk, aesKey?)` — encrypt/decrypt client.
- `encryptUint64|128|256(...)` / `decryptUint64|128|256(...)` — typed wrappers.
- `setupSimCrypto(...)` — used internally by `setupContext` when `COTI_BACKEND=sim`.

### Full context

- `createSimCotiContext({ podAdderContractName?, reuseContracts? })` — networks + precompile + PoD deploys via `setupContext`. Caches per test file.
- `forceSimCotiBackend()` — sets `COTI_BACKEND=sim`.

## Backend Resolution

`simCOTI/test/coti-network.ts`:

- `resolveCotiBackend()` — `sim` unless `COTI_BACKEND=testnet`.
- `resolveCotiNetworkName()` — `simCoti` or `cotiTestnet`.
- `isSimCotiBackend()`.

`test/system/mpc-test-utils.ts` branches on backend for crypto setup (sim vs live SDK).

## npm Scripts

```json
"test:sim-coti": "COTI_BACKEND=sim hardhat test simCOTI/test/smoke.test.ts simCOTI/test/parity.test.ts test/sim-coti/mpc-adder.ts test/sim-coti/mpc-adder-128.ts test/sim-coti/mpc-adder-256.ts test/sim-coti/mpc-adder-retry-pausable.ts test/sim-coti/inbox-raise.ts test/sim-coti/mpc-executor-coti.ts",
"test:coti-testnet": "COTI_BACKEND=testnet hardhat test test/system/mpc-adder.ts"
```

Other gated suites (pod-token, privacy) may set `COTI_BACKEND=sim` via `test/sim-coti/*` wrappers.

### IT256 encryption

`buildEncryptedInput256(ctx, value, opts?)` in `test/system/mpc-test-utils.ts`:

| Option | Default | When to override |
|--------|---------|------------------|
| `validatingContract` | `inboxCoti.address` | Direct COTI tx where `msg.sender` is the calling contract |
| `functionSelector` | `batchProcessRequests(...)` | Must match selector embedded in IT signature bytes |

Sim SDK: `buildSimIt256CtBytes(high, low)` in `simCOTI/sdk/crypto.ts` — always 64 bytes.

## Shared Spec Pattern

Extract backend-agnostic tests into `test/shared/*.spec.ts`:

```typescript
export function registerMyTests(opts: {
  getContext: () => Promise<TestContext>;
  onContext?: (ctx: TestContext) => void;
}) { /* it(...) blocks */ }
```

Runners:

- `test/sim-coti/*.ts` — always sim (`createSimCotiContext`).
- `test/system/*.ts` — `resolveCotiNetworkName()` for sim or testnet.

## Limitations

- Sim IT signatures are 69 bytes; live COTI uses native 65-byte precompile verification.
- String MPC ops deferred until a suite needs them.
- `CheckedMul256` overflow: `a != 0 && prod / a != b`.
- Validated IT handles for Inbox→Executor use global scope (`address(0)`).
- Do not expect byte-identical ciphertext vs testnet.

## Extraction to Standalone Package

`simCOTI/` is self-contained (`package.json`, contracts, sdk). To publish:

1. Copy `simCOTI/` as repo root → `@coti-io/sim-coti`.
2. Consumer adds dependency + `simCoti` network + `injectSimCotiPrecompile` in test setup.

`coti-contracts` already has a file dependency and `simCotiHardhat2.ts` helpers for Hardhat 2.
