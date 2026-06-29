/**
 * Deploy `MpcExecutor` with constructor `(address inbox)`.
 *
 * Usage:
 *   INBOX_ADDRESS=0x... npx hardhat run scripts/deploy-mpc-executor.ts --network cotiTestnet
 *
 * Or use the inbox from `deployConfig.json` for the connected chain:
 *   READ_INBOX_FROM_CONFIG=true npx hardhat run scripts/deploy-mpc-executor.ts --network cotiTestnet
 *
 * Optional:
 *   UPDATE_DEPLOY_CONFIG=true  — write `chains[chainId].cotiExecutor` in deployConfig.json
 */
import fs from "node:fs/promises";
import path from "path";
import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  getViemClients,
  optionalEnv,
  readDeployConfig,
} from "./deploy-utils.js";

const deployConfigPath = path.resolve(process.cwd(), "deployConfig.json");

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

  let inboxAddress: `0x${string}`;
  const deployConfig = await readDeployConfig();
  const chainKey = String(chainId);
  const fromConfig = deployConfig.chains?.[chainKey]?.inbox;
  if (!fromConfig) {
    throw new Error(
      `[deploy-mpc-executor] deployConfig.chains.${chainKey}.inbox is missing or empty (set INBOX_ADDRESS or add inbox to deployConfig.json)`
    );
  }
  inboxAddress = asAddress(fromConfig, `deployConfig.chains.${chainKey}.inbox`);
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
    const deployConfig = await readDeployConfig();
    deployConfig.chains ??= {};
    const chainKey = String(chainId);
    deployConfig.chains[chainKey] ??= {};
    deployConfig.chains[chainKey].cotiExecutor = mpcExecutor.address;
    await fs.writeFile(deployConfigPath, `${JSON.stringify(deployConfig, null, 2)}\n`, "utf8");
    console.log(`[deploy-mpc-executor] Updated deployConfig.json chains.${chainKey}.cotiExecutor`);
  }

  console.log("[deploy-mpc-executor] Done");
};

main().catch((error) => {
  console.error("[deploy-mpc-executor] Failed:", error);
  process.exitCode = 1;
});
