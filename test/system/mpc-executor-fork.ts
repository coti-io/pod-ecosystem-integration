/**
 * System test: MpcExecutor / MpcCore on a **running** sim-coti tip-fork (:8546).
 *
 * Probes `SIM_COTI_RPC_URL` (default http://127.0.0.1:8546) for chain id + MPC @0x64,
 * then runs a short mul parity suite against that RPC.
 *
 * Run: `npm run test:executor-fork`
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { receiptWaitOptions } from "./mpc-test-utils.js";

const MOD_256 = 1n << 256n;
const cotiReceiptWaitOptions = { ...receiptWaitOptions, timeout: 900_000 };
const GAS_MPC_MUL256 = process.env.MPC_COTI_MUL256_GAS?.trim()
  ? BigInt(process.env.MPC_COTI_MUL256_GAS.trim())
  : 50_000_000n;
const GAS_MPC_MUL128 = 12_000_000n;

function mod256Mul(a: bigint, b: bigint): bigint {
  return (a * b) % MOD_256;
}

const simRpc = (process.env.SIM_COTI_RPC_URL || "http://127.0.0.1:8546").trim();
const cotiPkRaw =
  process.env.COTI_TESTNET_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();

async function probeSimCoti(): Promise<{ ok: true; chainId: number } | { ok: false; reason: string }> {
  try {
    const res = await fetch(simRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(5_000),
    });
    const body = (await res.json()) as { result?: string; error?: unknown };
    if (!body.result) return { ok: false, reason: `eth_chainId failed: ${JSON.stringify(body.error ?? body)}` };
    const chainId = Number.parseInt(body.result, 16);
    const codeRes = await fetch(simRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "eth_getCode",
        params: ["0x0000000000000000000000000000000000000064", "latest"],
      }),
      signal: AbortSignal.timeout(5_000),
    });
    const codeBody = (await codeRes.json()) as { result?: string };
    const code = codeBody.result ?? "0x";
    if (code === "0x" || code === "0x0") {
      return {
        ok: false,
        reason:
          `MPC precompile @0x64 missing on ${simRpc} (chainId=${chainId}). ` +
          `Start sim-coti with inject (MAINNET.md §2).`,
      };
    }
    return { ok: true, chainId };
  } catch (err) {
    return {
      ok: false,
      reason:
        `sim-coti unreachable at ${simRpc}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Run MAINNET.md §2 before test:executor-fork.`,
    };
  }
}

const probe = await probeSimCoti();
const describeFork = probe.ok && cotiPkRaw ? describe : describe.skip;

describeFork("MpcExecutorCotiTest (sim-coti fork)", { concurrency: false, timeout: 900_000 }, async function () {
  if (!probe.ok || !cotiPkRaw) {
    it.skip("probe/credentials missing", () => {});
    return;
  }

  const chainId = probe.chainId;
  process.env.COTI_MAINNET_RPC_URL = simRpc;
  process.env.SIM_COTI_RPC_URL = simRpc;
  process.env.SIM_COTI_CHAIN_ID = String(chainId);

  const { viem } = await network.connect({
    network: chainId === 2632500 ? "cotiMainnet" : "localSimCoti",
  });
  const cotiChain = defineChain({
    id: chainId,
    name: "sim-coti-fork",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: { default: { http: [simRpc] } },
  });
  const pkHex = (cotiPkRaw.startsWith("0x") ? cotiPkRaw : `0x${cotiPkRaw}`) as `0x${string}`;
  const account = privateKeyToAccount(pkHex);
  const publicClient = await viem.getPublicClient({ chain: cotiChain });
  const wallet = await viem.getWalletClient(account.address, { chain: cotiChain });
  const deployOpts = { client: { public: publicClient, wallet } } as const;

  let harness: Awaited<ReturnType<(typeof viem)["deployContract"]>>;

  before(async () => {
    const proxyInbox = await viem.deployContract("MpcExecutorCotiProxyInbox", [], deployOpts);
    const executor = await viem.deployContract("MpcExecutor", [proxyInbox.address], deployOpts);
    const registerHash = await proxyInbox.write.registerExecutor([executor.address], {
      account: wallet.account,
    });
    await publicClient.waitForTransactionReceipt({ hash: registerHash, ...cotiReceiptWaitOptions });
    harness = await viem.deployContract(
      "MpcExecutorCotiTest",
      [executor.address, proxyInbox.address],
      deployOpts
    );
    assert.ok(harness.address);
  }, { timeout: 900_000 });

  it("MpcCore mul64PublicPlain", async () => {
    const a = 6n;
    const b = 7n;
    const h = await harness.write.mul64PublicPlain([a, b], {
      account: wallet.account,
      gas: GAS_MPC_MUL128,
    });
    await publicClient.waitForTransactionReceipt({ hash: h, ...cotiReceiptWaitOptions });
    assert.equal(await harness.read.lastPlain64(), a * b);
  });

  it("MpcCore mul256PublicPlain", async () => {
    const a = (1n << 200n) + 12345n;
    const b = 999n;
    const h = await harness.write.mul256PublicPlain([a, b], {
      account: wallet.account,
      gas: GAS_MPC_MUL256,
    });
    await publicClient.waitForTransactionReceipt({ hash: h, ...cotiReceiptWaitOptions });
    assert.equal(await harness.read.lastPlain256(), mod256Mul(a, b));
  });
});

if (!probe.ok) {
  describe("MpcExecutorCotiTest (sim-coti fork) — setup", () => {
    it(`skipped: ${"reason" in probe ? probe.reason : "n/a"}`, () => {
      console.warn(`[test:executor-fork] ${"reason" in probe ? probe.reason : ""}`);
    });
  });
}
