#!/usr/bin/env node
/**
 * Bundle deploy-cli into a single JS file for server shipping.
 *
 * Output: dist/deploy-cli.js (ESM)
 *
 * Server layout (see docs/mainnet/03-cli-pack-and-ship.md):
 *   repo/ (or prepared tree)
 *     dist/deploy-cli.js
 *     deployConfig.mainnet.yaml / deployConfig.testnet.yaml
 *     hardhat.config.ts
 *     artifacts/
 *     node_modules/ (hardhat + peers)
 *
 * Run: node dist/deploy-cli.js [--verify-all] [--noverify]
 */
import * as esbuild from "esbuild";
import path from "node:path";
import fs from "node:fs";

const outdir = path.resolve(process.cwd(), "dist");
fs.mkdirSync(outdir, { recursive: true });

await esbuild.build({
  entryPoints: [path.resolve(process.cwd(), "scripts/deploy-cli.ts")],
  outfile: path.join(outdir, "deploy-cli.js"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  sourcemap: true,
  // Keep hardhat / native tooling external — they need the full install.
  external: [
    "hardhat",
    "hardhat/*",
    "@nomicfoundation/*",
    "viem",
    "viem/*",
    "yaml",
    "dotenv",
    "@coti-io/*",
    "ethers",
    "solc",
  ],
  banner: {
    js: `import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);`,
  },
  logLevel: "info",
});

console.log(`[pack] Wrote ${path.join(outdir, "deploy-cli.js")}`);
console.log(`[pack] Run with: node --import tsx dist/deploy-cli.js   OR   node dist/deploy-cli.js (if all deps resolve)`);
