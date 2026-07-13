# simCOTI — Local COTI MPC Simulator

simCOTI runs PoD COTI-side MPC tests on Hardhat EDR without live testnet RPC. It injects a fake `ExtendedOperations` implementation at precompile address `0x64` and pairs it with a lightweight test SDK for encrypt/decrypt/onboard.

**Agent skill:** `.cursor/skills/pod-sim-coti/` (SKILL.md, reference.md, examples.md).

## Architecture

Hardhat EDR does **not** persist contract storage at address `0x64`. simCOTI uses:

```
0x64 (SimPrecompileProxy) --delegatecall--> SimExtendedOperations
                      \-- reads/writes --> SimState (external storage)
```

1. **SimState** — external contract holding gt cells, user AES keys, and hints
2. **SimExtendedOperations** — logic contract (delegatecall target)
3. **SimPrecompileProxy** — bytecode injected at `0x64` via `hardhat_setCode`

## What it simulates

| Real COTI | simCOTI |
|-----------|---------|
| Garbled MPC precompile @ `0x64` | `SimExtendedOperations` bytecode via `hardhat_setCode` |
| AES + RSA onboarding | Deterministic AES key + fake RSA shares |
| `gt*` contract-scoped handles | Precompile storage keyed by `msg.sender` |
| `validateCiphertext` | ECDSA over sim IT hash + additive ciphertext |

**Not real cryptography** — additive obfuscation only. Use for CI/local tests, not security validation.

## Usage

Two modes — set via npm scripts (not mixed):

```bash
# Sim: Hardhat Sepolia surrogate + simCoti, both in-process (CI default)
npm run test:sim-coti

# Live: Hardhat Sepolia surrogate + COTI testnet RPC
npm run test:coti-testnet
```

| Mode | `COTI_BACKEND` | COTI network | Test location |
|------|----------------|--------------|---------------|
| Sim (default) | `sim` | `simCoti` (7082401) | `test/sim-coti/`, `simCOTI/test/` |
| Testnet | `testnet` | `cotiTestnet` (7082400) | `test/system/` |

## Minimal example

```typescript
import { network } from "hardhat";
import { injectSimCotiPrecompile, MPC_PRECOMPILE } from "./hardhat/injectPrecompile.js";
import { aesKeyToBigInt, deriveSimAesKey, SimWallet, SIM_COTI_CHAIN_ID } from "./sdk/index.js";

const { viem } = await network.connect({ network: "simCoti" });
await injectSimCotiPrecompile(viem);

const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const aesKey = deriveSimAesKey(pk, SIM_COTI_CHAIN_ID);
const wallet = new SimWallet(pk, { send: async () => null } as any, {
  chainId: SIM_COTI_CHAIN_ID,
  aesKey,
});

const sim = await viem.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
await sim.write.simRegisterUserKey([wallet.address, aesKeyToBigInt(aesKey)]);
// wallet.encryptValue(...) → contract ValidateCiphertext → decryptSimUint(...)
```

More examples: `.cursor/skills/pod-sim-coti/examples.md`.

## Integration harness

Full PoD dual-chain tests use `test/sim-coti/sim-coti-utils.ts`:

- `createSimCotiContext()` — networks + precompile + inbox/executor deploys
- `startSimCotiNetworks()` — `inprocess` (default) or `node` (8545/8546)

See `test/sim-coti/mpc-adder.ts` for a complete runner.

## Package layout

```
simCOTI/
  contracts/     SimExtendedOperations, SimAccountOnboard, smoke harness
  sdk/           SimWallet, encrypt/decrypt helpers
  hardhat/       injectPrecompile, network config, plugin
  test/          smoke + parity tests
```

## Environment

| Variable | Default | Purpose |
|----------|---------|---------|
| `COTI_BACKEND` | `sim` | `sim` or `testnet` |
| `SIM_COTI_NETWORK_MODE` | `inprocess` | `inprocess` or `node` |
| `COTI_REUSE_CONTRACTS` | — | Skip redeploy when `true` |

## Extraction

This folder is self-contained (`package.json`, contracts, sdk). To move to a separate repo:

1. Copy `simCOTI/` as repo root
2. Publish `@coti-io/sim-coti`
3. Consumer repos add `file:` or npm dependency and register `simCoti` network + `injectSimCotiPrecompile`

## Limitations

- Sim IT signatures are 69 bytes (`selector` + ECDSA); live COTI uses native precompile verification (65-byte sig)
- IT256 supported: digest uses 64-byte `encodePacked(high, low)` matching on-chain validation
- Behavioral parity targets decrypted results and revert conditions, not byte-identical ciphertext
- String MPC ops deferred until a gated suite requires them
