import type { HardhatPlugin } from "hardhat/types/plugins";

/**
 * Hardhat 3 plugin marker for simCOTI. Precompile injection is explicit via injectSimCotiPrecompile().
 */
const simCotiPlugin: HardhatPlugin = {
  id: "sim-coti",
  dependencies: () => [],
  hookHandlers: {},
};

export default simCotiPlugin;

export { SIM_COTI_CHAIN_ID } from "./injectPrecompile.js";
