import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { injectSimCotiPrecompile, MPC_PRECOMPILE } from "../hardhat/injectPrecompile.js";
import { aesKeyToBigInt, deriveSimAesKey } from "../sdk/crypto.js";

describe("simCOTI storage probe", async function () {
  const { viem } = await network.connect({ network: "simCoti" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const pk = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
  const key = deriveSimAesKey(pk, 7082401);
  const keyBig = aesKeyToBigInt(key);

  before(async function () {
    await injectSimCotiPrecompile(viem);
  });

  it("persists userAesKey at 0x64", async function () {
    const atPrecompile = await viem.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
    await atPrecompile.write.simRegisterUserKey([wallet.account.address, keyBig]);
    const readBack = await atPrecompile.read.simUserKey([wallet.account.address]);
    assert.equal(readBack, keyBig);
  });

  it("persists userAesKey on deployed copy", async function () {
    const state = await viem.deployContract("SimState", []);
    const deployed = await viem.deployContract("SimExtendedOperations", [state.address]);
    const stateWrite = await viem.getContractAt("SimState", state.address);
    await stateWrite.write.setOps([deployed.address]);
    await deployed.write.simRegisterUserKey([wallet.account.address, keyBig]);
    const readBack = await deployed.read.simUserKey([wallet.account.address]);
    assert.equal(readBack, keyBig);
  });
});
