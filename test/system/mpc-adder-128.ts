import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { network } from "hardhat";
import { toFunctionSelector, zeroHash } from "viem";
import { decryptUint } from "@coti-io/coti-sdk-typescript";
import {
  buildEncryptedInput128,
  collectInboxFeesAfterTest,
  decryptUint128,
  getLatestRequest,
  getResponseRequestBySource,
  logStep,
  podTwoWayWriteOptions,
  receiptWaitOptions,
} from "./mpc-test-utils.js";
import { mineRequest, setupContext128, type TestContext128 } from "./mpc-test-utils-128.js";

describe("MpcAdder128 (system)", { concurrency: 1 }, async function () {
  const { viem: sepoliaViem } = await network.connect({ network: "hardhat" });
  const { viem: cotiViem } = await network.connect({ network: "cotiTestnet" });

  let ctx: TestContext128;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  before(async function () {
    process.env.COTI_REUSE_CONTRACTS = "true";
    ctx = await setupContext128({ sepoliaViem, cotiViem });
  });

  it("Should create an outgoing MPC add128 request from Sepolia", async function () {
    const a = 12n;
    const b = 30n;

    logStep("Test1: encrypt 128-bit inputs");
    const itA = await buildEncryptedInput128(ctx, a);
    const itB = await buildEncryptedInput128(ctx, b);
    logStep("Test1: sending add()");
    const txHash = await ctx.contracts.mpcAdderAsCoti.write.add(
      [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.podTwoWayFees)
    );
    logStep(`Test1: waiting for tx ${txHash}`);
    await ctx.sepolia.publicClient.waitForTransactionReceipt({
      hash: txHash,
      ...receiptWaitOptions,
    });
    logStep("Test1: tx confirmed, fetching latest request");
    const request = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);

    const expectedSelector = toFunctionSelector(
      "add128(uint256,uint256,address)"
    );

    logStep("Test1: loaded request from hardhat inbox");
    assert.equal(Number(request.targetChainId), Number(ctx.chainIds.coti));
    assert.equal(
      request.targetContract.toLowerCase(),
      ctx.contracts.mpcExecutor.address.toLowerCase()
    );
    assert.equal(
      request.callerContract.toLowerCase(),
      ctx.contracts.mpcAdder.address.toLowerCase()
    );
    assert.equal(
      request.originalSender.toLowerCase(),
      ctx.contracts.mpcAdder.address.toLowerCase()
    );
    assert.equal(request.methodCall.selector, expectedSelector);
    assert.equal(request.isTwoWay, true);
    assert.equal(request.executed, false);
    assert.equal(request.sourceRequestId, zeroHash);
    assert.equal(request.callbackSelector, toFunctionSelector("receiveC(bytes)"));
    assert.equal(request.errorSelector, toFunctionSelector("onDefaultMpcError(bytes32)"));

    const { requestIdUsed: cotiRequestId } = await mineRequest(
      ctx,
      "coti",
      BigInt(ctx.chainIds.sepolia),
      request,
      "Test1"
    );
    const responseRequest = await getResponseRequestBySource(
      ctx.contracts.inboxCoti,
      cotiRequestId,
      "Test1"
    );
    await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "Test1");
  });

  it("Should execute the MPC add128 request on COTI and create a response", async function () {
    const a = 7n;
    const b = 9n;

    logStep("Test2: encrypt 128-bit inputs");
    const itA = await buildEncryptedInput128(ctx, a);
    const itB = await buildEncryptedInput128(ctx, b);
    logStep("Test2: sending add()");
    const txHash = await ctx.contracts.mpcAdderAsCoti.write.add(
      [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.podTwoWayFees)
    );
    logStep(`Test2: waiting for tx ${txHash}`);
    await ctx.sepolia.publicClient.waitForTransactionReceipt({
      hash: txHash,
      ...receiptWaitOptions,
    });
    logStep("Test2: tx confirmed, loading latest request");
    const request = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
    const { requestIdUsed: cotiRequestId } = await mineRequest(
      ctx,
      "coti",
      BigInt(ctx.chainIds.sepolia),
      request,
      "Test2"
    );
    logStep("Test2: COTI processed, fetching response");

    const response = await ctx.contracts.inboxCoti.read.getInboxResponse([cotiRequestId]);
    logStep("Test2: loaded inbox response on COTI");
    assert.ok(response);

    const responseRequest = await getResponseRequestBySource(
      ctx.contracts.inboxCoti,
      cotiRequestId,
      "Test2"
    );

    assert.equal(Number(responseRequest.targetChainId), ctx.chainIds.sepolia);
    assert.equal(
      responseRequest.targetContract.toLowerCase(),
      ctx.contracts.mpcAdder.address.toLowerCase()
    );
    assert.equal(responseRequest.isTwoWay, false);
    assert.equal(responseRequest.sourceRequestId, cotiRequestId);

    logStep("Test2: applying response on hardhat inbox");
    await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "Test2");
  });

  it("Should decrypt the MPC add128 result on Sepolia", async function () {
    const a = 15n;
    const b = 27n;

    logStep("Test3: encrypt 128-bit inputs");
    const itA = await buildEncryptedInput128(ctx, a);
    const itB = await buildEncryptedInput128(ctx, b);
    logStep("Test3: sending add()");
    const txHash = await ctx.contracts.mpcAdderAsCoti.write.add(
      [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.podTwoWayFees)
    );
    await ctx.sepolia.publicClient.waitForTransactionReceipt({
      hash: txHash,
      ...receiptWaitOptions,
    });
    const request = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
    const { requestIdUsed: cotiRequestId } = await mineRequest(
      ctx,
      "coti",
      BigInt(ctx.chainIds.sepolia),
      request,
      "Test3"
    );
    const responseRequest = await getResponseRequestBySource(
      ctx.contracts.inboxCoti,
      cotiRequestId,
      "Test3"
    );
    await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "Test3");

    const encryptedResult = await ctx.contracts.mpcAdder.read.resultCiphertext();
    const decrypted = decryptUint128(encryptedResult, ctx.crypto.userKey, decryptUint);
    assert.equal(decrypted, a + b);
    logStep(`Test3: decrypted result: ${decrypted}`);
  });

  it("Should handle large 128-bit values", async function () {
    const a = (1n << 65n) + 100n;
    const b = (1n << 65n) + 200n;

    logStep("Test4: encrypt large 128-bit inputs");
    const itA = await buildEncryptedInput128(ctx, a);
    const itB = await buildEncryptedInput128(ctx, b);
    logStep("Test4: sending add()");
    const txHash = await ctx.contracts.mpcAdderAsCoti.write.add(
      [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.podTwoWayFees)
    );
    await ctx.sepolia.publicClient.waitForTransactionReceipt({
      hash: txHash,
      ...receiptWaitOptions,
    });
    const request = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
    const { requestIdUsed: cotiRequestId } = await mineRequest(
      ctx,
      "coti",
      BigInt(ctx.chainIds.sepolia),
      request,
      "Test4"
    );
    const responseRequest = await getResponseRequestBySource(
      ctx.contracts.inboxCoti,
      cotiRequestId,
      "Test4"
    );
    await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "Test4");

    const encryptedResult = await ctx.contracts.mpcAdder.read.resultCiphertext();
    const decrypted = decryptUint128(encryptedResult, ctx.crypto.userKey, decryptUint);
    assert.equal(decrypted, a + b);
  });
});
