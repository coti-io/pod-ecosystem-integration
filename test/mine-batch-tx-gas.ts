/**
 * Pure checks for mineRequest outer-gas selection (no chain).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  HARDHAT_EDR_TX_GAS_CAP,
  minBatchTxGasForInnerStipend,
  resolveMineBatchTxGas,
  SYSTEM_INBOX_REMOTE_MIN_FEE,
} from "./system/mpc-test-utils.js";

describe("resolveMineBatchTxGas", () => {
  it("does not clamp an 18M remote stipend to the 2^24 EDR cap", () => {
    const targetFee = SYSTEM_INBOX_REMOTE_MIN_FEE.constantFee;
    const minBatch = minBatchTxGasForInnerStipend(targetFee);
    assert.ok(minBatch > HARDHAT_EDR_TX_GAS_CAP, "18M stipend already exceeds 2^24 outer gas");

    const gas = resolveMineBatchTxGas({
      chain: "coti",
      targetFee,
      requestedGas: 80_000_000n,
      edrCoti: true,
      cotiBlockGasLimit: 120_000_000n,
    });
    assert.ok(gas >= minBatch, `outer gas ${gas} must cover stipend floor ${minBatch}`);
    assert.ok(gas > HARDHAT_EDR_TX_GAS_CAP);
  });

  it("still trims cheap EDR mines that fit under 2^24", () => {
    const gas = resolveMineBatchTxGas({
      chain: "sepolia",
      targetFee: 1_000_000n,
      requestedGas: 80_000_000n,
      edrCoti: false,
      cotiBlockGasLimit: 120_000_000n,
    });
    assert.equal(gas, HARDHAT_EDR_TX_GAS_CAP);
  });
});
