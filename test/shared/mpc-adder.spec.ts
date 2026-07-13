import assert from "node:assert/strict";
import { before, it } from "node:test";
import {
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  toFunctionSelector,
  zeroHash,
} from "viem";
import {
  buildEncryptedInput,
  decodeCtUint64,
  decryptUintForBackend,
  getLatestRequest,
  getResponseRequestBySource,
  getTupleField,
  logStep,
  mineRequest,
  podTwoWayWriteOptions,
  receiptWaitOptions,
  type TestContext,
} from "../system/mpc-test-utils.js";

export type MpcAdderTestDeps = {
  getContext: () => Promise<TestContext>;
  /** Called after context is ready (e.g. for fee sweep in afterEach). */
  onContext?: (ctx: TestContext) => void;
};

/**
 * Shared MpcAdder system tests — runs against simCoti or live testnet depending on harness.
 */
export function registerMpcAdderTests(deps: MpcAdderTestDeps): void {
  let ctx: TestContext;

  before(async function () {
    ctx = await deps.getContext();
    deps.onContext?.(ctx);
  });

  it("Should create an outgoing MPC request from Sepolia", async function () {
    const a = 12n;
    const b = 30n;

    logStep("Test1: encrypt inputs");
    const itA = await buildEncryptedInput(ctx, a);
    const itB = await buildEncryptedInput(ctx, b);
    logStep("Test1: sending add()");
    const txHash = await ctx.contracts.mpcAdderAsCoti.write.add(
      [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.podTwoWayFees)
    );
    logStep(`Test1: waiting for tx ${txHash}`);
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
    logStep("Test1: tx confirmed, fetching latest request");
    const request = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);

    const expectedSelector = toFunctionSelector("add64(uint256,uint256,address)");
    const encodedA = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "ciphertext", type: "uint256" },
            { name: "signature", type: "bytes" },
          ],
        },
      ],
      [itA]
    );
    const encodedB = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "ciphertext", type: "uint256" },
            { name: "signature", type: "bytes" },
          ],
        },
      ],
      [itB]
    );
    const encodedOwner = encodeAbiParameters(
      [{ type: "address" }],
      [ctx.coti.wallet.account.address]
    );
    const expectedArgsData = `0x${encodedA.slice(2)}${encodedB.slice(2)}${encodedOwner.slice(2)}`;

    logStep("Test1: loaded request from hardhat inbox");
    assert.equal(Number(request.targetChainId), Number(ctx.chainIds.coti));
    assert.equal(request.targetContract.toLowerCase(), ctx.contracts.mpcExecutor.address.toLowerCase());
    assert.equal(request.callerContract.toLowerCase(), ctx.contracts.mpcAdder.address.toLowerCase());
    assert.equal(request.originalSender.toLowerCase(), ctx.contracts.mpcAdder.address.toLowerCase());
    assert.equal(request.methodCall.selector, expectedSelector);
    assert.equal(request.methodCall.data, expectedArgsData);
    assert.equal(request.isTwoWay, true);
    assert.equal(request.executed, false);
    assert.equal(request.sourceRequestId, zeroHash);
    assert.equal(request.callbackSelector, toFunctionSelector("receiveC(bytes)"));
    assert.equal(request.errorSelector, toFunctionSelector("onDefaultMpcError(bytes32)"));

    const { requestIdUsed: cotiRequestId } = await mineRequest(ctx, "coti", BigInt(ctx.chainIds.sepolia), request, "Test1");
    const responseRequest = await getResponseRequestBySource(ctx.contracts.inboxCoti, cotiRequestId, "Test1");
    await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "Test1");
  });

  it("Should execute the MPC request on COTI and create a response", async function () {
    const a = 7n;
    const b = 9n;

    logStep("Test2: encrypt inputs");
    const itA = await buildEncryptedInput(ctx, a);
    const itB = await buildEncryptedInput(ctx, b);
    logStep("Test2: sending add()");
    const txHash = await ctx.contracts.mpcAdderAsCoti.write.add(
      [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.podTwoWayFees)
    );
    logStep(`Test2: waiting for tx ${txHash}`);
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
    logStep("Test2: tx confirmed, loading latest request");
    const request = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
    const { requestIdUsed: cotiRequestId } = await mineRequest(ctx, "coti", BigInt(ctx.chainIds.sepolia), request, "Test2");
    logStep("Test2: COTI processed, fetching response");

    let response: unknown;
    try {
      response = await ctx.contracts.inboxCoti.read.getInboxResponse([cotiRequestId]);
      logStep("Test2: loaded inbox response on COTI");
    } catch (error) {
      const inboxError = await ctx.contracts.inboxCoti.read.errors([cotiRequestId]);
      const errorCode = getTupleField(inboxError, "errorCode", 1);
      const errorMessage = getTupleField(inboxError, "errorMessage", 2);
      logStep(`Test2: no response, errorCode=${errorCode} errorMessage=${errorMessage}`);
      throw error;
    }
    assert.ok(response);

    const responseRequest = await getResponseRequestBySource(ctx.contracts.inboxCoti, cotiRequestId, "Test2");

    const responseRequestId = getTupleField(responseRequest, "requestId", 0);
    assert.ok(responseRequestId);
    assert.equal(Number(responseRequest.targetChainId), ctx.chainIds.sepolia);
    assert.equal(responseRequest.targetContract.toLowerCase(), ctx.contracts.mpcAdder.address.toLowerCase());
    assert.equal(responseRequest.isTwoWay, false);
    assert.equal(responseRequest.sourceRequestId, cotiRequestId);
    assert.equal(responseRequest.callbackSelector ?? "0x00000000", "0x00000000");
    assert.equal(responseRequest.errorSelector ?? "0x00000000", toFunctionSelector("onDefaultMpcError(bytes32)"));
    assert.equal(responseRequest.methodCall.selector, "0x00000000");
    const receiveCSelector = toFunctionSelector("receiveC(bytes)");
    const responseDataHex = responseRequest.methodCall.data as `0x${string}`;
    assert.ok(responseDataHex.startsWith(receiveCSelector));
    const expectedResponseData = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "receiveC",
          stateMutability: "nonpayable",
          inputs: [{ name: "data", type: "bytes" }],
          outputs: [],
        },
      ],
      functionName: "receiveC",
      args: [response],
    }).toLowerCase();
    assert.equal(responseDataHex.toLowerCase(), expectedResponseData);
    const [decodedCiphertext] = decodeAbiParameters([{ type: "uint256" }], response);
    assert.ok(decodedCiphertext);

    logStep("Test2: applying response on hardhat inbox");
    await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "Test2");
    logStep("Test2: response applied on hardhat");
  });

  it("Should decrypt the MPC result on Sepolia", async function () {
    const a = 15n;
    const b = 27n;

    logStep("Test3: encrypt inputs");
    const itA = await buildEncryptedInput(ctx, a);
    const itB = await buildEncryptedInput(ctx, b);
    logStep("Test3: sending add()");
    const txHash = await ctx.contracts.mpcAdderAsCoti.write.add(
      [itA, itB, ctx.podTwoWayFees.callbackFeeWei],
      podTwoWayWriteOptions(ctx.podTwoWayFees)
    );
    logStep(`Test3: waiting for tx ${txHash}`);
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
    logStep("Test3: tx confirmed, loading latest request");
    const request = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
    const { requestIdUsed: cotiRequestId } = await mineRequest(
      ctx,
      "coti",
      BigInt(ctx.chainIds.sepolia),
      request,
      "Test3"
    );
    logStep("Test3: COTI processed, applying response on hardhat");

    const responseRequest = await getResponseRequestBySource(ctx.contracts.inboxCoti, cotiRequestId, "Test3");

    logStep("Test3: applying response on hardhat inbox");
    await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, "Test3");
    logStep("Test3: response applied, decrypting result");

    const encryptedResult = await ctx.contracts.mpcAdder.read.resultCiphertext();
    const decrypted = decryptUintForBackend(decodeCtUint64(encryptedResult), ctx.crypto.userKey);
    assert.equal(decrypted, a + b);
  });
}
