/**
 * System test: dest execution failure is terminal (no retryFailedRequest).
 *
 * Flow (real cross-chain behaviour, not mocked):
 * 1. Two-way `add()` from Hardhat → request appears on COTI inbox.
 * 2. Mine on COTI: executor runs MPC; response one-way message is created for the callback on Hardhat.
 * 3. Pause `MpcAdderPausable` on Hardhat, then mine the return leg: `receiveC` reverts with OZ `EnforcedPause()`.
 *    `mineRequest` throws on callback failure (by design); we catch and then assert inbox state. The inbox still
 *    records the incoming request as executed and stores `errors[id].errorCode == 1`. The adder must not have
 *    updated `_result` — we assert ciphertext is still zero.
 * 4. Unpause. There is no on-chain retry; error stays 1 and ciphertext stays zero.
 */

import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { network } from "hardhat";
import { keccak256, stringToBytes } from "viem";
import {
  buildEncryptedInput,
  collectInboxFeesAfterTest,
  decodeCtUint64,
  getLatestRequest,
  getResponseRequestBySource,
  getTupleField,
  logStep,
  mineRequest,
  podTwoWayWriteOptions,
  receiptWaitOptions,
  setupContext,
  type TestContext,
} from "./mpc-test-utils.js";

/** First 4 bytes of `keccak256("EnforcedPause()")` — revert data when `receiveC` hits `whenNotPaused` while paused. */
const ENFORCED_PAUSE_REVERT_DATA = keccak256(stringToBytes("EnforcedPause()")).slice(0, 10) as `0x${string}`;

function assertHexPrefix(actual: unknown, expectedPrefix: `0x${string}`, label: string) {
  const s = typeof actual === "string" ? actual : String(actual);
  const lower = s.toLowerCase();
  assert.ok(
    lower.startsWith(expectedPrefix.toLowerCase()),
    `${label}: expected revert data to start with ${expectedPrefix}, got ${s}`
  );
}


const runCotiSystem = process.env.COTI_SYSTEM_TESTS === "1" || process.env.COTI_BACKEND === "sim";
const describeCoti = runCotiSystem ? describe : describe.skip;

describeCoti("MpcAdderPausable callback failure is terminal (system)", { concurrency: 1 }, async function () {
  const { viem: sepoliaViem } = await network.connect({ network: "hardhat" });
  const { viem: cotiViem } = await network.connect({ network: "cotiTestnet" });

  let ctx: TestContext;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  before(async function () {
    process.env.COTI_REUSE_CONTRACTS = "true";
    ctx = await setupContext({
      sepoliaViem,
      cotiViem,
      podAdderContractName: "MpcAdderPausable",
    });
  });

  it(
    "callback fails while paused; unpause does not recover without retry",
    { timeout: 900_000 },
    async function () {
      const a = 5n;
      const b = 11n;

      logStep("encrypt inputs and send add() on Hardhat");
      const itA = await buildEncryptedInput(ctx, a);
      const itB = await buildEncryptedInput(ctx, b);
      const addTx = await ctx.contracts.mpcAdderAsCoti.write.add(
        [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.podTwoWayFees)
      );
      await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: addTx, ...receiptWaitOptions });

      const outbound = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);

      logStep("mine inbound request on COTI (MPC + response request creation)");
      const { requestIdUsed: cotiIncomingId } = await mineRequest(
        ctx,
        "coti",
        BigInt(ctx.chainIds.sepolia),
        outbound,
        "callback-fail: coti leg"
      );

      const responseRequest = await getResponseRequestBySource(
        ctx.contracts.inboxCoti,
        cotiIncomingId,
        "callback-fail: load return leg"
      );
      const returnRequestId = getTupleField(responseRequest, "requestId", 0) as `0x${string}`;
      assert.ok(returnRequestId && returnRequestId !== "0x" + "0".repeat(64), "return leg must have a request id");

      logStep("pause adder on Hardhat, then mine return leg (callback must revert)");
      const pauseTx = await ctx.contracts.mpcAdder.write.pause({
        account: ctx.sepolia.wallet.account,
      });
      await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: pauseTx, ...receiptWaitOptions });
      assert.equal(await ctx.contracts.mpcAdder.read.paused(), true);

      try {
        await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "callback-fail: sepolia paused");
        assert.fail("expected mineRequest to throw when callback reverts (paused)");
      } catch (err) {
        assert.ok(err instanceof Error, "mineRequest should throw Error");
        assert.ok(
          (err as Error).message.includes("callback subcall failed"),
          `unexpected throw: ${(err as Error).message}`
        );
      }

      const inboundAfterFail = await ctx.contracts.inboxSepolia.read.incomingRequests([returnRequestId]);
      const incomingExecuted =
        (inboundAfterFail as { executed?: boolean }).executed ?? getTupleField(inboundAfterFail, "executed", 10);
      assert.equal(
        incomingExecuted,
        true,
        "incoming request must be marked executed after batch (even though subcall reverted)"
      );

      const errAfterFail = await ctx.contracts.inboxSepolia.read.errors([returnRequestId]);
      assert.equal(
        BigInt(getTupleField(errAfterFail, "errorCode", 1) as bigint),
        1n,
        "inbox must record ERROR_CODE_EXECUTION_FAILED (1) for failed subcall"
      );
      const revertBlob = getTupleField(errAfterFail, "errorMessage", 2);
      assertHexPrefix(revertBlob, ENFORCED_PAUSE_REVERT_DATA, "subcall revert");

      const ctBeforeUnpause = await ctx.contracts.mpcAdder.read.resultCiphertext();
      assert.equal(
        decodeCtUint64(ctBeforeUnpause),
        0n,
        "receiveC must not have stored ciphertext when it reverted (paused)"
      );

      logStep("unpause; execution failure stays terminal");
      const unpauseTx = await ctx.contracts.mpcAdder.write.unpause({
        account: ctx.sepolia.wallet.account,
      });
      await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: unpauseTx, ...receiptWaitOptions });
      assert.equal(await ctx.contracts.mpcAdder.read.paused(), false);
      assert.equal(
        "retryFailedRequest" in ctx.contracts.inboxSepolia.write,
        false,
        "retryFailedRequest must not exist on inbox ABI"
      );

      const errAfterUnpause = await ctx.contracts.inboxSepolia.read.errors([returnRequestId]);
      assert.equal(
        BigInt(getTupleField(errAfterUnpause, "errorCode", 1) as bigint),
        1n,
        "errors[requestId] stays ERROR_CODE_EXECUTION_FAILED after unpause"
      );
      assert.equal(
        decodeCtUint64(await ctx.contracts.mpcAdder.read.resultCiphertext()),
        0n,
        "ciphertext stays zero; there is no retry recovery"
      );
    }
  );
});
