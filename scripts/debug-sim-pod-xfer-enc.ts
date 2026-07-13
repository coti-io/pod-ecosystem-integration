/**
 * Minimal encrypted transfer round-trip on sim (not CI).
 */
import { connectDualChainForTests } from "../test/sim-coti/sim-coti-utils.js";
import {
  encryptAmount,
  mintOnCotiAndSync,
  completePodOpRoundTrip,
  readDecryptedBalance,
  setupPodTokenTestContext,
} from "../test/tokens/test-token-utils.js";
import { podTwoWayWriteOptions } from "../test/system/mpc-test-utils.js";

const { sepoliaViem, cotiViem } = await connectDualChainForTests();
process.env.COTI_REUSE_CONTRACTS = "false";
const ctx = await setupPodTokenTestContext({ sepoliaViem, cotiViem });

await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: 5000n }], "fund");
console.log("owner after mint", await readDecryptedBalance(ctx, ctx.owner));

const itAmount = await encryptAmount(ctx, 1200n);
try {
  await completePodOpRoundTrip(ctx, "encXfer", () =>
    ctx.podAsCoti.write.transfer(
      [ctx.bob.address, itAmount, ctx.base.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.base.podTwoWayFees)
    )
  );
  console.log("owner", await readDecryptedBalance(ctx, ctx.owner));
  console.log("bob", await readDecryptedBalance(ctx, ctx.bob.address));
} catch (e: any) {
  console.error("enc transfer failed:", e.message?.slice(0, 500));
  throw e;
}
