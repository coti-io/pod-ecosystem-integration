/**
 * Fork dry-run version of `mpc-executor-coti.ts`.
 *
 * Targets **sim-coti** from `npm run fork:cli -- setup` (default `http://127.0.0.1:8546`,
 * sim-coti-mainnet chain `2632500`, MPC precompile `@0x64`). No `.env` / deployConfig
 * required — uses Hardhat account #0 (pre-funded by sim-coti).
 *
 * Prerequisites: Anvil source is optional for this suite; **sim-coti must be up**:
 *   cd pod-ecosystem-integration
 *   npm run fork:cli -- setup --source avalanche --coti mainnet
 *   npm run test:executor-fork
 *
 * Live testnet suite remains: `npm run test:executor-coti`.
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { defineChain, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptWaitOptions } from "./mpc-test-utils.js";
import { deriveUserAesKey, registerUserOnSim } from "../sim-coti/sim-coti-utils.js";

const MOD_256 = 1n << 256n;
const cotiReceiptWaitOptions = { ...receiptWaitOptions, timeout: 300_000 };

/** Hardhat mnemonic account #0 — funded by sim-coti-node. */
const HH_ACCOUNT0_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

const DEFAULT_SIM_RPC = "http://127.0.0.1:8546";
/** sim-coti-mainnet (default), sim-coti-testnet, or legacy sim profile. */
const ACCEPTED_SIM_CHAIN_IDS = new Set([2632500, 7082400, 7082401]);
const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064" as const;

const GAS_MPC_MUL256 = process.env.MPC_COTI_MUL256_GAS?.trim()
  ? BigInt(process.env.MPC_COTI_MUL256_GAS.trim())
  : 50_000_000n;
const GAS_MPC_MUL128 = 12_000_000n;

function mod256Mul(a: bigint, b: bigint): bigint {
  return (a * b) % MOD_256;
}

type ProbeOk = { ok: true; rpc: string; chainId: number };
type ProbeFail = { ok: false; reason: string };

const rpcJson = async (rpc: string, method: string, params: unknown[] = []): Promise<unknown> => {
  const res = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (body.error) throw new Error(body.error.message || "rpc error");
  return body.result;
};

const probeSimCotiFork = async (): Promise<ProbeOk | ProbeFail> => {
  const rpc = process.env.SIM_COTI_RPC_URL?.trim() || DEFAULT_SIM_RPC;
  try {
    const chainHex = (await rpcJson(rpc, "eth_chainId")) as string;
    const chainId = Number.parseInt(chainHex, 16);
    if (!ACCEPTED_SIM_CHAIN_IDS.has(chainId)) {
      return {
        ok: false,
        reason:
          `${rpc} chainId=${chainId} (want sim-coti 2632500/7082400/7082401). ` +
          `Run: npm run fork:cli -- setup --coti mainnet`,
      };
    }
    const code = (await rpcJson(rpc, "eth_getCode", [MPC_PRECOMPILE, "latest"])) as string;
    if (!code || code === "0x") {
      return {
        ok: false,
        reason: `MPC precompile missing at ${MPC_PRECOMPILE} on ${rpc}. Run: npm run fork:cli -- setup`,
      };
    }
    return { ok: true, rpc, chainId };
  } catch (err) {
    return {
      ok: false,
      reason: `sim-coti not reachable at ${rpc} (${err instanceof Error ? err.message : String(err)}). Run: npm run fork:cli -- setup`,
    };
  }
};

const probe = await probeSimCotiFork();

describe("MpcExecutorCotiTest (fork / sim-coti)", { concurrency: false, timeout: 600_000 }, async function () {
  if (!probe.ok) {
    it.skip(probe.reason, () => {});
    return;
  }

  // Pin env so Hardhat `localSimCoti` matches the probed RPC (no deployConfig needed).
  process.env.SIM_COTI_RPC_URL = probe.rpc;
  process.env.SIM_COTI_CHAIN_ID = String(probe.chainId);

  const { viem } = await network.connect({ network: "localSimCoti" });
  const cotiChain = defineChain({
    id: probe.chainId,
    name: "simCoti (fork dry-run)",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: { default: { http: [probe.rpc] } },
  });
  const account = privateKeyToAccount(HH_ACCOUNT0_PK);
  const publicClient = await viem.getPublicClient({ chain: cotiChain });
  const wallet = await viem.getWalletClient(account.address, { chain: cotiChain });

  const bal = await publicClient.getBalance({ address: account.address });
  if (bal === 0n) {
    it.skip(`Hardhat #0 ${account.address} has 0 balance on sim-coti — re-run fork:cli setup`, () => {});
    return;
  }

  const deployOpts = { client: { public: publicClient, wallet } } as const;
  const deployGas = process.env.MPC_COTI_CONTRACT_DEPLOY_GAS?.trim()
    ? BigInt(process.env.MPC_COTI_CONTRACT_DEPLOY_GAS.trim())
    : undefined;

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

  const syncNonceFromError = async (err: unknown): Promise<boolean> => {
    const message = err instanceof Error ? err.message : String(err);
    const next = message.match(/next nonce (\d+)/i);
    if (next?.[1]) {
      nextNonce = Number(next[1]);
      return true;
    }
    if (/nonce too high|nonce .*lower than the current nonce|expected nonce to be/i.test(message)) {
      nextNonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
      return true;
    }
    return false;
  };

  const withNonceRetry = async <T>(
    fn: (opts: Awaited<ReturnType<typeof txOpts>>) => Promise<T>,
    gas?: bigint
  ): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        return await fn(await txOpts(gas));
      } catch (err) {
        lastError = err;
        if (!(await syncNonceFromError(err))) throw err;
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
    console.log(
      `[executor-fork] sim-coti ${probe.rpc} chainId=${probe.chainId} signer=${account.address}`
    );
    proxyInbox = await withNonceRetry(
      (opts) => viem.deployContract("MpcExecutorCotiProxyInbox", [], { ...deployOpts, ...opts } as any),
      deployGas
    );
    const executor = await withNonceRetry(
      (opts) => viem.deployContract("MpcExecutor", [proxyInbox.address], { ...deployOpts, ...opts } as any),
      deployGas
    );
    const registerHash = await withNonceRetry((opts) =>
      proxyInbox.write.registerExecutor([executor.address], opts)
    );
    await publicClient.waitForTransactionReceipt({ hash: registerHash, ...cotiReceiptWaitOptions });
    harness = await withNonceRetry(
      (opts) =>
        viem.deployContract("MpcExecutorCotiTest", [executor.address, proxyInbox.address], {
          ...deployOpts,
          ...opts,
        } as any),
      deployGas
    );
    // executorMul* offBoardToUser(cOwner) requires sim AES registration for the harness.
    const harnessKey = deriveUserAesKey(HH_ACCOUNT0_PK, probe.chainId);
    await registerUserOnSim(viem, harness.address as `0x${string}`, harnessKey, account);
    // registerUserOnSim sends a tx outside our nonce tracker — resync.
    nextNonce = await publicClient.getTransactionCount({
      address: account.address,
      blockTag: "pending",
    });
    console.log(`[executor-fork] registered sim AES for harness ${harness.address}`);
  }, { timeout: 600_000 });

  const cOwner = () => harness.address as Hex;

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

        assert.equal(viaExec, direct, `executor mul256 vs direct for (${a}, ${b})`);
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
      await assert.rejects(async () =>
        harness.simulate.executorMul64PublicPlain([a, b, cOwner()], simulateOpts() as any)
      );
    });
  });
});
