/**
 * System test: `InboxMiner.retryFailedRequest` after a failed incoming execution.
 *
 * Flow (real cross-chain behaviour, not mocked):
 * 1. Two-way `add()` from Hardhat → request appears on COTI inbox.
 * 2. Mine on COTI: executor runs MPC; response one-way message is created for the callback on Hardhat.
 * 3. Pause `MpcAdderPausable` on Hardhat, then mine the return leg: `receiveC` reverts with OZ `EnforcedPause()`.
 *    `mineRequest` throws on callback failure (by design); we catch and then assert inbox state. The inbox still
 *    records the incoming request as executed and stores `errors[id].errorCode == 1`. The adder must not have
 *    updated `_result` — we assert ciphertext is still zero.
 * 4. Unpause and call `retryFailedRequest(returnRequestId)` on the Hardhat inbox (any caller may pay gas).
 *    Contract re-executes the target call with full gas; `receiveC` succeeds; `delete errors[id]` runs.
 * 5. We assert error slot is cleared (`errorCode == 0`), optional log `RetryFailedRequestSuccess`, and decrypt `a+b`.
 */

import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { network } from "hardhat";
import { keccak256, stringToBytes } from "viem";
import { decryptUint } from "@coti-io/coti-sdk-typescript";
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

describe("MpcAdderPausable retryFailedRequest (system)", { concurrency: 1 }, async function () {
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
    "callback fails while paused; retryFailedRequest succeeds after unpause",
    { timeout: 900_000 },
    async function () {
      const a = 5n;
      const b = 11n;
      const expectedSum = a + b;

      // --- Outbound two-way message (Hardhat inbox) ---
      logStep("encrypt inputs and send add() on Hardhat");
      const itA = await buildEncryptedInput(ctx, a);
      const itB = await buildEncryptedInput(ctx, b);
      const addTx = await ctx.contracts.mpcAdderAsCoti.write.add(
        [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.podTwoWayFees)
      );
      await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: addTx, ...receiptWaitOptions });

      const outbound = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);

      // --- Remote execution on COTI (miner batch) ---
      logStep("mine inbound request on COTI (MPC + response request creation)");
      const { requestIdUsed: cotiIncomingId } = await mineRequest(
        ctx,
        "coti",
        BigInt(ctx.chainIds.sepolia),
        outbound,
        "retry-pause: coti leg"
      );

      const responseRequest = await getResponseRequestBySource(
        ctx.contracts.inboxCoti,
        cotiIncomingId,
        "retry-pause: load return leg"
      );
      const returnRequestId = getTupleField(responseRequest, "requestId", 0) as `0x${string}`;
      assert.ok(returnRequestId && returnRequestId !== "0x" + "0".repeat(64), "return leg must have a request id");

      // --- Pause before callback: return leg must revert inside receiveC ---
      logStep("pause adder on Hardhat, then mine return leg (callback must revert)");
      const pauseTx = await ctx.contracts.mpcAdder.write.pause({
        account: ctx.sepolia.wallet.account,
      });
      await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: pauseTx, ...receiptWaitOptions });
      assert.equal(await ctx.contracts.mpcAdder.read.paused(), true);

      // `mineRequest` throws if the callback subcall fails (errorCode 1). Here that failure is intentional
      // (paused `receiveC`); we catch and assert so the test can verify on-chain `errors` + `retryFailedRequest`.
      try {
        await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "retry-pause: sepolia paused");
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

      const ctBeforeRetry = await ctx.contracts.mpcAdder.read.resultCiphertext();
      assert.equal(
        decodeCtUint64(ctBeforeRetry),
        0n,
        "receiveC must not have stored ciphertext when it reverted (paused)"
      );

      // --- Retry path: unpause, then anyone can pay gas to re-run the same encoded call ---
      logStep("unpause; retryFailedRequest on Hardhat inbox");
      const unpauseTx = await ctx.contracts.mpcAdder.write.unpause({
        account: ctx.sepolia.wallet.account,
      });
      await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: unpauseTx, ...receiptWaitOptions });
      assert.equal(await ctx.contracts.mpcAdder.read.paused(), false);

      const retryTx = await ctx.contracts.inboxSepolia.write.retryFailedRequest([returnRequestId], {
        account: ctx.sepolia.wallet.account,
        gas: 3_000_000n,
      });
      const retryReceipt = await ctx.sepolia.publicClient.waitForTransactionReceipt({
        hash: retryTx,
        ...receiptWaitOptions,
      });
      assert.equal(retryReceipt.status, "success", "retryFailedRequest must not revert");

      // Standard-ABI topic0 for `event RetryFailedRequestSuccess(bytes32 indexed requestId)`
      const retrySuccessTopic0 = keccak256(stringToBytes("RetryFailedRequestSuccess(bytes32)"));
      const retryLog = retryReceipt.logs.find(
        (l: { topics: readonly string[] }) => l.topics[0] === retrySuccessTopic0
      );
      assert.ok(retryLog, "expected RetryFailedRequestSuccess event in receipt logs");
      assert.equal(
        (retryLog!.topics[1] as string).toLowerCase(),
        returnRequestId.toLowerCase(),
        "indexed requestId in RetryFailedRequestSuccess must match the retried incoming request"
      );

      const errAfterRetry = await ctx.contracts.inboxSepolia.read.errors([returnRequestId]);
      const codeAfter = getTupleField(errAfterRetry, "errorCode", 1);
      assert.equal(
        BigInt(codeAfter !== undefined && codeAfter !== null ? (codeAfter as bigint) : 0),
        0n,
        "errors[requestId] must be cleared (errorCode 0) after delete errors[requestId] in retry"
      );

      const encryptedResult = await ctx.contracts.mpcAdder.read.resultCiphertext();
      const decrypted = decryptUint(decodeCtUint64(encryptedResult), ctx.crypto.userKey);
      assert.equal(
        decrypted,
        expectedSum,
        "decrypted MPC result must match a+b only after receiveC succeeded on retry"
      );
    }
  );
});
