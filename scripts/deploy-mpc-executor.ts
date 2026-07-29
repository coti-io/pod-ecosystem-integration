/**
 * Deploy `MpcExecutor` with constructor `(address inbox)`.
 *
 * Usage:
 *   INBOX_ADDRESS=0x... npx hardhat run scripts/deploy-mpc-executor.ts --network cotiTestnet
 *
 * Or use the inbox from deploy config YAML for the connected chain:
 *   READ_INBOX_FROM_CONFIG=true npx hardhat run scripts/deploy-mpc-executor.ts --network cotiTestnet
 *
 * Optional:
 *   UPDATE_DEPLOY_CONFIG=true  — write `chains[chainId].cotiExecutor` in deploy config
 */
import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  getViemClients,
  optionalEnv,
  readDeployConfig,
} from "./deploy-utils.js";
import { writeDeployConfig } from "./deploy-config.js";

const main = async () => {
  console.log("[deploy-mpc-executor] Connecting");
  const connection = await network.connect();
  const { viem, provider, networkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    networkName
  );
  const networkLabel = chainName ?? "unknown";
  console.log(`[deploy-mpc-executor] chainId=${chainId} network=${networkLabel}`);

  const deployConfig = await readDeployConfig();
  const chainKey = String(chainId);
  const fromConfig = deployConfig.chains?.[chainKey]?.inbox;
  if (!fromConfig) {
    throw new Error(
      `[deploy-mpc-executor] deployConfig.chains.${chainKey}.inbox is missing or empty (set INBOX_ADDRESS or add inbox to deploy config YAML)`
    );
  }
  const inboxAddress = asAddress(fromConfig, `deployConfig.chains.${chainKey}.inbox`);
  console.log(`[deploy-mpc-executor] Inbox from deployConfig: ${inboxAddress}`);

  console.log("[deploy-mpc-executor] Deploying MpcExecutor...");
  const mpcExecutor = await viem.deployContract("MpcExecutor", [inboxAddress], {
    client: { public: publicClient, wallet: walletClient },
  });
  console.log(`[deploy-mpc-executor] MpcExecutor deployed: ${mpcExecutor.address}`);

  await appendDeploymentLog({
    contract: "MpcExecutor",
    address: mpcExecutor.address,
    chainId,
    network: networkLabel,
  });

  if (optionalEnv("UPDATE_DEPLOY_CONFIG") === "true") {
    const cfg = await readDeployConfig();
    cfg.chains ??= {};
    const key = String(chainId);
    cfg.chains[key] ??= {};
    cfg.chains[key].cotiExecutor = mpcExecutor.address;
    await writeDeployConfig(cfg);
    console.log(`[deploy-mpc-executor] Updated deploy config chains.${key}.cotiExecutor`);
  }

  console.log("[deploy-mpc-executor] Done");
};

main().catch((error) => {
  console.error("[deploy-mpc-executor] Failed:", error);
  process.exitCode = 1;
});
