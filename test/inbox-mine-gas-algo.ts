/**
 * Pure unit tests for scripts/inbox-mine-gas.ts (no chain).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyUserGasBuffer,
  chooseMineGasLimit,
  estimateReplyOverhead,
  gasLimitHeadroomBps,
  planMineBatch,
  projectRequestMineGas,
  selectBatchByProjectedGas,
  DEFAULT_MINE_GAS_CONFIG,
} from "../scripts/inbox-mine-gas.js";

describe("inbox-mine-gas algorithm", () => {
  it("applyUserGasBuffer rounds up BPS", () => {
    assert.equal(applyUserGasBuffer(1000n, { userGasBufferBps: 500n, userGasBufferAbsolute: 0n }), 1050n);
    assert.equal(applyUserGasBuffer(1n, { userGasBufferBps: 500n, userGasBufferAbsolute: 10n }), 12n);
  });

  it("estimateReplyOverhead uses max(response, error) size", () => {
    const cfg = { replyBaseGas: 100n, replyGasPerByte: 2n };
    assert.equal(estimateReplyOverhead({ responseDataSize: 0n, errorDataSize: 0n }, cfg), 0n);
    assert.equal(estimateReplyOverhead({ responseDataSize: 10n, errorDataSize: 0n }, cfg), 120n);
    assert.equal(estimateReplyOverhead({ responseDataSize: 5n, errorDataSize: 20n }, cfg), 140n);
  });

  it("selectBatchByProjectedGas packs greedily and always takes first", () => {
    const items = ["a", "b", "c"];
    const projections = [
      projectRequestMineGas({ gasUsed: 1_000_000n, responseDataSize: 0n, errorDataSize: 0n }, {
        ...DEFAULT_MINE_GAS_CONFIG,
        userGasBufferBps: 0n,
        perRequestOverhead: 0n,
        postCallGasReserve: 0n,
      }),
      projectRequestMineGas({ gasUsed: 1_000_000n, responseDataSize: 0n, errorDataSize: 0n }, {
        ...DEFAULT_MINE_GAS_CONFIG,
        userGasBufferBps: 0n,
        perRequestOverhead: 0n,
        postCallGasReserve: 0n,
      }),
      projectRequestMineGas({ gasUsed: 1_000_000n, responseDataSize: 0n, errorDataSize: 0n }, {
        ...DEFAULT_MINE_GAS_CONFIG,
        userGasBufferBps: 0n,
        perRequestOverhead: 0n,
        postCallGasReserve: 0n,
      }),
    ];
    const packed = selectBatchByProjectedGas(items, projections, {
      maxBatchGas: DEFAULT_MINE_GAS_CONFIG.batchBaseOverhead + 2_000_000n,
      batchBaseOverhead: DEFAULT_MINE_GAS_CONFIG.batchBaseOverhead,
    });
    assert.deepEqual(packed.selected, ["a", "b"]);
    assert.equal(packed.selectedProjections.length, 2);
  });

  it("chooseMineGasLimit takes the max", () => {
    assert.equal(chooseMineGasLimit(100n, 200n), 200n);
    assert.equal(chooseMineGasLimit(300n, 200n), 300n);
  });

  it("planMineBatch integrates estimate + pack + eth_estimateGas", async () => {
    const plan = await planMineBatch({
      requests: [1, 2, 3],
      config: {
        userGasBufferBps: 0n,
        userGasBufferAbsolute: 0n,
        maxBatchGas: 2_500_000n,
        perRequestOverhead: 0n,
        postCallGasReserve: 0n,
        batchBaseOverhead: 0n,
        replyBaseGas: 0n,
        replyGasPerByte: 0n,
        maxUserGas: 5_000_000n,
      },
      estimateRequest: async () => ({
        gasUsed: 1_000_000n,
        responseDataSize: 0n,
        errorDataSize: 0n,
      }),
      estimateTxGas: async () => 1_800_000n,
    });
    assert.deepEqual(plan.selected, [1, 2]);
    assert.equal(plan.projectedBatchGas, 2_000_000n);
    assert.equal(plan.ethEstimateGas, 1_800_000n);
    assert.equal(plan.gasLimit, 2_000_000n);
  });

  it("gasLimitHeadroomBps reports under-limit as -1", () => {
    assert.equal(gasLimitHeadroomBps(110n, 100n), 1000n);
    assert.equal(gasLimitHeadroomBps(90n, 100n), -1n);
  });
});
