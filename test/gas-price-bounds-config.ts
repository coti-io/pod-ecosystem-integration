import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertGasPriceBoundsForDeploy,
  DEFAULT_GAS_PRICE_BOUNDS,
  readGasPriceBoundsForChainSync,
  type GasPriceBoundsTuple,
} from "../scripts/deploy-utils.js";

describe("deploy gasPriceBounds config", () => {
  it("loads explicit bounds from deployConfig (no silent default)", () => {
    const bounds = readGasPriceBoundsForChainSync(11155111);
    assert.ok(bounds.minGasPriceWei > 0n);
    // Sepolia is EIP-1559: ceiling may be zero (disabled).
    assert.equal(typeof bounds.maxGasPriceWei, "bigint");
  });

  it("requires a non-zero ceiling on COTI", () => {
    const coti = readGasPriceBoundsForChainSync(7082400);
    assert.ok(coti.maxGasPriceWei > 0n, "COTI must ship an explicit maxGasPriceWei");
    assertGasPriceBoundsForDeploy(coti, 7082400);
  });

  it("rejects COTI bounds that omit the ceiling", () => {
    const bad: GasPriceBoundsTuple = { ...DEFAULT_GAS_PRICE_BOUNDS, maxGasPriceWei: 0n };
    assert.throws(() => assertGasPriceBoundsForDeploy(bad, 7082400), /maxGasPriceWei must be non-zero on COTI/);
  });

  it("rejects a zero minGasPriceWei", () => {
    const bad: GasPriceBoundsTuple = {
      minPriorityFeeWei: 0n,
      minGasPriceWei: 0n,
      maxGasPriceWei: 50_000_000_000n,
    };
    assert.throws(() => assertGasPriceBoundsForDeploy(bad, 11155111), /minGasPriceWei must be non-zero/);
  });
});
