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
const ONLY_MPC_ADDER = process.env.ONLY_MPC_ADDER === "true";

const main = async () => {
  console.log("[deploy-examples-source] Connecting to network from CLI");
  const connection = await network.connect();
  const { viem, provider, networkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    networkName
  );
  const networkLabel = chainName ?? "unknown";
  console.log(`[deploy-examples-source] Connected: chainId=${chainId} network=${networkLabel}`);

  const deployConfig = await readDeployConfig();
  const sourceChainConfig = getChainConfig(deployConfig, chainId, "source");
  const inboxAddress = asAddress(sourceChainConfig.inbox ?? "", `deployConfig.chains.${chainId}.inbox`);
  const cotiChainId = chainId === 1 ? COTI_MAINNET_CHAIN_ID : COTI_TESTNET_CHAIN_ID;
  const cotiChainConfig = getChainConfig(deployConfig, Number(cotiChainId), "coti");
  const cotiExecutorAddress = asAddress(
    cotiChainConfig.cotiExecutor ?? "",
    `deployConfig.chains.${cotiChainId}.cotiExecutor`
  );
  console.log(`[deploy-examples-source] Inbox=${inboxAddress}`);
  console.log(`[deploy-examples-source] COTI executor=${cotiExecutorAddress} cotiChainId=${cotiChainId}`);

  if (!ONLY_MPC_ADDER) {
    console.log("[deploy-examples-source] Deploying Millionaire...");
    const millionaire = await viem.deployContract("Millionaire", [inboxAddress], {
      client: { public: publicClient, wallet: walletClient },
    });
    console.log(`[deploy-examples-source] Millionaire deployed: ${millionaire.address}`);
    const fundM = await walletClient.sendTransaction({ to: millionaire.address, value: 10n ** 18n });
    await publicClient.waitForTransactionReceipt({ hash: fundM });
    console.log("[deploy-examples-source] Configuring Millionaire...");
    await millionaire.write.configure(podConfigureKeepInbox(cotiExecutorAddress, cotiChainId));
    console.log("[deploy-examples-source] Millionaire configured");
    console.log("[deploy-examples-source] Writing Millionaire log entry");
    await appendDeploymentLog({
      contract: "Millionaire",
      address: millionaire.address,
      chainId,
      network: networkLabel,
    });
  }
  console.log("[deploy-examples-source] Deploying MpcAdder...");
  const mpcAdder = await viem.deployContract("MpcAdder", [inboxAddress], {
    client: { public: publicClient, wallet: walletClient },
  });
  console.log(`[deploy-examples-source] MpcAdder deployed: ${mpcAdder.address}`);
  const fundAdder = await walletClient.sendTransaction({ to: mpcAdder.address, value: 10n ** 18n });
  await publicClient.waitForTransactionReceipt({ hash: fundAdder });
  if (!ONLY_MPC_ADDER) {
    console.log("[deploy-examples-source] Deploying PErc20...");
    const pErc20 = await viem.deployContract("PErc20", [inboxAddress], {
      client: { public: publicClient, wallet: walletClient },
    });
    console.log(`[deploy-examples-source] PErc20 deployed: ${pErc20.address}`);
    const fundPe = await walletClient.sendTransaction({ to: pErc20.address, value: 10n ** 18n });
    await publicClient.waitForTransactionReceipt({ hash: fundPe });
    console.log("[deploy-examples-source] Configuring PErc20...");
    await pErc20.write.configure(podConfigureKeepInbox(cotiExecutorAddress, cotiChainId));
    console.log("[deploy-examples-source] PErc20 configured");
    console.log("[deploy-examples-source] Writing PErc20 log entry");
    await appendDeploymentLog({
      contract: "PErc20",
      address: pErc20.address,
      chainId,
      network: networkLabel,
    });
  }

  console.log("[deploy-examples-source] Configuring MpcAdder...");
  await mpcAdder.write.configure(podConfigureKeepInbox(cotiExecutorAddress, cotiChainId));
  console.log("[deploy-examples-source] MpcAdder configured");
  console.log("[deploy-examples-source] Writing MpcAdder log entry");
  await appendDeploymentLog({
    contract: "MpcAdder",
    address: mpcAdder.address,
    chainId,
    network: networkLabel,
  });
  console.log("[deploy-examples-source] Done");
};

main().catch((error) => {
  console.error("[deploy-examples-source] Failed:", error);
  process.exitCode = 1;
});
