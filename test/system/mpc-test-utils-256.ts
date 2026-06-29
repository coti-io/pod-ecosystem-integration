/**
 * 256-bit MPC system tests: PodAdder256 setup + COTI default gas for mineRequest only.
 * Import everything else from mpc-test-utils.ts in tests.
 */
import {
  createMineRequestWithDefaultCotiGas,
  DEFAULT_COTI_MINE_GAS_MPC_256,
  setupContextWideMpc,
  type TestContextWideMpc,
} from "./mpc-test-utils.js";

export type TestContext256 = TestContextWideMpc;

const MPC_WIDE_CONFIG_256 = {
  podAdderContractName: "PodAdder256" as const,
  cotiDeploymentsFile: "coti-testnet-256.json",
  envHardhatMpcAdder: "HARDHAT_MPC_ADDER_256_ADDRESS",
  envSepoliaMpcAdder: "SEPOLIA_MPC_ADDER_256_ADDRESS",
};

export const setupContext256 = (params: { sepoliaViem: any; cotiViem: any }) =>
  setupContextWideMpc(params, MPC_WIDE_CONFIG_256);

export const mineRequest = createMineRequestWithDefaultCotiGas(DEFAULT_COTI_MINE_GAS_MPC_256);
