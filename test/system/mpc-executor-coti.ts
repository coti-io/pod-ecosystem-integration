/**
 * System test: `MpcExecutorCotiTest` on COTI testnet.
 *
 * 1. **Direct `MpcCore`**: `mul*PublicPlain` — setPublic → mul/checkedMul → decrypt (no executor, no `respond`).
 * 2. **`MpcExecutor`**: `executorMul*PublicPlain` — proxy calls `mul*FromPlain` on the executor so `onlyInbox` passes and
 *    **`setPublic*` + `mul` run inside `MpcExecutor`** (COTI MPC precompile ties handles to the executing contract). The proxy
 *    stores `respond` bytes; we decrypt to `lastPlain*`.
 *
 * COTI `decrypt` is not reliable under `eth_call`; use transactions + `read` getters.
 *
 * Requires: `COTI_TESTNET_RPC_URL`, and `COTI_TESTNET_PRIVATE_KEY` or `PRIVATE_KEY`.
 *
 * Run: `npm run test:executor-coti`
 *
 * If COTI RPC returns `contract creation code storage out of gas` or bad `eth_estimateGas` for deploys, set e.g.
 * `MPC_COTI_CONTRACT_DEPLOY_GAS=12000000` (one value used for proxy inbox, executor, and harness deploy txs).
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptWaitOptions } from "./mpc-test-utils.js";

const MOD_256 = 1n << 256n;
const cotiReceiptWaitOptions = { ...receiptWaitOptions, timeout: 900_000 };

/**
 * Some COTI RPCs fail `eth_estimateGas` on heavy `mul256` txs; a modest explicit cap avoids that.
 * Keep limits low enough that `gas * gasPrice` fits typical testnet wallets (very high caps can exceed balance).
 */
/** COTI `mul256` can exceed 15M gas; override with `MPC_COTI_MUL256_GAS` if needed. */
const GAS_MPC_MUL256 = process.env.MPC_COTI_MUL256_GAS?.trim()
  ? BigInt(process.env.MPC_COTI_MUL256_GAS.trim())
  : 50_000_000n;
const GAS_MPC_MUL128 = 12_000_000n;

function mod256Mul(a: bigint, b: bigint): bigint {
  return (a * b) % MOD_256;
}

const cotiRpc = process.env.COTI_TESTNET_RPC_URL?.trim();
const cotiPkRaw =
  process.env.COTI_TESTNET_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();

const canRunCoti = Boolean(cotiRpc && cotiPkRaw);

const deployGasOpt = (() => {
  const raw = process.env.MPC_COTI_CONTRACT_DEPLOY_GAS?.trim();
  if (!raw) return {};
  return { gas: BigInt(raw) };
})();
const deployGas = "gas" in deployGasOpt ? deployGasOpt.gas : undefined;

