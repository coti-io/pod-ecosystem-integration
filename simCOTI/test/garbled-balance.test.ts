import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { privateKeyToAccount } from "viem/accounts";
import { injectSimCotiPrecompile, MPC_PRECOMPILE } from "../hardhat/injectPrecompile.js";
import {
  SimWallet,
  aesKeyToBigInt,
  deriveSimAesKey,
  SIM_COTI_CHAIN_ID,
} from "../sdk/index.js";

describe("simCOTI garbled balance MPC", { concurrency: false, timeout: 300_000 }, async function () {
  const { viem } = await network.connect({ network: "simCoti" });
  const publicClient = await viem.getPublicClient();
  const [walletClient, bobClient] = await viem.getWalletClients();

  const ownerPk =
    "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as `0x${string}`;
  const bobPk =
    "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78627d" as `0x${string}`;

  let simOps: any;
  let harness: any;
  const owner = walletClient.account.address;
  const bob = bobClient.account.address;

  before(async function () {
    await injectSimCotiPrecompile(viem);
    simOps = await viem.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
    harness = await viem.deployContract("SimSmokeHarness", []);

    for (const [pk, addr] of [
      [ownerPk, owner],
      [bobPk, bob],
    ] as const) {
      const key = deriveSimAesKey(pk, SIM_COTI_CHAIN_ID);
      await simOps.write.simRegisterUserKey([addr, aesKeyToBigInt(key)]);
    }
  });

  async function setPublic256(value: bigint): Promise<bigint> {
    const { result: gt } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "SetPublic",
      args: ["0x06", value],
      account: harness.address,
    });
    await simOps.write.SetPublic(["0x06", value], { account: harness.address });
    return gt as bigint;
  }

  async function offBoard256(gt: bigint): Promise<[bigint, bigint]> {
    const { result } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "OffBoard256",
      args: ["0x06", gt],
      account: harness.address,
    });
    return result as [bigint, bigint];
  }

  async function onBoard256(high: bigint, low: bigint): Promise<bigint> {
    const { result: gt } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "OnBoard",
      args: ["0x06", high, low],
      account: harness.address,
    });
    await simOps.write.OnBoard(["0x06", high, low], { account: harness.address });
    return gt as bigint;
  }

  async function ge256(a: bigint, b: bigint): Promise<bigint> {
    const meta = "0x060600" as `0x${string}`;
    const { result: gt } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "Ge",
      args: [meta, a, b],
      account: harness.address,
    });
    await simOps.write.Ge([meta, a, b], { account: harness.address });
    return gt as bigint;
  }

  async function sub256(a: bigint, b: bigint): Promise<bigint> {
    const meta = "0x060600" as `0x${string}`;
    const { result: gt } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "Sub",
      args: [meta, a, b],
      account: harness.address,
    });
    await simOps.write.Sub([meta, a, b], { account: harness.address });
    return gt as bigint;
  }

  async function add256(a: bigint, b: bigint): Promise<bigint> {
    const meta = "0x060600" as `0x${string}`;
    const { result: gt } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "Add",
      args: [meta, a, b],
      account: harness.address,
    });
    await simOps.write.Add([meta, a, b], { account: harness.address });
    return gt as bigint;
  }

  async function offBoardToUser256(gt: bigint, user: `0x${string}`): Promise<[bigint, bigint]> {
    const { result } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "OffBoardToUser256",
      args: ["0x06", gt, user],
      account: harness.address,
    });
    return result as [bigint, bigint];
  }

  it("offBoard256/onBoard256 round-trip", async function () {
    const gt = await setPublic256(5000n);
    const [hi, lo] = await offBoard256(gt);
    const back = await onBoard256(hi, lo);
    assert.equal(back, 5000n);
  });

  it("ge/sub/add transfer-shaped MPC", async function () {
    const balanceGt = await setPublic256(5000n);
    const amountGt = await setPublic256(1200n);
    const geBit = await ge256(balanceGt, amountGt);
    const gePlain = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "Decrypt",
      args: ["0x00", geBit],
      account: harness.address,
    });
    assert.equal(gePlain.result, 1n);

    const senderAfter = await sub256(balanceGt, amountGt);
    const zeroGt = await setPublic256(0n);
    const recipientAfter = await add256(zeroGt, amountGt);
    assert.equal(
      await publicClient.simulateContract({
        address: MPC_PRECOMPILE,
        abi: simOps.abi,
        functionName: "Decrypt",
        args: ["0x06", senderAfter],
        account: harness.address,
      }).then((r) => r.result),
      3800n
    );
    await offBoardToUser256(senderAfter, owner);
    await offBoardToUser256(amountGt, owner);
    await offBoardToUser256(recipientAfter, bob);
    await offBoardToUser256(amountGt, bob);
  });

  it("stored ct round-trip like PodErc20CotiMother balance", async function () {
    const gt = await setPublic256(5000n);
    const [hi, lo] = await offBoard256(gt);
    const balanceGt = await onBoard256(hi, lo);
    const amountGt = await setPublic256(1200n);
    const geBit = await ge256(balanceGt, amountGt);
    assert.equal(
      await publicClient.simulateContract({
        address: MPC_PRECOMPILE,
        abi: simOps.abi,
        functionName: "Decrypt",
        args: ["0x00", geBit],
        account: harness.address,
      }).then((r) => r.result),
      1n
    );
    await sub256(balanceGt, amountGt);
  });
});
