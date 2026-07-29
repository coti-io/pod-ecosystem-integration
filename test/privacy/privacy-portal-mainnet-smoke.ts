/**
 * Read-only mainnet smoke checks against `deployConfig.mainnet.yaml`.
 *
 * Gate: `PP_MAINNET_SMOKE=1`
 *   DEPLOY_CONFIG=deployConfig.mainnet.yaml PP_MAINNET_SMOKE=1 npm run test:pp-mainnet-smoke
 *
 * Does NOT send deposits. Verifies config shape + optional on-chain code presence when addresses are set.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPublicClient, http, type Address } from "viem";
import { readDeployConfigSync, getDeployConfigPath } from "../../scripts/deploy-config.js";

const RUN = /^(1|true|yes|on)$/i.test(process.env.PP_MAINNET_SMOKE ?? "");
const d = RUN ? describe : describe.skip;

const isAddr = (v: unknown): v is Address =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v) && !/^0x0{40}$/i.test(v);

d("Privacy Portal mainnet smoke (read-only)", { concurrency: 1, timeout: 120_000 }, () => {
  process.env.DEPLOY_CONFIG = process.env.DEPLOY_CONFIG || "deployConfig.mainnet.yaml";

  it("loads mainnet deploy config with ETH + Avalanche + COTI chains", () => {
    const cfg = readDeployConfigSync();
    console.log(`config: ${getDeployConfigPath()}`);
    assert.ok(cfg.chains?.["1"], "missing Ethereum mainnet chain 1");
    assert.ok(cfg.chains?.["43114"], "missing Avalanche mainnet chain 43114");
    assert.ok(cfg.chains?.["2632500"], "missing COTI mainnet chain 2632500");
    assert.equal(cfg.forks?.enabled ?? false, false, "smoke expects LIVE config (forks.enabled=false)");
  });

  it("has oracle.legs and privacyPortalTokens on source chains", () => {
    const cfg = readDeployConfigSync();
    for (const id of ["1", "43114"]) {
      const chain = cfg.chains![id];
      assert.ok(chain.oracle?.legs?.localToken, `chains.${id}.oracle.legs.localToken`);
      assert.ok(chain.oracle?.legs?.portalNative, `chains.${id}.oracle.legs.portalNative`);
      const tokens = chain.privacyPortalTokens ?? {};
      assert.ok(Object.keys(tokens).length > 0, `chains.${id}.privacyPortalTokens empty`);
      for (const [key, entry] of Object.entries(tokens as Record<string, any>)) {
        assert.ok(entry.pName && entry.pSymbol, `${id}.${key} missing pName/pSymbol`);
        assert.ok(Number.isFinite(Number(entry.decimals)), `${id}.${key} missing decimals`);
      }
    }
  });

  it("optionally checks on-chain code when addresses are filled", async () => {
    const cfg = readDeployConfigSync();
    const rpcs: Record<string, string> = {
      "1": process.env.ETHEREUM_RPC_URL || "https://ethereum-rpc.publicnode.com",
      "43114": process.env.AVALANCHE_RPC_URL || "https://avalanche-c-chain-rpc.publicnode.com",
      "2632500": process.env.COTI_MAINNET_RPC_URL || "https://mainnet.coti.io/rpc",
    };
    for (const [id, rpc] of Object.entries(rpcs)) {
      const chain = cfg.chains![id];
      const client = createPublicClient({ transport: http(rpc) });
      for (const key of ["inbox", "priceOracle", "privacyPortalFactory", "cotiMother", "cotiExecutor"] as const) {
        const addr = chain[key];
        if (!isAddr(addr)) continue;
        const code = await client.getCode({ address: addr });
        assert.ok(code && code !== "0x", `${id}.${key} ${addr} has no code`);
        console.log(`  ok ${id}.${key}=${addr}`);
      }
    }
  });
});
