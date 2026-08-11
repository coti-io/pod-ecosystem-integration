import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import "@nomicfoundation/hardhat-verify";
import hardhatToolboxViemPlugin from "@nomicfoundation/hardhat-toolbox-viem";
import { configVariable, defineConfig } from "hardhat/config";

const require = createRequire(import.meta.url);

const envOrConfig = (key: string) => process.env[key] ?? configVariable(key);
const privateKeyFor = (key: string) =>
  process.env[key] ?? process.env.PRIVATE_KEY ?? configVariable(key);

/** Resolve an installed package's root directory (works when package.json is not exported). */
const resolvePackageRoot = (packageName: string): string => {
  const direct = path.join(process.cwd(), "node_modules", ...packageName.split("/"));
  if (fs.existsSync(path.join(direct, "package.json"))) return direct;
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    const probe = require.resolve(packageName);
    let dir = path.dirname(probe);
    while (dir !== path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, "package.json"))) return dir;
      dir = path.dirname(dir);
    }
    throw new Error(`Cannot resolve package root for ${packageName}`);
  }
};

/** Collect `.sol` roots from an installed package for Hardhat `npmFilesToBuild`. */
const npmSolidityRoots = (packageName: string, subdir: string, opts?: { skipTestDir?: boolean }): string[] => {
  const pkgRoot = resolvePackageRoot(packageName);
  const root = path.join(pkgRoot, subdir);
  if (!fs.existsSync(root)) {
    throw new Error(`Missing Solidity tree for ${packageName}: ${root}`);
  }
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        if (opts?.skipTestDir && ent.name === "test") continue;
        walk(full);
        continue;
      }
      if (ent.name.endsWith(".sol")) {
        const rel = path.relative(pkgRoot, full).split(path.sep).join("/");
        out.push(`${packageName}/${rel}`);
      }
    }
  };
  walk(root);
  return out.sort();
};

/** Inbox + coti-contracts pod/oracle + sim-coti — no link-contracts mirror. */
const npmFilesToBuild = [
  ...npmSolidityRoots("@coti-io/coti-pod-inbox-contracts", "contracts", { skipTestDir: true }),
  // L-15 moved harness/mocks under test/contracts (not shipped in the npm package `files`, but present via file: link).
  ...npmSolidityRoots("@coti-io/coti-pod-inbox-contracts", "test/contracts"),
  ...npmSolidityRoots("@coti-io/coti-contracts", "contracts/pod"),
  ...npmSolidityRoots("@coti-io/coti-contracts", "contracts/oracle"),
  ...npmSolidityRoots("@coti-io/coti-contracts", "contracts/utils/mpc"),
  ...npmSolidityRoots("@coti-io/sim-coti-node", "contracts", { skipTestDir: true }),
];


/** COTI testnet: prefer dedicated key, then `_PRIVATE_KEY` (miner / alternate account in `.env`), then `PRIVATE_KEY`. */
const privateKeyForCotiTestnet = () =>
  process.env.COTI_TESTNET_PRIVATE_KEY?.trim() ||
  process.env._PRIVATE_KEY?.trim() ||
  process.env.PRIVATE_KEY?.trim() ||
  configVariable("PRIVATE_KEY");

/** Hardhat mnemonic account #0 — used by `COTI_BACKEND=sim` dual-chain tests. */
const HARDHAT_DEFAULT_PK0 =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

