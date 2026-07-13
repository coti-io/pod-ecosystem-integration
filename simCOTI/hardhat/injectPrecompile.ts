import fs from "node:fs";
import path from "node:path";
import type { Hex } from "viem";

export const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064" as const;
export const SIM_COTI_CHAIN_ID = 7082401;

export type InjectSimCotiResult = {
  precompileAddress: typeof MPC_PRECOMPILE;
  stateAddress: `0x${string}`;
  implAddress: `0x${string}`;
  onboardAddress?: `0x${string}`;
};

/**
 * Deploy SimState + SimExtendedOperations + proxy, then inject proxy bytecode at MPC_PRECOMPILE (0x64).
 * Storage lives in SimState because EDR does not persist contract storage at 0x64.
 */
export async function injectSimCotiPrecompile(viem: {
  deployContract: (
    name: string,
    args?: unknown[],
    opts?: unknown
  ) => Promise<{ address: `0x${string}` }>;
  getContractAt: (
    name: string,
    address: `0x${string}`
  ) => Promise<{ write: Record<string, (...args: unknown[]) => Promise<unknown>> }>;
  getPublicClient: () => Promise<{
    getCode: (args: { address: `0x${string}` }) => Promise<Hex | undefined>;
    request: (args: { method: string; params: unknown[] }) => Promise<unknown>;
  }>;
}): Promise<InjectSimCotiResult> {
  const publicClient = await viem.getPublicClient();

  const state = await viem.deployContract("SimState", []);
  const impl = await viem.deployContract("SimExtendedOperations", [state.address]);
  const proxy = await viem.deployContract("SimPrecompileProxy", [impl.address]);

  const stateWrite = await viem.getContractAt("SimState", state.address);
  await stateWrite.write.setOps([MPC_PRECOMPILE]);

  const proxyBytecode = await publicClient.getCode({ address: proxy.address });
  await publicClient.request({
    method: "hardhat_setCode",
    params: [MPC_PRECOMPILE, proxyBytecode ?? "0x"],
  });

  let onboardAddress: `0x${string}` | undefined;
  try {
    const onboard = await viem.deployContract("SimAccountOnboard", []);
    onboardAddress = onboard.address;
  } catch {
    // optional when MpcCore is not linked
  }

  return {
    precompileAddress: MPC_PRECOMPILE,
    stateAddress: state.address,
    implAddress: impl.address,
    onboardAddress,
  };
}

export async function registerSimUserKey(
  viem: {
    getWalletClients: () => Promise<Array<{ account: { address: `0x${string}` } }>>;
    getContractAt: (
      name: string,
      address: `0x${string}`
    ) => Promise<{ write: { simRegisterUserKey: (args: unknown[]) => Promise<`0x${string}`> } }>;
  },
  aesKey: bigint,
  userAddress?: `0x${string}`
): Promise<void> {
  const [wallet] = await viem.getWalletClients();
  const user = userAddress ?? wallet.account.address;
  const sim = await viem.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
  await sim.write.simRegisterUserKey([user, aesKey]);
}