describe("MpcExecutorCotiTest (COTI)", { concurrency: false, timeout: 900_000 }, async function () {
  if (!canRunCoti) {
    it.skip(
      "set COTI_TESTNET_RPC_URL and COTI_TESTNET_PRIVATE_KEY (or PRIVATE_KEY) to run this file",
      () => {}
    );
    return;
  }

  const { viem } = await network.connect({ network: "cotiTestnet" });
  const cotiChainId = Number.parseInt(process.env.COTI_TESTNET_CHAIN_ID ?? "7082400", 10);
  const cotiChain = defineChain({
    id: cotiChainId,
    name: "COTI Testnet",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: {
      default: { http: [cotiRpc!] },
    },
  });
  const pkHex = (cotiPkRaw!.startsWith("0x") ? cotiPkRaw : `0x${cotiPkRaw}`) as `0x${string}`;
  const account = privateKeyToAccount(pkHex);
  const publicClient = await viem.getPublicClient({ chain: cotiChain });
  const wallet = await viem.getWalletClient(account.address, { chain: cotiChain });

  const deployOpts = { client: { public: publicClient, wallet } } as const;

  let proxyInbox: Awaited<ReturnType<(typeof viem)["deployContract"]>>;
  let harness: Awaited<ReturnType<(typeof viem)["deployContract"]>>;
  let nextNonce: number | undefined;

  const txOpts = async (gas?: bigint) => {
    const gasPrice = await publicClient.getGasPrice();
    if (nextNonce === undefined) {
      nextNonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
    }
    const nonce = nextNonce;
    nextNonce += 1;
    return {
      account: wallet.account,
      gasPrice: gasPrice + (gasPrice * 4n) / 5n + 1n,
      nonce,
      ...(gas === undefined ? {} : { gas }),
    } as const;
  };

  const syncNonceFromError = (err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err);
    const next = message.match(/next nonce (\d+)/i);
    if (next?.[1]) {
      nextNonce = Number(next[1]);
      return true;
    }
    if (message.match(/nonce .*lower than the current nonce/i)) {
      nextNonce = (nextNonce ?? 0) + 1;
      return true;
    }
    return false;
  };

  const withNonceRetry = async <T>(fn: (opts: Awaited<ReturnType<typeof txOpts>>) => Promise<T>, gas?: bigint): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await fn(await txOpts(gas));
      } catch (err) {
        lastError = err;
        if (!syncNonceFromError(err)) {
          throw err;
        }
      }
    }
    throw lastError;
  };

  const simulateOpts = (gas?: bigint) =>
    ({
      account: wallet.account,
      ...(gas === undefined ? {} : { gas }),
    }) as const;

  before(async function () {
    // Split deploy: nested `new MpcExecutor` in one tx exceeds typical testnet gas / estimate limits.
    proxyInbox = await withNonceRetry(
      (opts) => viem.deployContract("MpcExecutorCotiProxyInbox", [], { ...deployOpts, ...opts } as any),
      deployGas
    );
    const executor = await withNonceRetry(
      (opts) => viem.deployContract("MpcExecutor", [proxyInbox.address], { ...deployOpts, ...opts } as any),
      deployGas
    );
    const registerHash = await withNonceRetry((opts) => proxyInbox.write.registerExecutor([executor.address], opts));
    await publicClient.waitForTransactionReceipt({ hash: registerHash, ...cotiReceiptWaitOptions });
    harness = await withNonceRetry(
      (opts) =>
        viem.deployContract(
          "MpcExecutorCotiTest",
          [executor.address, proxyInbox.address],
          { ...deployOpts, ...opts } as any
        ),
      deployGas
    );
  }, { timeout: 900_000 });

  const cOwner = () => harness.address;

  describe("direct MpcCore (reference)", function () {
    async function runMul256Tx(
      name: "mul256PublicPlain" | "checkedMul256PublicPlain",
      a: bigint,
      b: bigint
    ): Promise<bigint> {
      const hash = await withNonceRetry((opts) => harness.write[name]([a, b], opts), GAS_MPC_MUL256);
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        ...cotiReceiptWaitOptions,
      });
      assert.equal(receipt.status, "success", `${name} must succeed (check gas / RPC)`);
      return harness.read.lastPlain256();
    }

    it("mul256PublicPlain wraps mod 2^256", async function () {
      assert.equal(await runMul256Tx("mul256PublicPlain", 3n, 7n), 21n);
      const a = (1n << 128n) - 1n;
      const b = (1n << 128n) - 1n;
      assert.equal(await runMul256Tx("mul256PublicPlain", a, b), mod256Mul(a, b));
      const max = MOD_256 - 1n;
      assert.equal(await runMul256Tx("mul256PublicPlain", max, 2n), max - 1n);
    });

    it("checkedMul256PublicPlain matches mul when no overflow", async function () {
      const a = 12345n;
      const b = 67890n;
      assert.equal(await runMul256Tx("checkedMul256PublicPlain", a, b), a * b);
    });

    it("checkedMul256PublicPlain reverts on uint256 overflow", async function () {
      const max = MOD_256 - 1n;
      await assert.rejects(
        async () => harness.simulate.checkedMul256PublicPlain([max, 2n], simulateOpts(GAS_MPC_MUL256) as any),
        undefined,
        "checkedMul256 must revert when the true product does not fit in uint256"
      );
    });

    it("mul128PublicPlain", async function () {
      const a = 1_000_000n;
      const b = 2_000_000n;
      const hash = await withNonceRetry((opts) => harness.write.mul128PublicPlain([a, b], opts), GAS_MPC_MUL128);
      await publicClient.waitForTransactionReceipt({ hash, ...cotiReceiptWaitOptions });
      assert.equal(await harness.read.lastPlain128(), a * b);
    });

    it("mul64PublicPlain (checked)", async function () {
      const a = 1234n;
      const b = 5678n;
      const hash = await withNonceRetry((opts) => harness.write.mul64PublicPlain([a, b], opts));
      await publicClient.waitForTransactionReceipt({ hash, ...cotiReceiptWaitOptions });
      assert.equal(await harness.read.lastPlain64(), a * b);
    });

    it("mul64PublicPlain reverts on overflow", async function () {
      const a = (1n << 63n) - 1n;
      const b = 4n;
      await assert.rejects(
        async () => harness.simulate.mul64PublicPlain([a, b], simulateOpts() as any),
        undefined,
        "checkedMul64 must revert when the product does not fit in uint64"
      );
    });
  });

  describe("MpcExecutor (proxy inbox + offBoard decrypt in harness)", function () {
    it("deployed executor uses proxy inbox", async function () {
      const execAddr = await harness.read.executor();
      const inboxOnExec = await publicClient.readContract({
        address: execAddr,
        abi: [
          {
            type: "function",
            name: "inbox",
            inputs: [],
            outputs: [{ name: "", type: "address" }],
            stateMutability: "view",
          },
        ],
        functionName: "inbox",
      });
      assert.equal((inboxOnExec as string).toLowerCase(), proxyInbox.address.toLowerCase());
    });

    it("executorMul256PublicPlain matches direct mul256PublicPlain", async function () {
      // `offBoardToUser` + `respond` can revert on COTI for some edge ciphertexts even when direct
      // `decrypt(MpcCore.mul(...))` succeeds; keep executor parity checks to stable inputs.
      const pairs: [bigint, bigint][] = [
        [3n, 7n],
        [(1n << 128n) - 1n, (1n << 128n) - 1n],
      ];
      for (const [a, b] of pairs) {
        const hDirect = await withNonceRetry((opts) => harness.write.mul256PublicPlain([a, b], opts), GAS_MPC_MUL256);
        const rDirect = await publicClient.waitForTransactionReceipt({
          hash: hDirect,
          ...cotiReceiptWaitOptions,
        });
        assert.equal(rDirect.status, "success", "direct mul256PublicPlain");
        const direct = await harness.read.lastPlain256();

        const hExec = await withNonceRetry(
          (opts) => harness.write.executorMul256PublicPlain([a, b, cOwner()], opts),
          GAS_MPC_MUL256
        );
        const rExec = await publicClient.waitForTransactionReceipt({
          hash: hExec,
          ...cotiReceiptWaitOptions,
        });
        assert.equal(rExec.status, "success", "executorMul256PublicPlain");
        const viaExec = await harness.read.lastPlain256();

        assert.equal(
          viaExec,
          direct,
          `executor mul256 vs direct for (${a}, ${b})`
        );
        assert.equal(direct, mod256Mul(a, b));
      }
    });

    it("executorMul128PublicPlain matches direct mul128PublicPlain", async function () {
      const a = 1_000_000n;
      const b = 2_000_000n;
      const h1 = await withNonceRetry((opts) => harness.write.mul128PublicPlain([a, b], opts), GAS_MPC_MUL128);
      const rec1 = await publicClient.waitForTransactionReceipt({ hash: h1, ...cotiReceiptWaitOptions });
      assert.equal(rec1.status, "success", "mul128PublicPlain");
      const direct = await harness.read.lastPlain128();

      const h2 = await withNonceRetry(
        (opts) => harness.write.executorMul128PublicPlain([a, b, cOwner()], opts),
        GAS_MPC_MUL128
      );
      const rec2 = await publicClient.waitForTransactionReceipt({ hash: h2, ...cotiReceiptWaitOptions });
      assert.equal(rec2.status, "success", "executorMul128PublicPlain");
      const viaExec = await harness.read.lastPlain128();

      assert.equal(viaExec, direct);
      assert.equal(direct, a * b);
    });

    it("executorMul64PublicPlain matches direct mul64PublicPlain", async function () {
      const a = 1234n;
      const b = 5678n;
      const h1 = await withNonceRetry((opts) => harness.write.mul64PublicPlain([a, b], opts));
      const rec1 = await publicClient.waitForTransactionReceipt({ hash: h1, ...cotiReceiptWaitOptions });
      assert.equal(rec1.status, "success", "mul64PublicPlain");
      const direct = await harness.read.lastPlain64();

      const h2 = await withNonceRetry((opts) => harness.write.executorMul64PublicPlain([a, b, cOwner()], opts));
      const rec2 = await publicClient.waitForTransactionReceipt({ hash: h2, ...cotiReceiptWaitOptions });
      assert.equal(rec2.status, "success", "executorMul64PublicPlain");
      const viaExec = await harness.read.lastPlain64();

      assert.equal(viaExec, direct);
      assert.equal(direct, a * b);
    });

    it("executor mul64 reverts on overflow (same as direct)", async function () {
      const a = (1n << 63n) - 1n;
      const b = 4n;
      await assert.rejects(async () => harness.simulate.executorMul64PublicPlain([a, b, cOwner()], simulateOpts() as any));
    });
  });
});
