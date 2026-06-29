/**
 * Poll Blockscout for ERC-7984 token recognition and confidential transfer rows.
 *
 * Run against a deployed verified pToken + portal on a Blockscout-backed network:
 *   ERC7984_EXPLORER_TESTS=1 \
 *   ERC7984_PTOKEN=0x... \
 *   ERC7984_PORTAL=0x... \
 *   ERC7984_BLOCKSCOUT_API=https://eth.blockscout.com/api/v2 \
 *   npm run test:erc7984-explorer
 *
 * Optional transaction hashes to inspect after manual flows:
 *   ERC7984_DEPOSIT_TX=0x...
 *   ERC7984_TRANSFER_TX=0x...
 *   ERC7984_WITHDRAW_TX=0x...
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const run = process.env.ERC7984_EXPLORER_TESTS === "1";
const d = run ? describe : describe.skip;

const log = (step: string, detail?: unknown) => {
  const suffix = detail === undefined ? "" : ` ${typeof detail === "string" ? detail : JSON.stringify(detail, null, 2)}`;
  console.log(`[erc7984-explorer] ${step}${suffix}`);
};

type BlockscoutToken = {
  type?: string;
  name?: string;
  symbol?: string;
  decimals?: string;
};

type BlockscoutTokenTransfer = {
  token_type?: string;
  type?: string;
  total?: { value?: string | null; decimals?: string };
  token?: { address_hash?: string; type?: string };
};

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  return (await res.json()) as T;
}

async function pollTokenType(apiBase: string, token: string, attempts = 12, delayMs = 5_000) {
  for (let i = 0; i < attempts; i++) {
    const data = await fetchJson<BlockscoutToken>(`${apiBase}/tokens/${token}`);
    log(`token poll ${i + 1}/${attempts}`, data);
    if (data.type === "ERC-7984") {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  throw new Error(`Token ${token} was not classified as ERC-7984`);
}

async function inspectTx(apiBase: string, txHash: string, label: string) {
  log(`inspect ${label}`, txHash);
  const data = await fetchJson<{ items?: BlockscoutTokenTransfer[] }>(
    `${apiBase}/transactions/${txHash}/token-transfers`
  );
  log(`${label} token-transfers`, data.items ?? []);
  const erc7984Rows = (data.items ?? []).filter((row) => row.token_type === "ERC-7984");
  assert.ok(erc7984Rows.length > 0, `${label}: expected at least one ERC-7984 token transfer row`);
  for (const row of erc7984Rows) {
    assert.equal(row.total?.value ?? null, null, `${label}: ERC-7984 amount should be confidential/null`);
  }
  return data.items ?? [];
}

d("ERC-7984 Blockscout explorer verification", { concurrency: 1 }, async function () {
  const apiBase = process.env.ERC7984_BLOCKSCOUT_API ?? "https://eth.blockscout.com/api/v2";
  const pToken = process.env.ERC7984_PTOKEN;
  const portal = process.env.ERC7984_PORTAL;

  assert.ok(pToken, "ERC7984_PTOKEN is required");
  log("config", { apiBase, pToken, portal });

  it("classifies pToken as ERC-7984", async function () {
    const token = await pollTokenType(apiBase, pToken!);
    assert.equal(token.type, "ERC-7984");
    assert.ok(token.name);
    assert.ok(token.symbol);
    log("token recognized", token);
  });

  for (const [envKey, label] of [
    ["ERC7984_DEPOSIT_TX", "deposit/wrap"],
    ["ERC7984_TRANSFER_TX", "confidential transfer"],
    ["ERC7984_WITHDRAW_TX", "withdraw/unwrap"],
  ] as const) {
    const txHash = process.env[envKey];
    if (!txHash) {
      it(`skips ${label} when ${envKey} unset`, function () {
        log(`skip ${label}`, `${envKey} not set`);
      });
      continue;
    }
    it(`indexes ${label} tx ${txHash}`, async function () {
      await inspectTx(apiBase, txHash, label);
    });
  }
});
