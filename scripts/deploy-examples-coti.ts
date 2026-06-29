import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  getChainConfig,
  getViemClients,
  readDeployConfig,
} from "./deploy-utils.js";

const main = async () => {
  console.log("[deploy-examples-coti] Connecting to network from CLI");
  const connection = await network.connect();
  const { viem, provider, networkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    networkName
  );
  const networkLabel = chainName ?? "unknown";
  console.log(`[deploy-examples-coti] Connected: chainId=${chainId} network=${networkLabel}`);

  const deployConfig = await readDeployConfig();
  const cotiChainConfig = getChainConfig(deployConfig, chainId, "coti");
  const inboxAddress = asAddress(cotiChainConfig.inbox ?? "", `deployConfig.chains.${chainId}.inbox`);
  console.log(`[deploy-examples-coti] Inbox=${inboxAddress}`);

  console.log("[deploy-examples-coti] Deploying PErc20Coti...");
  const pErc20Coti = await viem.deployContract("PErc20Coti", [inboxAddress], {
    client: { public: publicClient, wallet: walletClient },
  });
  console.log(`[deploy-examples-coti] PErc20Coti deployed: ${pErc20Coti.address}`);

  console.log("[deploy-examples-coti] Writing deployment log entry");
  await appendDeploymentLog({
    contract: "PErc20Coti",
    address: pErc20Coti.address,
    chainId,
    network: networkLabel,
  });
  console.log("[deploy-examples-coti] Done");
};

main().catch((error) => {
  console.error("[deploy-examples-coti] Failed:", error);
  process.exitCode = 1;
});
