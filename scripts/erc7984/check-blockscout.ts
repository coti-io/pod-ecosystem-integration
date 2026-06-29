#!/usr/bin/env node
/**
 * CLI helper to inspect Blockscout ERC-7984 token + transfer indexing.
 *
 * Usage:
 *   npx tsx scripts/erc7984/check-blockscout.ts --token 0x... [--tx 0x...]
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    token: { type: "string" },
    tx: { type: "string" },
    api: { type: "string", default: "https://eth.blockscout.com/api/v2" },
  },
});

const log = (step: string, detail?: unknown) => {
  console.log(`[erc7984-explorer] ${step}`, detail ?? "");
};

async function main() {
  const token = values.token;
  if (!token) {
    throw new Error("--token is required");
  }
  const api = values.api!;

  log("fetch token", `${api}/tokens/${token}`);
  const tokenRes = await fetch(`${api}/tokens/${token}`);
  const tokenJson = await tokenRes.json();
  log("token", tokenJson);

  if (values.tx) {
    log("fetch token-transfers", `${api}/transactions/${values.tx}/token-transfers`);
    const txRes = await fetch(`${api}/transactions/${values.tx}/token-transfers`);
    const txJson = await txRes.json();
    log("token-transfers", txJson);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
