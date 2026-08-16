#!/usr/bin/env node
/**
 * H-02: measure reference gas prices and suggested remote FeeConfig mul/div.
 *
 * FeeManager converts local wei → remote gas as:
 *   N = (W / g_local) * P_local / P_remote * (mul / div)
 * Break-even needs:
 *   N = W * P_local / (P_remote * g_remote)
 * so mul/div ≈ g_local / g_remote on the **remote** template.
 *
 * Reference g matches FeeManager: prefer baseFee (+0 priority), else eth_gasPrice,
 * then clamp to deployConfig gasPriceBounds.minGasPriceWei (and max if set).
 *
 * Usage:
 *   node scripts/measure-gas-price-skew.mjs
 *   LOCAL_RPC=... REMOTE_RPC=... LOCAL_MIN_WEI=... REMOTE_MIN_WEI=... node scripts/measure-gas-price-skew.mjs
 */

const DEFAULTS = [
  {
    name: "sepolia→coti-test",
    localRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    remoteRpc: "https://testnet.coti.io/rpc",
    localMinWei: 2_000_000_000n,
    remoteMinWei: 2_000_000_000n,
  },
  {
    name: "fuji→coti-test",
    localRpc: "https://api.avax-test.network/ext/bc/C/rpc",
    remoteRpc: "https://testnet.coti.io/rpc",
    localMinWei: 2_000_000_000n,
    remoteMinWei: 2_000_000_000n,
  },
  {
    name: "eth→coti-main",
    localRpc: "https://ethereum.publicnode.com",
    remoteRpc: "https://mainnet.coti.io/rpc",
    localMinWei: 2_000_000_000n,
    remoteMinWei: 2_000_000_000n,
  },
  {
    name: "avax→coti-main",
    localRpc: "https://api.avax.network/ext/bc/C/rpc",
    remoteRpc: "https://mainnet.coti.io/rpc",
    localMinWei: 25_000_000_000n,
    remoteMinWei: 2_000_000_000n,
  },
];

async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${url} ${method}: ${JSON.stringify(body.error)}`);
  return body.result;
}

async function referenceGasWei(url, minWei, maxWei = 0n) {
  const gp = BigInt(await rpc(url, "eth_gasPrice"));
  const block = await rpc(url, "eth_getBlockByNumber", ["latest", false]);
  const baseFee = BigInt(block?.baseFeePerGas ?? "0x0");
  let g = baseFee > 0n ? baseFee : gp;
  if (g < minWei) g = minWei;
  if (maxWei !== 0n && g > maxWei) g = maxWei;
  return { gp, baseFee, ref: g };
}

function approxRatio(numer, denom) {
  // Farey-style small uint16 fraction
  let best = { mul: 1n, div: 1n, err: Number.POSITIVE_INFINITY };
  for (let div = 1n; div <= 200n; div++) {
    const mul = (numer * div + denom / 2n) / denom;
    if (mul === 0n || mul > 65535n) continue;
    const err = Math.abs(Number(numer) / Number(denom) - Number(mul) / Number(div));
    if (err < best.err) best = { mul, div, err };
  }
  return best;
}

async function main() {
  const pairs =
    process.env.LOCAL_RPC && process.env.REMOTE_RPC
      ? [
          {
            name: "custom",
            localRpc: process.env.LOCAL_RPC,
            remoteRpc: process.env.REMOTE_RPC,
            localMinWei: BigInt(process.env.LOCAL_MIN_WEI ?? "2000000000"),
            remoteMinWei: BigInt(process.env.REMOTE_MIN_WEI ?? "2000000000"),
          },
        ]
      : DEFAULTS;

  console.log("H-02 gas-price skew measurement (FeeManager reference gas)\n");
  for (const p of pairs) {
    try {
      const local = await referenceGasWei(p.localRpc, p.localMinWei);
      const remote = await referenceGasWei(p.remoteRpc, p.remoteMinWei);
      const ratio = Number(local.ref) / Number(remote.ref);
      // Modest margin: if remote dearer (ratio<1), shrink further; else enlarge.
      const margined = ratio < 1 ? ratio * 0.9 : ratio * 1.1;
      const frac = approxRatio(BigInt(Math.max(1, Math.round(margined * 1e6))), 1_000_000n);
      console.log(p.name);
      console.log(
        `  local  gp=${local.gp} baseFee=${local.baseFee} ref=${local.ref} (${Number(local.ref) / 1e9} gwei)`
      );
      console.log(
        `  remote gp=${remote.gp} baseFee=${remote.baseFee} ref=${remote.ref} (${Number(remote.ref) / 1e9} gwei)`
      );
      console.log(
        `  raw g_local/g_remote=${ratio.toFixed(4)}; margined≈${margined.toFixed(4)} → suggest remote mul/div=${frac.mul}/${frac.div}`
      );
      console.log(`  inverse (swap direction) → ${frac.div}/${frac.mul}\n`);
    } catch (e) {
      console.log(`${p.name}: FAILED ${e.message}\n`);
    }
  }
  console.log(
    "Also sample oracle getPricesUSD on each inbox priceOracle when retuning prepaid vs mined gas cost."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
