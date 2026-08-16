import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertRemoteGasPriceSkewConfigured,
  FEE_CONFIG_COTI_SIDE,
  FEE_CONFIG_SEPOLIA_SIDE,
  LIVE_LANE_REMOTE_GAS_PRICE_SKEW,
  testnetMinFeeConfigsForChain,
  type FeeConfigTuple,
} from "../../scripts/deploy-utils.js";

describe("H-02 remote gasPriceMul/Div deploy assert", () => {
  const base = (): { local: FeeConfigTuple; remote: FeeConfigTuple } => ({
    local: { ...FEE_CONFIG_SEPOLIA_SIDE },
    remote: { ...FEE_CONFIG_COTI_SIDE },
  });

  it("allows 1/1 on Hardhat 31337", () => {
    const pair = base();
    assert.equal(pair.remote.gasPriceMul, pair.remote.gasPriceDiv);
    assertRemoteGasPriceSkewConfigured(pair, { chainId: 31337 });
  });

  it("allows 1/1 when allowGasPriceSkewOneToOne is set", () => {
    const pair = base();
    assertRemoteGasPriceSkewConfigured(pair, {
      chainId: 11155111,
      allowGasPriceSkewOneToOne: true,
    });
  });

  it("refuses identity remote skew on Sepolia", () => {
    const pair = base();
    assert.throws(
      () => assertRemoteGasPriceSkewConfigured(pair, { chainId: 11155111 }),
      /must not be identity/
    );
  });

  it("builtins for live lanes apply measured remote skew", () => {
    const sepolia = testnetMinFeeConfigsForChain(11155111);
    assert.deepEqual(sepolia.remote.gasPriceMul, LIVE_LANE_REMOTE_GAS_PRICE_SKEW[11155111].mul);
    assert.deepEqual(sepolia.remote.gasPriceDiv, LIVE_LANE_REMOTE_GAS_PRICE_SKEW[11155111].div);
    assertRemoteGasPriceSkewConfigured(sepolia, { chainId: 11155111 });

    const coti = testnetMinFeeConfigsForChain(7082400);
    assert.deepEqual(coti.remote.gasPriceMul, LIVE_LANE_REMOTE_GAS_PRICE_SKEW[7082400].mul);
    assert.deepEqual(coti.remote.gasPriceDiv, LIVE_LANE_REMOTE_GAS_PRICE_SKEW[7082400].div);
    assertRemoteGasPriceSkewConfigured(coti, { chainId: 7082400 });
  });
});
