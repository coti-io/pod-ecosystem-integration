import { afterEach, describe } from "node:test";
import { collectInboxFeesAfterTest, setupContext, type TestContext } from "../system/mpc-test-utils.js";
import { registerMpcAdderTests } from "../shared/mpc-adder.spec.js";
import { connectDualChainForTests } from "../sim-coti/sim-coti-utils.js";

describe("MpcAdder (system)", { concurrency: 1 }, async function () {
  const { sepoliaViem, cotiViem } = await connectDualChainForTests();

  let ctx: TestContext;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  registerMpcAdderTests({
    getContext: async () => {
      process.env.COTI_REUSE_CONTRACTS = "true";
      return setupContext({ sepoliaViem, cotiViem });
    },
    onContext: (c) => {
      ctx = c;
    },
  });
});
