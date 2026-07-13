import type { HardhatRuntimeEnvironment } from "hardhat/types";

export { MPC_PRECOMPILE, SIM_COTI_CHAIN_ID } from "./injectPrecompile.js";

let injected = false;

/**
 * Hardhat 2 / ethers injection path (coti-contracts MPC tests).
 */
export async function injectSimCotiPrecompileEthers(
  hre: HardhatRuntimeEnvironment
): Promise<{ stateAddress: string; implAddress: string; proxyAddress: string }> {
  if (injected) {
    return { stateAddress: "", implAddress: "", proxyAddress: "" };
  }

  const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064";

  const State = await hre.ethers.getContractFactory("SimState");
  const state = await State.deploy();
  await state.waitForDeployment();

  const Impl = await hre.ethers.getContractFactory("SimExtendedOperations");
  const impl = await Impl.deploy(await state.getAddress());
  await impl.waitForDeployment();

  const Proxy = await hre.ethers.getContractFactory("SimPrecompileProxy");
  const proxy = await Proxy.deploy(await impl.getAddress());
  await proxy.waitForDeployment();

  await state.setOps(MPC_PRECOMPILE);

  const proxyBytecode = await hre.ethers.provider.getCode(await proxy.getAddress());
  await hre.network.provider.send("hardhat_setCode", [MPC_PRECOMPILE, proxyBytecode]);

  injected = true;
  return {
    stateAddress: await state.getAddress(),
    implAddress: await impl.getAddress(),
    proxyAddress: await proxy.getAddress(),
  };
}

export async function registerSimUserKeyEthers(
  hre: HardhatRuntimeEnvironment,
  userAddress: string,
  aesKey: bigint
): Promise<void> {
  const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064";
  const sim = await hre.ethers.getContractAt("SimExtendedOperations", MPC_PRECOMPILE);
  await sim.simRegisterUserKey(userAddress, aesKey);
}
