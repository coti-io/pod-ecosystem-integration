import { afterEach, describe } from "node:test";
import { collectInboxFeesAfterTest, type TestContext } from "../system/mpc-test-utils.js";
import { registerMpcAdderTests } from "../shared/mpc-adder.spec.js";
import { createSimCotiContext } from "./sim-coti-utils.js";

describe("MpcAdder (sim-coti local)", { concurrency: 1 }, function () {
  let ctx: TestContext;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  registerMpcAdderTests({
    getContext: () => createSimCotiContext(),
    onContext: (c) => {
      ctx = c;
    },
  });
});
