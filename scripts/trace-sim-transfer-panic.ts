/** Trace COTI panic on pod transfer. */
import { connectDualChainForTests } from "../test/sim-coti/sim-coti-utils.js";
import {
  mintOnCotiAndSync,
  setupPodTokenTestContext,
} from "../test/tokens/test-token-utils.js";
import {
  getLatestRequest,
  mineRequest,
  podTwoWayWriteOptions,
} from "../test/system/mpc-test-utils.js";

const { sepoliaViem, cotiViem } = await connectDualChainForTests();
process.env.COTI_REUSE_CONTRACTS = "false";
const ctx = await setupPodTokenTestContext({ sepoliaViem, cotiViem });
await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: 5000n }], "fund");

const txHash = await ctx.podAsCoti.write.transfer(
  [ctx.bob.address, 1200n, ctx.base.podTwoWayFees.callbackFeeWei],
  podTwoWayWriteOptions(ctx.base.podTwoWayFees)
);
await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash });
const request = await getLatestRequest(ctx.base.contracts.inboxSepolia, ctx.base.chainIds.coti);
const { txHash: mineTx } = await mineRequest(
  ctx.base,
  "coti",
  BigInt(ctx.base.chainIds.sepolia),
  request,
  "tracePlain",
  { gas: 80_000_000n }
);

const trace = (await ctx.base.coti.publicClient.request({
  method: "debug_traceTransaction",
  params: [mineTx, { enableMemory: false, disableStorage: true }],
})) as { structLogs?: { op: string; depth: number; stack?: string[] }[]; failed?: boolean };

const logs = trace.structLogs ?? [];
const revIdx = logs.findIndex((l) => l.op === "REVERT" || l.op === "INVALID");
const window = logs.slice(Math.max(0, revIdx - 40), revIdx + 3);
console.log("failed", trace.failed, "revertIdx", revIdx, "totalOps", logs.length);
for (const l of window) {
  if (["SUB", "ADD", "MUL", "GT", "LT", "GE", "JUMPI", "JUMPDEST", "REVERT", "CALL", "STATICCALL", "DELEGATECALL"].includes(l.op)) {
    console.log("d" + l.depth, "pc=" + (l as any).pc, l.op, l.stack?.slice(-6)?.join(" "));
  }
}
