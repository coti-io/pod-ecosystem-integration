/**
 * 128-bit MPC system tests: PodAdder128 setup + COTI default gas for mineRequest only.
 * Import everything else from mpc-test-utils.ts in tests.
 */
import {
  createMineRequestWithDefaultCotiGas,
  DEFAULT_COTI_MINE_GAS_MPC_128,
  setupContextWideMpc,
  type TestContextWideMpc,
} from "./mpc-test-utils.js";

export type TestContext128 = TestContextWideMpc;

const MPC_WIDE_CONFIG_128 = {
  podAdderContractName: "PodAdder128" as const,
  cotiDeploymentsFile: "coti-testnet-128.json",
  envHardhatMpcAdder: "HARDHAT_MPC_ADDER_128_ADDRESS",
  envSepoliaMpcAdder: "SEPOLIA_MPC_ADDER_128_ADDRESS",
};

export const setupContext128 = (params: { sepoliaViem: any; cotiViem: any }) =>
  setupContextWideMpc(params, MPC_WIDE_CONFIG_128);

export const mineRequest = createMineRequestWithDefaultCotiGas(DEFAULT_COTI_MINE_GAS_MPC_128);
