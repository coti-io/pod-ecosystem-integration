import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  getChainConfig,
  getViemClients,
  podConfigureKeepInbox,
  readDeployConfig,
} from "./deploy-utils.js";

const COTI_TESTNET_CHAIN_ID = 7082400n;
const COTI_MAINNET_CHAIN_ID = 2632500n;

const main = async () => {
  console.log("[deploy-millionaire] Connecting to network from CLI");
  const connection = await network.connect();
  const { viem, provider, networkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    networkName
  );
  const networkLabel = chainName ?? "unknown";
  console.log(`[deploy-millionaire] Connected: chainId=${chainId} network=${networkLabel}`);

  const deployConfig = await readDeployConfig();
  const sourceChainConfig = getChainConfig(deployConfig, chainId, "source");
  const inboxAddress = asAddress(sourceChainConfig.inbox ?? "", `deployConfig.chains.${chainId}.inbox`);
  const cotiChainId = chainId === 1 ? COTI_MAINNET_CHAIN_ID : COTI_TESTNET_CHAIN_ID;
  const cotiChainConfig = getChainConfig(deployConfig, Number(cotiChainId), "coti");
  const cotiExecutorAddress = asAddress(
    cotiChainConfig.cotiExecutor ?? "",
    `deployConfig.chains.${cotiChainId}.cotiExecutor`
  );
  console.log(`[deploy-millionaire] Inbox=${inboxAddress}`);
  console.log(`[deploy-millionaire] COTI executor=${cotiExecutorAddress} cotiChainId=${cotiChainId}`);

  console.log("[deploy-millionaire] Deploying Millionaire...");
  const millionaire = await viem.deployContract("Millionaire", [inboxAddress], {
    client: { public: publicClient, wallet: walletClient },
  });
  console.log(`[deploy-millionaire] Millionaire deployed: ${millionaire.address}`);
  const fundTx = await walletClient.sendTransaction({ to: millionaire.address, value: 10n ** 18n });
  await publicClient.waitForTransactionReceipt({ hash: fundTx });
  console.log("[deploy-millionaire] Configuring Millionaire...");
  await millionaire.write.configure(podConfigureKeepInbox(cotiExecutorAddress, cotiChainId));
  console.log("[deploy-millionaire] Millionaire configured");

  console.log("[deploy-millionaire] Writing deployment log entry");
  await appendDeploymentLog({
    contract: "Millionaire",
    address: millionaire.address,
    chainId,
    network: networkLabel,
  });
  console.log("[deploy-millionaire] Done");
};

main().catch((error) => {
  console.error("[deploy-millionaire] Failed:", error);
  process.exitCode = 1;
});