/** Unique 0x-prefixed keys for Hardhat / COTI test wallets (order preserved). */
const collectTestPrivateKeys = (): `0x${string}`[] => {
  const raw = [
    process.env.PRIVATE_KEY?.trim(),
    process.env.COTI_TESTNET_PRIVATE_KEY?.trim(),
    process.env._PRIVATE_KEY?.trim(),
    process.env.PRIVATE_KEY_ACCOUNT_2?.trim(),
    process.env.SEPOLIA_PRIVATE_KEY?.trim(),
  ].filter((k): k is string => !!k);
  const seen = new Set<string>();
  const out: `0x${string}`[] = [];
  for (const key of raw) {
    const normalized = (key.startsWith("0x") ? key : `0x${key}`).toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized as `0x${string}`);
    }
  }
  // Append Hardhat #0 so sim dual-chain `getWalletClient` can unlock it without reordering wallet[0].
  if (!seen.has(HARDHAT_DEFAULT_PK0)) {
    out.push(HARDHAT_DEFAULT_PK0);
  }
  return out;
};

const hardhatTestAccounts = () =>
  collectTestPrivateKeys().map((privateKey) => ({
    privateKey,
    balance: "100000000000000000000",
  }));

const cotiTestnetAccounts = () => collectTestPrivateKeys();

