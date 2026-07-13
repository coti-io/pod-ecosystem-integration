import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import { toFunctionSelector } from "viem";
import { injectSimCotiPrecompile, MPC_PRECOMPILE } from "../hardhat/injectPrecompile.js";
import {
  SimWallet,
  aesKeyToBigInt,
  deriveSimAesKey,
  simEncryptUint,
  SIM_COTI_CHAIN_ID,
} from "../sdk/index.js";

describe("simCOTI failure parity", { concurrency: false, timeout: 300_000 }, async function () {
  const { viem } = await network.connect({ network: "simCoti" });
  const publicClient = await viem.getPublicClient();
  const [walletClient] = await viem.getWalletClients();

  const pk = (
    process.env.PRIVATE_KEY?.startsWith("0x")
      ? process.env.PRIVATE_KEY
      : process.env.PRIVATE_KEY
        ? `0x${process.env.PRIVATE_KEY}`
        : "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"
  ) as `0x${string}`;

  let harnessA: any;
  let simWallet: SimWallet;
  let userKey: string;

  before(async function () {
    await injectSimCotiPrecompile(viem);
    userKey = deriveSimAesKey(pk, SIM_COTI_CHAIN_ID);
    simWallet = new SimWallet(pk, { send: async () => null } as any, {
      chainId: SIM_COTI_CHAIN_ID,
      aesKey: userKey,
    });

    const simOps = await viem.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
    await simOps.write.simRegisterUserKey([
      simWallet.address,
      aesKeyToBigInt(userKey),
    ]);

    harnessA = await viem.deployContract("SimSmokeHarness", []);
  });

  it("rejects wrong selector in signature", async function () {
    const selector = toFunctionSelector("validateAndStore((uint256,bytes))");
    const it = await simWallet.encryptValue(5n, harnessA.address, selector);
    const wrongSelector = toFunctionSelector("addEncrypted((uint256,bytes),(uint256,bytes))");
    const sigBytes = it.signature.slice(2);
    const body = sigBytes.slice(8);
    const badSig = (`0x${wrongSelector.slice(2)}${body}`) as `0x${string}`;
    await assert.rejects(
      () => harnessA.write.validateAndStore([{ ciphertext: it.ciphertext, signature: badSig }]),
      /revert/i
    );
  });

  it("rejects un-onboarded user ciphertext", async function () {
    const freshPk = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78627d" as `0x${string}`;
    const freshKey = deriveSimAesKey(freshPk, SIM_COTI_CHAIN_ID);
    const selector = toFunctionSelector("validateAndStore((uint256,bytes))");
    const ciphertext = simEncryptUint(9n, freshKey, 64);
    const freshWallet = new SimWallet(freshPk, { send: async () => null } as any, {
      chainId: SIM_COTI_CHAIN_ID,
      aesKey: freshKey,
    });
    const it = await freshWallet.encryptValue(9n, harnessA.address, selector);
    await assert.rejects(
      () => harnessA.write.validateAndStore([it]),
      /SimUserNotOnboarded|revert/i
    );
  });

  it("rejects gt scope mismatch on SetPublic handles", async function () {
    const simOps = await viem.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
    const { result: scopedA } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "SetPublic",
      args: ["0x04", 11n],
      account: walletClient.account,
    });
    const { result: scopedB } = await publicClient.simulateContract({
      address: MPC_PRECOMPILE,
      abi: simOps.abi,
      functionName: "SetPublic",
      args: ["0x04", 22n],
      account: walletClient.account,
    });
    // Different contract context: harness cannot consume wallet-scoped gt cells.
    await assert.rejects(
      async () =>
        publicClient.simulateContract({
          address: MPC_PRECOMPILE,
          abi: simOps.abi,
          functionName: "Add",
          args: ["0x040400", scopedA, scopedB],
          account: harnessA.address,
        }),
      /SimGtScopeMismatch|revert/i
    );
  });
});
