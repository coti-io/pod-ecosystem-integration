/**
 * Run deposit + pToken transfer on live Sepolia (with COTI mining) and print explorer links.
 *
 *   npx hardhat run scripts/erc7984/run-sepolia-demo.ts --network sepolia
 *
 * Optional env:
 *   ERC7984_TOKEN=pMTT|pUSDC|pWETH   (default pWETH — wraps Sepolia ETH via depositNative)
 *   ERC7984_DEPOSIT_AMOUNT=0.05      (token units; decimals allowed for 18-dec tokens, default 0.05)
 *   ERC7984_TRANSFER_AMOUNT=0.02     (token units, default 0.02)
 */

import { readFileSync } from "node:fs";
import { network } from "hardhat";
import { defineChain, parseEther, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  logStep,
  normalizePrivateKey,
  onboardUser,
  receiptWaitOptions,
  requireEnv,
  resolveCotiTestnetPrivateKey,
  runCrossChainTwoWayRoundTrip,
  podTwoWayWriteOptions,
} from "../../test/system/mpc-test-utils.js";
import {
  completePodOpRoundTrip,
  getDefaultCotiMineGasPodToken,
  setupBobUser,
  syncPodBalancesRoundTrip,
} from "../../test/tokens/test-token-utils.js";
import { ensureMinerRegistered } from "../deploy-utils.js";
import { ONBOARD_CONTRACT_ADDRESS, Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { JsonRpcProvider } from "ethers";

type DeployConfig = {
  chains: Record<
    string,
    {
      inbox?: string;
      cotiMother?: string;
      privacyPortalTokens?: Record<
        string,
        { underlying: string; portal: string; pToken: string }
      >;
    }
  >;
};

const SEPOLIA_CHAIN_ID = 11155111;
const COTI_CHAIN_ID = 7082400;
const MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI = 300529002n;
const MPC_FEE_CALC_CALL_SIZE = 512n;
const MPC_FEE_CALC_REMOTE_EXEC_GAS = 300000n;
const MPC_FEE_CALC_CALLBACK_EXEC_GAS = 300000n;

const padPodFeeWei = (x: bigint) => x + x / 20n + 1n;

async function estimateLivePodTwoWayFees(
  inbox: {
    read: {
      calculateTwoWayFeeRequiredInLocalToken: (
        args: readonly [bigint, bigint, bigint, bigint, bigint]
      ) => Promise<readonly [bigint, bigint]>;
    };
  },
  publicClient: { getGasPrice: () => Promise<bigint> }
) {
  const chainGasPrice = await publicClient.getGasPrice();
  const gasPrice =
    chainGasPrice > MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI ? chainGasPrice : MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI;
  const [targetWei, callerWei] = await inbox.read.calculateTwoWayFeeRequiredInLocalToken([
    MPC_FEE_CALC_CALL_SIZE,
    MPC_FEE_CALC_CALL_SIZE,
    MPC_FEE_CALC_REMOTE_EXEC_GAS,
    MPC_FEE_CALC_CALLBACK_EXEC_GAS,
    gasPrice,
  ]);
  return {
    callbackFeeWei: padPodFeeWei(callerWei),
    totalValueWei: padPodFeeWei(targetWei + callerWei),
    gasPrice,
  };
}

const log = (step: string, detail?: unknown) => {
  const body =
    detail === undefined
      ? ""
      : typeof detail === "string"
        ? detail
        : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
  console.log(`[erc7984-sepolia] ${step}${body ? `\n${body}` : ""}`);
};

const sepoliaTxUrl = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;
const sepoliaAddressUrl = (addr: string) => `https://sepolia.etherscan.io/address/${addr}`;
const blockscoutSepoliaTxUrl = (hash: string) => `https://eth-sepolia.blockscout.com/tx/${hash}`;
const blockscoutSepoliaTokenUrl = (addr: string) => `https://eth-sepolia.blockscout.com/token/${addr}`;

function loadDeployConfig(): DeployConfig {
  return JSON.parse(readFileSync("deployConfig.json", "utf8")) as DeployConfig;
}

function parseTokenAmount(raw: string | undefined, decimals: number, fallback: string): bigint {
  const value = raw ?? fallback;
  if (value.includes(".")) {
    return decimals === 18 ? parseEther(value) : parseUnits(value, decimals);
  }
  return BigInt(value) * 10n ** BigInt(decimals);
}

async function main() {
  const tokenKey = process.env.ERC7984_TOKEN ?? "pWETH";

  const cfg = loadDeployConfig();
  const sepoliaCfg = cfg.chains[String(SEPOLIA_CHAIN_ID)];
  const cotiCfg = cfg.chains[String(COTI_CHAIN_ID)];
  if (!sepoliaCfg?.inbox || !sepoliaCfg.privacyPortalTokens?.[tokenKey]) {
    throw new Error(`Missing Sepolia deploy config for ${tokenKey}`);
  }
  if (!cotiCfg?.inbox || !cotiCfg.cotiMother) {
    throw new Error("Missing COTI deploy config (inbox / cotiMother)");
  }

  const tokenCfg = sepoliaCfg.privacyPortalTokens[tokenKey]!;
  const inboxSepolia = sepoliaCfg.inbox as `0x${string}`;
  const inboxCoti = cotiCfg.inbox as `0x${string}`;
  const cotiMother = cotiCfg.cotiMother as `0x${string}`;
  const portal = tokenCfg.portal as `0x${string}`;
  const pToken = tokenCfg.pToken as `0x${string}`;
  const underlying = tokenCfg.underlying as `0x${string}`;

  log("targets", {
    tokenKey,
    portal,
    pToken,
    underlying,
    inboxSepolia,
    inboxCoti,
    cotiMother,
  });

  const sepoliaConn = await network.connect({ network: "sepolia" });
  const cotiConn = await network.connect({ network: "cotiTestnet" });

  const cotiRpcUrl = requireEnv("COTI_TESTNET_RPC_URL");
  const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey(cotiRpcUrl));
  const owner = privateKeyToAccount(cotiPk as `0x${string}`).address;

  const cotiChain = defineChain({
    id: COTI_CHAIN_ID,
    name: "COTI Testnet",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: { default: { http: [cotiRpcUrl] } },
  });

  const sepoliaPublic = await sepoliaConn.viem.getPublicClient();
  const cotiPublic = await cotiConn.viem.getPublicClient({ chain: cotiChain });
  const sepoliaWalletOwner = await sepoliaConn.viem.getWalletClient(owner);
  const cotiWallet = await cotiConn.viem.getWalletClient(owner, { chain: cotiChain });

  const inboxSepoliaContract = await sepoliaConn.viem.getContractAt("Inbox", inboxSepolia, {
    client: { public: sepoliaPublic, wallet: sepoliaWalletOwner },
  });
  const inboxCotiContract = await cotiConn.viem.getContractAt("Inbox", inboxCoti, {
    client: { public: cotiPublic, wallet: cotiWallet },
  });

  const portalContract = await sepoliaConn.viem.getContractAt("PrivacyPortal", portal, {
    client: { public: sepoliaPublic, wallet: sepoliaWalletOwner },
  });
  const podContract = await sepoliaConn.viem.getContractAt("PodErc20MintableInitializable", pToken, {
    client: { public: sepoliaPublic, wallet: sepoliaWalletOwner },
  });
  const podAsCoti = await sepoliaConn.viem.getContractAt("PodErc20MintableInitializable", pToken, {
    client: { public: sepoliaPublic, wallet: sepoliaWalletOwner },
  });
  const underlyingContract = await sepoliaConn.viem.getContractAt("MockERC20Decimals", underlying, {
    client: { public: sepoliaPublic, wallet: sepoliaWalletOwner },
  });
  const podCotiMother = await cotiConn.viem.getContractAt("PodErc20CotiMother", cotiMother, {
    client: { public: cotiPublic, wallet: cotiWallet },
  });

  const decimals = Number(await podContract.read.decimals());
  const depositDefault = tokenKey === "pUSDC" ? "100" : tokenKey === "pWETH" ? "0.05" : "1000";
  const transferDefault = tokenKey === "pUSDC" ? "25" : tokenKey === "pWETH" ? "0.02" : "250";
  const depositAmount = parseTokenAmount(process.env.ERC7984_DEPOSIT_AMOUNT, decimals, depositDefault);
  const transferAmount = parseTokenAmount(process.env.ERC7984_TRANSFER_AMOUNT, decimals, transferDefault);
  const nativeWrapped = (await portalContract.read.nativeWrappedUnderlying()) as boolean;

  const podTwoWayFees = await estimateLivePodTwoWayFees(inboxSepoliaContract, sepoliaPublic);
  log("two-way fee estimate (wei)", podTwoWayFees);

  for (const [label, inboxContract, wallet] of [
    ["sepolia", inboxSepoliaContract, sepoliaWalletOwner],
    ["coti", inboxCotiContract, cotiWallet],
  ] as const) {
    const added = await ensureMinerRegistered({
      inbox: inboxContract,
      miner: owner,
      publicClient: label === "sepolia" ? sepoliaPublic : cotiPublic,
      walletClient: wallet,
    });
    if (added) log(`registered ${label} inbox miner`, owner);
  }

  const minContractBalance = podTwoWayFees.totalValueWei * 3n;
  for (const [label, addr] of [
    ["pToken", pToken],
    ["portal", portal],
  ] as const) {
    const bal = await sepoliaPublic.getBalance({ address: addr });
    if (bal < minContractBalance) {
      const topUp = minContractBalance - bal;
      log(`top-up ${label} inbox fees`, { addr, current: bal.toString(), topUp: topUp.toString() });
      const hash = await sepoliaWalletOwner.sendTransaction({ to: addr, value: topUp });
      await sepoliaPublic.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    } else {
      log(`${label} already funded for inbox fees`, { addr, balance: bal.toString() });
    }
  }

  const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;
  const userKey = await onboardUser(cotiPk, cotiRpcUrl, onboardAddress);
  const cotiProvider = new JsonRpcProvider(cotiRpcUrl) as any;
  const cotiEncryptWallet = new CotiWallet(cotiPk, cotiProvider);
  cotiEncryptWallet.setAesKey(userKey);
  const bob = await setupBobUser(cotiPk);

  const base = {
    sepolia: { publicClient: sepoliaPublic, wallet: sepoliaWalletOwner },
    coti: { publicClient: cotiPublic, wallet: cotiWallet },
    contracts: {
      inboxSepolia: inboxSepoliaContract,
      inboxCoti: inboxCotiContract,
      mpcAdder: null,
      mpcAdderAsCoti: null,
      mpcExecutor: null,
    },
    crypto: { userKey, cotiEncryptWallet },
    chainIds: { sepolia: SEPOLIA_CHAIN_ID, coti: BigInt(COTI_CHAIN_ID) },
    podTwoWayFees,
  };

  const ctx = {
    base,
    pod: podContract,
    podAsCoti,
    podCotiMother,
    owner,
    bob,
    portal: portalContract,
    underlying: underlyingContract,
    ownerWallet: sepoliaWalletOwner,
    withdrawRecipient: owner,
  };

  const txs: Array<{ label: string; chain: string; hash: string }> = [];

  let depositHash: `0x${string}`;

  if (nativeWrapped) {
    log("depositNative / wrap via portal (ETH → pToken)", {
      owner,
      depositAmount: depositAmount.toString(),
      inboxFee: podTwoWayFees.totalValueWei.toString(),
    });
    depositHash = await portalContract.write.depositNative(
      [owner, depositAmount, podTwoWayFees.callbackFeeWei],
      {
        account: owner,
        value: depositAmount + podTwoWayFees.totalValueWei,
      }
    );
    await sepoliaPublic.waitForTransactionReceipt({ hash: depositHash, ...receiptWaitOptions });
    txs.push({ label: "portal-deposit-native", chain: "sepolia", hash: depositHash });
  } else {
    log("fund underlying if needed", { owner, depositAmount: depositAmount.toString() });
    const ownerUnderlying = (await underlyingContract.read.balanceOf([owner])) as bigint;
    if (ownerUnderlying < depositAmount) {
      let underlyingOwner: string | undefined;
      try {
        underlyingOwner = (await underlyingContract.read.owner()) as string;
      } catch {
        /* open mint */
      }
      if (underlyingOwner && underlyingOwner.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(
          `Insufficient ${tokenKey} underlying (${ownerUnderlying} < ${depositAmount}). ` +
            `Underlying owner is ${underlyingOwner}; use ERC7984_TOKEN=pWETH or fund underlying first.`
        );
      }
      const mintHash = await underlyingContract.write.mint([owner, depositAmount - ownerUnderlying], {
        account: owner,
      });
      await sepoliaPublic.waitForTransactionReceipt({ hash: mintHash, ...receiptWaitOptions });
      txs.push({ label: "underlying-mint", chain: "sepolia", hash: mintHash });
      log("underlying mint tx", {
        hash: mintHash,
        etherscan: sepoliaTxUrl(mintHash),
        blockscout: blockscoutSepoliaTxUrl(mintHash),
      });
    }

    log("approve portal", depositAmount.toString());
    const approveHash = await underlyingContract.write.approve([portal, depositAmount], { account: owner });
    await sepoliaPublic.waitForTransactionReceipt({ hash: approveHash, ...receiptWaitOptions });
    txs.push({ label: "underlying-approve", chain: "sepolia", hash: approveHash });

    log("deposit / wrap via portal", depositAmount.toString());
    depositHash = await portalContract.write.deposit([owner, depositAmount, podTwoWayFees.callbackFeeWei], {
      account: owner,
      value: podTwoWayFees.totalValueWei,
    });
    await sepoliaPublic.waitForTransactionReceipt({ hash: depositHash, ...receiptWaitOptions });
    txs.push({ label: "portal-deposit", chain: "sepolia", hash: depositHash });
  }

  log("portal deposit tx", {
    hash: depositHash,
    etherscan: sepoliaTxUrl(depositHash),
    blockscout: blockscoutSepoliaTxUrl(depositHash),
  });

  log("mine mint callback (COTI → Sepolia)");
  const mintRound = await runCrossChainTwoWayRoundTrip(base, "depositMint", {
    gas: getDefaultCotiMineGasPodToken(),
  });
  txs.push({ label: "mint-callback", chain: "sepolia", hash: mintRound.sepoliaRelayTxHash });
  log("mint round-trip", {
    cotiMine: mintRound.cotiIncomingRequestId,
    sepoliaCallback: mintRound.sepoliaRelayTxHash,
    callbackEtherscan: sepoliaTxUrl(mintRound.sepoliaRelayTxHash),
    callbackBlockscout: blockscoutSepoliaTxUrl(mintRound.sepoliaRelayTxHash),
  });

  await syncPodBalancesRoundTrip({ base, pod: podContract, podAsCoti, podCotiMother, owner, bob }, [owner], "seedOwner");

  log("pToken transfer owner → bob", transferAmount.toString());
  let transferSubmitHash: `0x${string}` = "0x";
  const transferRound = await completePodOpRoundTrip(
    { base, pod: podContract, podAsCoti, podCotiMother, owner, bob },
    "pTokenXfer",
    async () => {
      transferSubmitHash = await podAsCoti.write.transfer(
        [bob.address, transferAmount, podTwoWayFees.callbackFeeWei],
        { ...podTwoWayWriteOptions(podTwoWayFees), account: owner }
      );
      return transferSubmitHash;
    },
    { gas: getDefaultCotiMineGasPodToken() }
  );
  txs.push({ label: "pToken-transfer-submit", chain: "sepolia", hash: transferSubmitHash });
  txs.push({ label: "transfer-callback", chain: "sepolia", hash: transferRound.sepoliaRelayTxHash });

  log("transfer round-trip", {
    submit: transferSubmitHash,
    submitEtherscan: sepoliaTxUrl(transferSubmitHash),
    submitBlockscout: blockscoutSepoliaTxUrl(transferSubmitHash),
    callback: transferRound.sepoliaRelayTxHash,
    callbackEtherscan: sepoliaTxUrl(transferRound.sepoliaRelayTxHash),
    callbackBlockscout: blockscoutSepoliaTxUrl(transferRound.sepoliaRelayTxHash),
  });

  const supports7984 = await podContract.read.supportsInterface(["0x4958f2a4"]).catch(() => false);

  console.log("\n========== ERC-7984 Sepolia demo summary ==========");
  console.log(`Owner:     ${owner}`);
  console.log(`Portal:    ${portal}  ${sepoliaAddressUrl(portal)}`);
  console.log(`pToken:    ${pToken}  ${sepoliaAddressUrl(pToken)}`);
  console.log(`           Blockscout token page: ${blockscoutSepoliaTokenUrl(pToken)}`);
  console.log(`Underlying:${underlying}`);
  console.log(`ERC-7984 supportsInterface(0x4958f2a4): ${supports7984}`);
  console.log("\nTransaction hashes:");
  for (const row of txs) {
    console.log(`  [${row.chain}] ${row.label}: ${row.hash}`);
    if (row.chain === "sepolia" && row.hash.startsWith("0x") && row.hash.length === 66) {
      console.log(`    Etherscan:   ${sepoliaTxUrl(row.hash)}`);
      console.log(`    Blockscout:  ${blockscoutSepoliaTxUrl(row.hash)}`);
    }
  }
  console.log("\nKey txs to inspect for confidential token rows:");
  console.log(`  Deposit (wrap):     ${depositHash}`);
  console.log(`  Mint callback:      ${mintRound.sepoliaRelayTxHash}`);
  console.log(`  Transfer submit:    ${transferSubmitHash}`);
  console.log(`  Transfer callback:  ${transferRound.sepoliaRelayTxHash}`);
  console.log("===================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
