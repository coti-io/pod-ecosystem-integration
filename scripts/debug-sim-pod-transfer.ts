/**
 * One-off sim debugger for garbled pToken transfer on COTI (not part of CI).
 */
import { network } from "hardhat";
import { connectDualChainForTests } from "../test/sim-coti/sim-coti-utils.js";
import {
  encryptAmount,
  mintOnCotiAndSync,
  completePodOpRoundTrip,
  readDecryptedBalance,
  setupPodTokenTestContext,
} from "../test/tokens/test-token-utils.js";
import { podTwoWayWriteOptions, mineRequest, getLatestRequest } from "../test/system/mpc-test-utils.js";

const { sepoliaViem, cotiViem } = await connectDualChainForTests();
process.env.COTI_REUSE_CONTRACTS = "false";
const ctx = await setupPodTokenTestContext({ sepoliaViem, cotiViem });

console.log("mint+sync 5000 to owner...");
await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: 5000n }], "dbgFund");
console.log("owner balance", await readDecryptedBalance(ctx, ctx.owner));

console.log("plain transfer 1200 to bob...");
try {
  await completePodOpRoundTrip(ctx, "dbgXferPlain", () =>
    ctx.podAsCoti.write.transfer(
      [ctx.bob.address, 1200n, ctx.base.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.base.podTwoWayFees)
    )
  );
  console.log("owner", await readDecryptedBalance(ctx, ctx.owner));
  console.log("bob", await readDecryptedBalance(ctx, ctx.bob.address));
} catch (e: any) {
  console.error("dbgXferPlain failed:", e.message);
  throw e;
}

console.log("owner", await readDecryptedBalance(ctx, ctx.owner));
console.log("bob", await readDecryptedBalance(ctx, ctx.bob.address));

console.log("encrypted transfer 800 to bob...");
const itAmount = await encryptAmount(ctx, 800n);
await completePodOpRoundTrip(ctx, "dbgXfer", () =>
  ctx.podAsCoti.write.transfer(
    [ctx.bob.address, itAmount, ctx.base.podTwoWayFees.callbackFeeWei],
    podTwoWayWriteOptions(ctx.base.podTwoWayFees)
  )
);

console.log("owner", await readDecryptedBalance(ctx, ctx.owner));
console.log("bob", await readDecryptedBalance(ctx, ctx.bob.address));
console.log("done");