export default defineConfig({
  plugins: [hardhatToolboxViemPlugin],
  // Local dir stays empty; real sources are npm package files below.
  paths: {
    sources: "./contracts",
  },
  verify: {
    etherscan: {
      apiKey: envOrConfig("ETHERSCAN_API_KEY"),
      enabled: true,
    },
  },
  chainDescriptors: {
    7082400: {
      name: "COTI Testnet",
      chainType: "generic",
      blockExplorers: {
        blockscout: {
          name: "COTI Testnet Blockscout",
          url: "https://testnet.cotiscan.io",
          apiUrl: "https://testnet.cotiscan.io/api",
        },
      },
    },
    2632500: {
      name: "COTI Mainnet",
      chainType: "generic",
      blockExplorers: {
        blockscout: {
          name: "COTI Mainnet Blockscout",
          url: "https://mainnet.cotiscan.io",
          apiUrl: "https://mainnet.cotiscan.io/api",
        },
      },
    },
    7082401: {
      name: "simCoti",
      chainType: "generic",
    },
    43113: {
      name: "Avalanche Fuji",
      chainType: "l1",
      blockExplorers: {
        etherscan: {
          name: "Snowscan (Fuji)",
          url: "https://testnet.snowscan.xyz",
          apiUrl: "https://api.etherscan.io/v2/api",
        },
      },
    },
    43114: {
      name: "Avalanche C-Chain",
      chainType: "l1",
      blockExplorers: {
        etherscan: {
          name: "Snowscan",
          url: "https://snowscan.xyz",
          apiUrl: "https://api.etherscan.io/v2/api",
        },
      },
    },
  },
  solidity: {
    // Must be ≥0.8.20 for @openzeppelin/contracts@5.x (e.g. Ownable).
    // Do not set `path` to soljson.js — that forces the WASM compiler, which OOMs on
    // aarch64 when compiling vendored MpcCore.sol. Let Hardhat download the native
    // linux-arm64 binary instead (see preferWasm: false).
    //
    // `paris`: COTI testnet rejects Shanghai `PUSH0`. Keep the whole tree on Paris so
    // Inbox / MpcExecutor / mothers deploy without Shanghai+ opcodes.
    version: "0.8.28",
    preferWasm: false,
    npmFilesToBuild,
    settings: {
      evmVersion: "paris",
      viaIR: true,
      optimizer: {
        enabled: true,
        // Match inbox package: minimize create size (Spurious Dragon 24_576).
        runs: 1,
      },
      metadata: {
        bytecodeHash: "none",
      },
    },
  },
  // Configure the default hardhat network
  // Chain ID can be overridden via HARDHAT_CHAIN_ID environment variable
  networks: {
    hardhat: {
      type: "edr-simulated",
      chainId: parseInt(process.env.HARDHAT_CHAIN_ID || "31337"),
      accounts: hardhatTestAccounts().length > 0 ? hardhatTestAccounts() : undefined,
    },
    hardhatMainnet: {
      type: "edr-simulated",
      chainType: "l1",
    },
    hardhatOp: {
      type: "edr-simulated",
      chainType: "op",
    },
    sepolia: {
      type: "http",
      chainType: "l1",
      url: envOrConfig("SEPOLIA_RPC_URL"),
      accounts: [privateKeyFor("SEPOLIA_PRIVATE_KEY")],
    },
    cotiTestnet: {
      type: "http",
      chainType: "l1",
      chainId: 7082400,
      url: envOrConfig("COTI_TESTNET_RPC_URL"),
      accounts: cotiTestnetAccounts(),
    },
    // In-process simCoti (fake MPC precompile). Used when COTI_BACKEND=sim.
    simCoti: {
      type: "edr-simulated",
      chainId: parseInt(process.env.SIM_COTI_CHAIN_ID || "7082401"),
      accounts: hardhatTestAccounts().length > 0 ? hardhatTestAccounts() : undefined,
    },
    localSimCoti: {
      type: "http",
      chainType: "l1",
      chainId: parseInt(process.env.SIM_COTI_CHAIN_ID || "7082401"),
      url: process.env.SIM_COTI_RPC_URL ?? "http://127.0.0.1:8546",
      accounts: cotiTestnetAccounts(),
    },
    localSepolia: {
      type: "http",
      chainType: "l1",
      chainId: 31337,
      url: process.env.LOCAL_SEPOLIA_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: cotiTestnetAccounts(),
    },
    avalancheFuji: {
      type: "http",
      chainType: "l1",
      chainId: 43113,
      url:
        process.env.AVALANCHE_FUJI_RPC_URL ??
        "https://avalanche-fuji-c-chain-rpc.publicnode.com",
      accounts: [privateKeyFor("AVALANCHE_FUJI_PRIVATE_KEY")],
    },
    ethereum: {
      type: "http",
      chainType: "l1",
      chainId: 1,
      url:
        process.env.ETHEREUM_RPC_URL ??
        process.env.MAINNET_RPC_URL ??
        "https://ethereum-rpc.publicnode.com",
      accounts: [privateKeyFor("ETHEREUM_PRIVATE_KEY")],
    },
    avalanche: {
      type: "http",
      chainType: "l1",
      chainId: 43114,
      url:
        process.env.AVALANCHE_RPC_URL ??
        process.env.AVALANCHE_MAINNET_RPC_URL ??
        "https://avalanche-c-chain-rpc.publicnode.com",
      accounts: [privateKeyFor("AVALANCHE_PRIVATE_KEY")],
    },
    cotiMainnet: {
      type: "http",
      chainType: "l1",
      chainId: 2632500,
      url: process.env.COTI_MAINNET_RPC_URL ?? "https://mainnet.coti.io/rpc",
      accounts: cotiTestnetAccounts(),
    },
    // Local Anvil / fork endpoints (see `npm run fork:cli`)
    forkSource: {
      type: "http",
      chainType: "l1",
      chainId: parseInt(process.env.SOURCE_FORK_CHAIN_ID || "43114"),
      url: process.env.SOURCE_FORK_RPC_URL ?? "http://127.0.0.1:8545",
      accounts: cotiTestnetAccounts(),
    },
    forkCoti: {
      type: "http",
      chainType: "l1",
      chainId: parseInt(process.env.COTI_FORK_CHAIN_ID || "2632500"),
      url: process.env.COTI_FORK_RPC_URL ?? "http://127.0.0.1:8546",
      accounts: cotiTestnetAccounts(),
    },
    // Chain 1 for multichain message passing testing
    // Use in-process simulation to avoid external nodes in tests
    chain1: {
      type: "edr-simulated",
      chainId: 31337,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
      },
    },
    // Chain 2 for multichain message passing testing
    // Use in-process simulation to avoid external nodes in tests
    chain2: {
      type: "edr-simulated",
      chainId: 31338,
      accounts: {
        mnemonic: "test test test test test test test test test test test junk",
      },
    },
  },
});
