/**
 * Inbox / portal native token legs per chain.
 *
 * Prefer `oracle.legs` from the active deploy config YAML.
 * Falls back to well-known test/local mappings for Hardhat / sim ids.
 */
import { readDeployConfigSync } from "./deploy-config.js";

/** Sentinel token address for COTI native USD pricing (manual peg only on most chains). */
export const ORACLE_REMOTE_COTI_TOKEN = "0x000000000000000000000000000000000000C071" as const;

const SEPOLIA_WETH = "0x7b79995e5f793A07Bc00c21412e50Ecae098E7f9" as const;
const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as const;
const FUJI_WAVAX = "0xd00ae08403B9bbb9124bB305C09058E32C39A48c" as const;
const AVALANCHE_WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7" as const;

export type OracleTokenLegs = {
  localToken: `0x${string}`;
  remoteToken: `0x${string}`;
  portalNative: `0x${string}`;
};

const isAddr = (v: unknown): v is `0x${string}` =>
  typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);

const FALLBACK_LEGS: Record<number, OracleTokenLegs> = {
  1: { localToken: MAINNET_WETH, remoteToken: ORACLE_REMOTE_COTI_TOKEN, portalNative: MAINNET_WETH },
  11155111: { localToken: SEPOLIA_WETH, remoteToken: ORACLE_REMOTE_COTI_TOKEN, portalNative: SEPOLIA_WETH },
  31337: { localToken: SEPOLIA_WETH, remoteToken: ORACLE_REMOTE_COTI_TOKEN, portalNative: SEPOLIA_WETH },
  43113: { localToken: FUJI_WAVAX, remoteToken: ORACLE_REMOTE_COTI_TOKEN, portalNative: FUJI_WAVAX },
  43114: { localToken: AVALANCHE_WAVAX, remoteToken: ORACLE_REMOTE_COTI_TOKEN, portalNative: AVALANCHE_WAVAX },
  7082400: {
    localToken: ORACLE_REMOTE_COTI_TOKEN,
    remoteToken: SEPOLIA_WETH,
    portalNative: ORACLE_REMOTE_COTI_TOKEN,
  },
  2632500: {
    localToken: ORACLE_REMOTE_COTI_TOKEN,
    remoteToken: AVALANCHE_WAVAX,
    portalNative: ORACLE_REMOTE_COTI_TOKEN,
  },
  /** Legacy sim-coti chain id (pre mainnet/testnet profiles). */
  7082401: {
    localToken: ORACLE_REMOTE_COTI_TOKEN,
    remoteToken: SEPOLIA_WETH,
    portalNative: ORACLE_REMOTE_COTI_TOKEN,
  },
};

/** Inbox leg + portal native token addresses per chain. */
export const oracleTokensForChain = (chainId: number): OracleTokenLegs => {
  try {
    const chain = readDeployConfigSync().chains?.[String(chainId)];
    const legs = chain?.oracle?.legs;
    if (legs && isAddr(legs.localToken) && isAddr(legs.remoteToken) && isAddr(legs.portalNative)) {
      return {
        localToken: legs.localToken,
        remoteToken: legs.remoteToken,
        portalNative: legs.portalNative,
      };
    }
  } catch {
    // ignore missing config in unit tests
  }

  // Hardhat e2e retry aliases (313370000+) that isolate COTI inbound nonces.
  if (chainId >= 313_370_000) {
    return FALLBACK_LEGS[31337];
  }
  const cotiTestnetId = Number(process.env.COTI_TESTNET_CHAIN_ID || "7082400");
  const simCotiId = Number(process.env.SIM_COTI_CHAIN_ID || "2632500");
  if (chainId === cotiTestnetId) return FALLBACK_LEGS[7082400];
  if (chainId === simCotiId) return FALLBACK_LEGS[simCotiId] ?? FALLBACK_LEGS[2632500];
  if (chainId === 7082401) return FALLBACK_LEGS[7082401];

  const fallback = FALLBACK_LEGS[chainId];
  if (fallback) return fallback;

  throw new Error(
    `Unsupported chainId ${chainId} for oracle token addresses — set chains.${chainId}.oracle.legs in deploy config`
  );
};
