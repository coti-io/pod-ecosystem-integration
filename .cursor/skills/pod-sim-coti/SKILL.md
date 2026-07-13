---
name: pod-sim-coti
description: Run PoD COTI-side MPC tests locally with simCOTI (fake precompile @ 0x64, SimWallet SDK, dual-chain Hardhat). Use when writing or debugging sim COTI tests, COTI_BACKEND, test/sim-coti, injectSimCotiPrecompile, SimWallet encrypt/decrypt, or avoiding live COTI testnet RPC.
---

# simCOTI Local Testing

## When To Use

| Goal | Use |
|------|-----|
| CI / fast local PoD dual-chain tests | `COTI_BACKEND=sim` (default) |
| Validate against live COTI testnet | `COTI_BACKEND=testnet` |
| Unit-test precompile / encrypt round-trip only | `simCOTI/test/smoke.test.ts` pattern |
| Full PoD inbox + executor flows | `test/sim-coti/*` or `test/system/*` |

**simCOTI is not real cryptography** — additive obfuscation for behavioral parity (decrypted results, reverts). Do not use for security validation.

## Quick Start

```bash
# Sim suite (no live COTI RPC)
npm run test:sim-coti

# Live COTI testnet (requires RPC + keys)
npm run test:coti-testnet
```

**`test:sim-coti` CI (30 passing):** smoke (incl. IT256), parity, mpc-adder 64/128/256, retry-pausable, inbox-raise, executor-coti.  
**Cloned manual runners** (partial pod-token / privacy): see `test/sim-coti/README.md`.

## Two Test Modes (Do Not Mix)

1. **Sim** — Sepolia surrogate (`hardhat`, chain `31337`) + simCoti (`7082401`), both in-process EDR.
2. **Testnet** — Sepolia surrogate + live `cotiTestnet` RPC.

Pick mode via npm script or `COTI_BACKEND=sim|testnet`. Put sim-only runners under `test/sim-coti/`; testnet runners under `test/system/`.

## Architecture (Essential)

Hardhat EDR does **not** persist storage at `0x64`. simCOTI injects bytecode there via `hardhat_setCode`:

```
0x64 (SimPrecompileProxy) --delegatecall--> SimExtendedOperations
                      \-- reads/writes --> SimState (external storage)
```

Package: `simCOTI/` (`contracts/`, `sdk/`, `hardhat/injectPrecompile.ts`).

## Writing Tests

### Pattern A — Full PoD context (recommended)

Use `createSimCotiContext()` from `test/sim-coti/sim-coti-utils.ts` for deployed inbox/executor + sim crypto:

```typescript
import { createSimCotiContext } from "./sim-coti-utils.js";

const ctx = await createSimCotiContext();
// ctx.sepoliaViem, ctx.cotiViem, ctx.cotiEncryptWallet, deployed contracts…
```

See `test/sim-coti/mpc-adder.ts` + `test/shared/mpc-adder.spec.ts` for the shared-spec pattern.

### Pattern B — Precompile smoke only

Connect `simCoti`, call `injectSimCotiPrecompile`, onboard user, encrypt/decrypt. See `simCOTI/test/smoke.test.ts`.

### Pattern C — System tests with backend switch

`test/system/mpc-adder.ts` uses `resolveCotiNetworkName()` so the same spec runs on sim or testnet depending on `COTI_BACKEND`.

## Key APIs

| Export | Role |
|--------|------|
| `injectSimCotiPrecompile(viem)` | Deploy SimState + inject proxy @ `0x64` |
| `onboardSimUser(cotiViem, pk)` | Derive AES key + register on precompile |
| `createSimWallet(pk, aesKey)` | Client-side encrypt/decrypt |
| `startSimCotiNetworks()` | Dual-chain viem handles (inprocess or node) |
| `createSimCotiContext()` | Full PoD test harness (sim-only) |
| `registerMpcAdderTests({ getContext })` | Shared dual-chain adder spec |
| `buildEncryptedInput256(ctx, value, opts?)` | IT256 encrypt; optional `validatingContract` / `functionSelector` for direct COTI txs |

Constants: `MPC_PRECOMPILE = 0x…64`, `SIM_COTI_CHAIN_ID = 7082401`.

### IT256 (`buildEncryptedInput256`)

Default signing context is the COTI inbox (`batchProcessRequests`) — correct for cross-chain pod ops and pod-token flows validated in `MpcAbiCodec`.

For direct COTI contract calls (validation with `msg.sender = calling contract`), override:

```typescript
await buildEncryptedInput256(ctx, amount, {
  validatingContract: cotiContractAddress,
  functionSelector: toFunctionSelector("myMethod(/* … */)"),
});
```

SDK digest bytes use `encodePacked(uint256, uint256)` (64 bytes) to match on-chain `SimExtendedOperations`.

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `COTI_BACKEND` | `sim` | `sim` or `testnet` |
| `SIM_COTI_NETWORK_MODE` | `inprocess` | `inprocess` or `node` (8545/8546) |
| `COTI_REUSE_CONTRACTS` | — | Skip redeploy when `true` |

## Adding a New Sim Test

1. Create `test/sim-coti/my-feature.ts`.
2. Call `forceSimCotiBackend()` or rely on `createSimCotiContext()`.
3. Reuse shared specs in `test/shared/` when logic is backend-agnostic.
4. Add the file to `test:sim-coti` in `package.json` if it should run in CI.

## Read Next

- [reference.md](reference.md) — architecture, limitations, file map, Hardhat networks
- [examples.md](examples.md) — minimal copy-paste snippets
- [simCOTI/README.md](../../../simCOTI/README.md) — package-level overview
