import { network } from "hardhat";
import { getViemClients, resolveDeployerAddress, waitMined } from "./deploy-utils.js";

/**
 * One-off: mint an open-`mint` ERC20 (e.g. MockERC20Decimals) to a recipient.
 *
 *   MINT_NETWORK=avalancheFuji \
 *   MINT_TOKEN=0x... MINT_TO=0x... MINT_AMOUNT=100000000 MINT_DECIMALS=6 \
 *   npx hardhat run scripts/mint-token.ts
 */
async function main() {
  const netName = process.env.MINT_NETWORK ?? "avalancheFuji";
  const token = process.env.MINT_TOKEN as `0x${string}`;
  const to = process.env.MINT_TO as `0x${string}`;
  const amountWhole = BigInt(process.env.MINT_AMOUNT ?? "0");
  const decimals = BigInt(process.env.MINT_DECIMALS ?? "18");
  if (!token || !to || amountWhole <= 0n) {
    throw new Error("Set MINT_TOKEN, MINT_TO and MINT_AMOUNT (whole tokens).");
  }

  const connection = await network.connect({ network: netName });
  const { viem, provider, networkName } = connection;
  const { publicClient, walletClient } = await getViemClients(viem, provider, networkName);
  const deployer = await resolveDeployerAddress(walletClient);

  const erc20 = await viem.getContractAt("MockERC20Decimals", token, {
    client: { public: publicClient, wallet: walletClient },
  });
  const raw = amountWhole * 10n ** decimals;
  console.log(`Minting ${amountWhole} (raw ${raw}) of ${token} to ${to} on ${netName}...`);
  const hash = await erc20.write.mint([to, raw], { account: deployer });
  await waitMined(publicClient, hash);
  const bal = (await erc20.read.balanceOf([to])) as bigint;
  console.log(`Minted. tx=${hash}`);
  console.log(`New balance of ${to}: ${bal} (raw)`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
