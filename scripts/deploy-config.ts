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

export const chainEntry = (cfg: DeployConfig, chainId: number | string): Record<string, any> => {
  cfg.chains ??= {};
  const key = String(chainId);
  cfg.chains[key] ??= {};
  return cfg.chains[key] as Record<string, any>;
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

export const pairedCotiChainIdNumber = (sourceChainId: number): number =>
  isMainnetSourceChain(sourceChainId) ? COTI_MAINNET_CHAIN_ID : COTI_TESTNET_CHAIN_ID;

/** Hardhat network name for the COTI side paired with a source chain. */
export const pairedCotiNetworkName = (sourceChainId: number): string => {
  if (forksEnabled()) {
    return process.env.COTI_FORK_NETWORK?.trim() || "localSimCoti";
  }
  return isMainnetSourceChain(sourceChainId) ? "cotiMainnet" : "cotiTestnet";
};
