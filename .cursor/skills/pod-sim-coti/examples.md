# simCOTI Minimal Examples

## 1. Run tests

```bash
# All sim tests (smoke, parity, adder, executor-coti)
npm run test:sim-coti

# Live COTI testnet adder only
npm run test:coti-testnet

# Single file
COTI_BACKEND=sim npx hardhat test test/sim-coti/mpc-adder.ts
```

## 2. Precompile smoke (encrypt → validate → decrypt)

Minimal pattern from `simCOTI/test/smoke.test.ts`:

```typescript
import { network } from "hardhat";
import { toFunctionSelector } from "viem";
import { injectSimCotiPrecompile, MPC_PRECOMPILE } from "../hardhat/injectPrecompile.js";
import {
  SimWallet,
  aesKeyToBigInt,
  deriveSimAesKey,
  decryptSimUint,
  SIM_COTI_CHAIN_ID,
} from "../sdk/index.js";

const { viem } = await network.connect({ network: "simCoti" });
await injectSimCotiPrecompile(viem);

const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const userKey = deriveSimAesKey(pk, SIM_COTI_CHAIN_ID);
const wallet = new SimWallet(pk, { send: async () => null } as any, {
  chainId: SIM_COTI_CHAIN_ID,
  aesKey: userKey,
});

const simOps = await viem.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
await simOps.write.simRegisterUserKey([wallet.address, aesKeyToBigInt(userKey)]);

const harness = await viem.deployContract("SimSmokeHarness", []);
const selector = toFunctionSelector("validateAndStore((uint256,bytes))");
const it = await wallet.encryptValue(42n, harness.address, selector);

await harness.write.validateAndStore([it]);
const ct = await harness.read.storedCiphertext();
const plain = decryptSimUint(ct, userKey, 128);
// plain === 42n
```

## 3. Onboard with harness helpers

```typescript
import { network } from "hardhat";
import {
  initSimCoti,
  onboardSimUser,
  createSimWallet,
  encryptUint128,
  decryptUint128,
} from "../../test/sim-coti/sim-coti-utils.js";

const { viem: cotiViem } = await network.connect({ network: "simCoti" });
await initSimCoti(cotiViem);

const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const { userKey } = await onboardSimUser(cotiViem, pk);
const wallet = createSimWallet(pk, userKey);

const target = "0x0000000000000000000000000000000000000001";
const sel = "0x12345678";
const it = await encryptUint128(wallet, 100n, target, sel);
const plain = decryptUint128(it.ciphertext, userKey);
```

## 4. Dual-chain PoD test (sim-only runner)

```typescript
import { afterEach, describe } from "node:test";
import { collectInboxFeesAfterTest, type TestContext } from "../system/mpc-test-utils.js";
import { registerMpcAdderTests } from "../shared/mpc-adder.spec.js";
import { createSimCotiContext } from "./sim-coti-utils.js";

describe("MyFeature (sim-coti)", { concurrency: 1 }, function () {
  let ctx: TestContext;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  registerMpcAdderTests({
    getContext: () => createSimCotiContext(),
    onContext: (c) => { ctx = c; },
  });
});
```

Add the file path to `test:sim-coti` in `package.json` for CI.

## 5. System test (sim or testnet via env)

```typescript
import { network } from "hardhat";
import { resolveCotiNetworkName, setupContext } from "../system/mpc-test-utils.js";

const { viem: sepoliaViem } = await network.connect({ network: "hardhat" });
const { viem: cotiViem } = await network.connect({ network: resolveCotiNetworkName() });

const ctx = await setupContext({ sepoliaViem, cotiViem });
// Works with COTI_BACKEND=sim (default) or COTI_BACKEND=testnet
```

## 6. Optional external Hardhat nodes

```bash
SIM_COTI_NETWORK_MODE=node COTI_BACKEND=sim npx hardhat test test/sim-coti/mpc-adder.ts
```

Spawns nodes on `8545` (Sepolia surrogate) and `8546` (simCoti). Default `inprocess` is faster for CI.

## 7. Reuse deployed contracts (faster iteration)

```typescript
process.env.COTI_REUSE_CONTRACTS = "true";
const ctx = await createSimCotiContext({ reuseContracts: true });
```

Skips redeploy when addresses are still valid in the same Hardhat session.
