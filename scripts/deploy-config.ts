/**
 * Shared deploy-config loader (YAML).
 *
 * Default: `deployConfig.testnet.yaml`
 * Override: `DEPLOY_CONFIG=deployConfig.mainnet.yaml` (path relative to cwd or absolute)
 */
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export type DeployConfigForks = {
  enabled?: boolean;
  sourceRpc?: string;
  cotiRpc?: string;
  label?: string;
};

export type DeployConfig = {
  forks?: DeployConfigForks;
  inboxSalt?: Record<string, unknown>;
  roles?: Record<string, unknown>;
  chains?: Record<string, any>;
  [key: string]: unknown;
};

const DEFAULT_CONFIG = "deployConfig.testnet.yaml";

/** Absolute path to the active deploy config YAML. */
export const getDeployConfigPath = (): string => {
  const raw = process.env.DEPLOY_CONFIG?.trim() || DEFAULT_CONFIG;
  return path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
};

export const readDeployConfigSync = (): DeployConfig => {
  const filePath = getDeployConfigPath();
  const raw = fs.readFileSync(filePath, "utf8");
  return parseYaml(raw) as DeployConfig;
};

export const readDeployConfig = async (): Promise<DeployConfig> => {
  const filePath = getDeployConfigPath();
  const raw = await fsPromises.readFile(filePath, "utf8");
  return parseYaml(raw) as DeployConfig;
};

export const writeDeployConfig = async (cfg: DeployConfig): Promise<void> => {
  const filePath = getDeployConfigPath();
  const body = stringifyYaml(cfg, {
    lineWidth: 120,
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_SINGLE",
  });
  await fsPromises.writeFile(filePath, body.endsWith("\n") ? body : `${body}\n`, "utf8");
};

export const forksEnabled = (cfg?: DeployConfig): boolean => {
  const c = cfg ?? readDeployConfigSync();
  return Boolean(c.forks?.enabled);
};

export const forksLabel = (cfg?: DeployConfig): string => {
  const c = cfg ?? readDeployConfigSync();
  if (c.forks?.enabled) return c.forks.label?.trim() || "FORKED";
  return c.forks?.label?.trim() || "LIVE";
};

/** True when chainId is a mainnet source that pairs with COTI mainnet. */
export const isMainnetSourceChain = (chainId: number): boolean =>
  chainId === 1 || chainId === 43114;

export const COTI_TESTNET_CHAIN_ID = 7082400;
export const COTI_MAINNET_CHAIN_ID = 2632500;
/** sim-coti-node runtime chain id (local dry-run COTI — not an Anvil fork). */
export const SIM_COTI_CHAIN_ID = 7082401;

export const pairedCotiChainIdNumber = (sourceChainId: number): number =>
  isMainnetSourceChain(sourceChainId) ? COTI_MAINNET_CHAIN_ID : COTI_TESTNET_CHAIN_ID;

/**
 * Map runtime chain id → deployConfig SoT key.
 * When forks.enabled, sim-coti (7082401) aliases the COTI slot in the active YAML.
 */
export const soTChainId = (runtimeChainId: number, cfg?: DeployConfig): number => {
  if (runtimeChainId !== SIM_COTI_CHAIN_ID || !forksEnabled(cfg)) {
    return runtimeChainId;
  }
  try {
    const c = cfg ?? readDeployConfigSync();
    if (c.chains?.[String(COTI_MAINNET_CHAIN_ID)]) return COTI_MAINNET_CHAIN_ID;
    if (c.chains?.[String(COTI_TESTNET_CHAIN_ID)]) return COTI_TESTNET_CHAIN_ID;
  } catch {
    // ignore
  }
  return COTI_TESTNET_CHAIN_ID;
};

export const chainEntry = (cfg: DeployConfig, chainId: number | string): Record<string, any> => {
  cfg.chains ??= {};
  const key = String(soTChainId(Number(chainId), cfg));
  cfg.chains[key] ??= {};
  return cfg.chains[key] as Record<string, any>;
};

/** Hardhat network name for the COTI side paired with a source chain. */
export const pairedCotiNetworkName = (_sourceChainId: number): string => {
  if (forksEnabled()) {
    return process.env.COTI_FORK_NETWORK?.trim() || "localSimCoti";
  }
  return isMainnetSourceChain(_sourceChainId) ? "cotiMainnet" : "cotiTestnet";
};
