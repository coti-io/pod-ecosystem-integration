/**
 * Run portal in → pToken transfer → portal out on live Sepolia (with COTI mining) and print explorer links.
 *
 *   npx hardhat run scripts/erc7984/run-sepolia-demo.ts --network sepolia
 *
 * Optional env:
 *   ERC7984_TOKEN=p.MTT|p.USDC|p.WETH   (default p.WETH — wraps Sepolia ETH via depositNative)
 *   ERC7984_DEPOSIT_AMOUNT=0.05      (token units; decimals allowed for 18-dec tokens, default 0.05)
 *   ERC7984_TRANSFER_AMOUNT=0.02     (token units, default 0.02)
 *   ERC7984_WITHDRAW_AMOUNT=0.01     (token units, default 0.01 for WETH / scaled for others)
 */

import { network } from "hardhat";
import { defineChain, parseAbi, parseEther, parseSignature, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readDeployConfigSync } from "../deploy-config.js";
import {
  normalizePrivateKey,
  onboardUser,
  receiptWaitOptions,
  requireEnv,
  resolveCotiTestnetPrivateKey,
  runCrossChainTwoWayRoundTrip,
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
/** Match FeeManager.DEFAULT_GAS_PRICE / live Sepolia inbox minGasPriceWei (2 gwei). */
const MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI = 2_000_000_000n;
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
      minGasPriceWei?: () => Promise<bigint>;
    };
  },
  publicClient: { getGasPrice: () => Promise<bigint> }
) {
  const chainGasPrice = await publicClient.getGasPrice();
  let minGasPriceWei = MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI;
  try {
    if (inbox.read.minGasPriceWei) {
      const onChainMin = await inbox.read.minGasPriceWei();
      if (onChainMin > 0n) minGasPriceWei = onChainMin;
    }
  } catch {
    /* older inbox ABIs */
  }
  // Quotes with gasPrice below inbox `_referenceGasPrice` floor inflate wei and trip FeeGasTooHigh.
  const gasPrice =
    chainGasPrice > minGasPriceWei
      ? chainGasPrice
      : minGasPriceWei > MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI
        ? minGasPriceWei
        : MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI;
  const [targetWei, callerWei] = await inbox.read.calculateTwoWayFeeRequiredInLocalToken([
    MPC_FEE_CALC_CALL_SIZE,
    MPC_FEE_CALC_CALL_SIZE,
    MPC_FEE_CALC_REMOTE_EXEC_GAS,
    MPC_FEE_CALC_CALLBACK_EXEC_GAS,
    gasPrice,
  ]);
  // Pad each leg separately. Padding only `total` while keeping callback fixed dumps the
  // surplus into the remote slice; ETH/COTI oracle ratio then turns that into FeeGasTooHigh.
  const callbackFeeWei = padPodFeeWei(callerWei);
  const targetFeeWei = padPodFeeWei(targetWei);
  return {
    callbackFeeWei,
    totalValueWei: targetFeeWei + callbackFeeWei,
    gasPrice,
  };
}

/**
 * Live Sepolia: do not pad `msg.value` above `totalValueWei` without also raising `callbackFeeWei`.
 * Extra value with a fixed callback dumps surplus into the remote slice; ETH/COTI oracle ratio
 * then converts that into FeeGasTooHigh (see FeeManager.validateAndPrepareTwoWayFees).
 */
const podTwoWayWriteOptionsLive = (fees: { totalValueWei: bigint }) => ({
  value: fees.totalValueWei,
  gas: 8_000_000n,
});

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
  return readDeployConfigSync() as DeployConfig;
}

function parseTokenAmount(raw: string | undefined, decimals: number, fallback: string): bigint {
  const value = raw ?? fallback;
  if (value.includes(".")) {
    return decimals === 18 ? parseEther(value) : parseUnits(value, decimals);
  }
  return BigInt(value) * 10n ** BigInt(decimals);
}

/** EIP-712 TransferPermit for portal `requestWithdrawWithPermit`. */
async function signPublicTransferPermit(params: {
  walletClient: { signTypedData: (args: any) => Promise<`0x${string}`> };
  pod: { read: { nonces: (a: readonly [`0x${string}`]) => Promise<bigint>; name: () => Promise<string> }; address: `0x${string}` };
  owner: `0x${string}`;
  spender: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  deadline: bigint;
  chainId: number;
}): Promise<{ deadline: bigint; v: number; r: `0x${string}`; s: `0x${string}` }> {
  const nonce = (await params.pod.read.nonces([params.owner])) as bigint;
  const tokenName = (await params.pod.read.name()) as string;
  const signature = await params.walletClient.signTypedData({
    account: params.owner,
    domain: {
      name: tokenName,
      version: "1",
      chainId: params.chainId,
      verifyingContract: params.pod.address,
    },
    types: {
      TransferPermit: [
        { name: "owner", type: "address" },
        { name: "spender", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint256" },
      ],
    },
    primaryType: "TransferPermit",
    message: {
      owner: params.owner,
      spender: params.spender,
      to: params.to,
      value: params.value,
      nonce,
      deadline: params.deadline,
    },
  });
  const parsed = parseSignature(signature);
  return {
    deadline: params.deadline,
    v: Number(parsed.v),
    r: parsed.r,
    s: parsed.s,
  };
}

async function main() {
  const tokenKey = process.env.ERC7984_TOKEN ?? "p.WETH";

  const cfg = loadDeployConfig();
  const sepoliaCfg = cfg.chains[String(SEPOLIA_CHAIN_ID)];
  const cotiCfg = cfg.chains[String(COTI_CHAIN_ID)];
  const portalTokens = sepoliaCfg?.privacyPortalTokens ?? {};
  const tokenCfg =
    portalTokens[tokenKey] ??
    portalTokens[tokenKey.replace(/^p\./, "p")] ??
    portalTokens[tokenKey.replace(/^p([A-Z])/, "p.$1")];
  if (!sepoliaCfg?.inbox || !tokenCfg) {
    throw new Error(`Missing Sepolia deploy config for ${tokenKey}`);
  }
  if (!cotiCfg?.inbox || !cotiCfg.cotiMother) {
    throw new Error("Missing COTI deploy config (inbox / cotiMother)");
  }

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
  const depositDefault =
    tokenKey === "p.USDC" || tokenKey === "pUSDC"
      ? "100"
      : tokenKey === "p.WETH" || tokenKey === "pWETH"
        ? "0.05"
        : tokenKey === "p.MTT" || tokenKey === "pMTT"
          ? "1"
          : "1000";
  const transferDefault =
    tokenKey === "p.USDC" || tokenKey === "pUSDC"
      ? "25"
      : tokenKey === "p.WETH" || tokenKey === "pWETH"
        ? "0.02"
        : tokenKey === "p.MTT" || tokenKey === "pMTT"
          ? "0.3"
          : "250";
  const withdrawDefault =
    tokenKey === "p.USDC" || tokenKey === "pUSDC"
      ? "25"
      : tokenKey === "p.WETH" || tokenKey === "pWETH"
        ? "0.01"
        : tokenKey === "p.MTT" || tokenKey === "pMTT"
          ? "0.2"
          : "250";
  const depositAmount = parseTokenAmount(process.env.ERC7984_DEPOSIT_AMOUNT, decimals, depositDefault);
  const transferAmount = parseTokenAmount(process.env.ERC7984_TRANSFER_AMOUNT, decimals, transferDefault);
  const withdrawAmount = parseTokenAmount(process.env.ERC7984_WITHDRAW_AMOUNT, decimals, withdrawDefault);
  const nativeWrapped = (await portalContract.read.nativeWrappedUnderlying()) as boolean;

  const podTwoWayFees = await estimateLivePodTwoWayFees(inboxSepoliaContract, sepoliaPublic);
  log("two-way fee estimate (wei)", podTwoWayFees);

  const [depositPortalFee, , depositMintTotalFee, depositMintCallbackFee] =
    (await portalContract.read.estimateDepositFees([depositAmount])) as readonly [
      bigint,
      boolean,
      bigint,
      bigint,
    ];
  log("deposit fee quote", {
    portalFee: depositPortalFee.toString(),
    mintTotalFee: depositMintTotalFee.toString(),
    mintCallbackFee: depositMintCallbackFee.toString(),
  });

  // Prefer live portal quotes when present; fall back to inbox two-way estimate for callback padding.
  const mintTotalFee =
    depositMintTotalFee > 0n ? depositMintTotalFee : podTwoWayFees.totalValueWei;
  const mintCallbackFee =
    depositMintCallbackFee > 0n ? depositMintCallbackFee : podTwoWayFees.callbackFeeWei;

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
      portalFee: depositPortalFee.toString(),
      mintFee: mintTotalFee.toString(),
    });
    depositHash = await portalContract.write.depositNative(
      [owner, depositAmount, depositPortalFee, mintCallbackFee],
      {
        account: owner,
        value: depositAmount + mintTotalFee + depositPortalFee,
      }
    );
    await sepoliaPublic.waitForTransactionReceipt({ hash: depositHash, ...receiptWaitOptions });
    txs.push({ label: "portal-deposit-native", chain: "sepolia", hash: depositHash });
  } else {
    log("fund underlying if needed", { owner, depositAmount: depositAmount.toString() });
    const ownerUnderlying = (await underlyingContract.read.balanceOf([owner])) as bigint;
    if (ownerUnderlying < depositAmount) {
      // MockERC20Decimals ABI has no owner(); faucet MTT is Ownable — probe via Ownable ABI.
      let underlyingOwner: string | undefined;
      try {
        underlyingOwner = (await sepoliaPublic.readContract({
          address: underlying,
          abi: parseAbi(["function owner() view returns (address)"]),
          functionName: "owner",
        })) as string;
      } catch {
        /* open mint / non-ownable mock */
      }
      if (underlyingOwner && underlyingOwner.toLowerCase() !== owner.toLowerCase()) {
        throw new Error(
          `Insufficient ${tokenKey} underlying (${ownerUnderlying} < ${depositAmount}). ` +
            `Underlying owner is ${underlyingOwner}; fund the demo wallet or set ERC7984_DEPOSIT_AMOUNT within balance.`
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
    depositHash = await portalContract.write.deposit(
      [owner, depositAmount, depositPortalFee, mintCallbackFee],
      {
        account: owner,
        value: mintTotalFee + depositPortalFee,
      }
    );
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

  // Mint callback already applies ciphertext when balanceNonces advances; skip sync if seeded.
  const ownerBalCt = await podContract.read.balanceOf([owner]);
  const ownerBalNonce = (await podContract.read.balanceNonces([owner])) as bigint;
  const ctZero =
    typeof ownerBalCt === "object" &&
    ownerBalCt !== null &&
    "ciphertextHigh" in (ownerBalCt as object)
      ? (ownerBalCt as { ciphertextHigh: bigint; ciphertextLow: bigint }).ciphertextHigh === 0n &&
        (ownerBalCt as { ciphertextHigh: bigint; ciphertextLow: bigint }).ciphertextLow === 0n
      : Array.isArray(ownerBalCt) && ownerBalCt[0] === 0n && ownerBalCt[1] === 0n;
  if (ownerBalNonce === 0n || ctZero) {
    log("seed owner pToken balance via syncBalances");
    await syncPodBalancesRoundTrip(
      { base, pod: podContract, podAsCoti, podCotiMother, owner, bob },
      [owner],
      "seedOwner"
    );
  } else {
    log("owner pToken balance already seeded by mint callback", {
      balanceNonces: ownerBalNonce.toString(),
    });
  }

  log("pToken transfer owner → bob", transferAmount.toString());
  let transferSubmitHash: `0x${string}` = "0x";
  const transferRound = await completePodOpRoundTrip(
    { base, pod: podContract, podAsCoti, podCotiMother, owner, bob },
    "pTokenXfer",
    async () => {
      transferSubmitHash = await podAsCoti.write.transfer(
        [bob.address, transferAmount, podTwoWayFees.callbackFeeWei],
        { ...podTwoWayWriteOptionsLive(podTwoWayFees), account: owner }
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

  const [withdrawPortalFee, , withdrawTransferTotalFee, withdrawTransferCallbackFee] =
    (await portalContract.read.estimateWithdrawFees([withdrawAmount])) as readonly [
      bigint,
      boolean,
      bigint,
      bigint,
    ];
  const transferTotalFee =
    withdrawTransferTotalFee > 0n ? withdrawTransferTotalFee : podTwoWayFees.totalValueWei;
  const transferCallbackFee =
    withdrawTransferCallbackFee > 0n ? withdrawTransferCallbackFee : podTwoWayFees.callbackFeeWei;
  log("withdraw fee quote", {
    portalFee: withdrawPortalFee.toString(),
    transferTotalFee: transferTotalFee.toString(),
    transferCallbackFee: transferCallbackFee.toString(),
    withdrawAmount: withdrawAmount.toString(),
  });

  const permitDeadline = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const permit = await signPublicTransferPermit({
    walletClient: sepoliaWalletOwner,
    pod: podContract,
    owner,
    spender: portal,
    to: portal,
    value: withdrawAmount,
    deadline: permitDeadline,
    chainId: SEPOLIA_CHAIN_ID,
  });

  log("requestWithdrawWithPermit (portal out)", {
    recipient: owner,
    withdrawAmount: withdrawAmount.toString(),
  });
  const withdrawHash = await portalContract.write.requestWithdrawWithPermit(
    [
      owner,
      withdrawAmount,
      withdrawPortalFee,
      transferTotalFee,
      transferCallbackFee,
      permit.deadline,
      permit.v,
      permit.r,
      permit.s,
    ],
    {
      account: owner,
      value: transferTotalFee + withdrawPortalFee,
    }
  );
  await sepoliaPublic.waitForTransactionReceipt({ hash: withdrawHash, ...receiptWaitOptions });
  txs.push({ label: "portal-withdraw-request", chain: "sepolia", hash: withdrawHash });
  log("portal withdraw tx", {
    hash: withdrawHash,
    etherscan: sepoliaTxUrl(withdrawHash),
    blockscout: blockscoutSepoliaTxUrl(withdrawHash),
  });

  log("mine withdraw transfer callback (pToken → portal → release underlying)");
  const withdrawRound = await runCrossChainTwoWayRoundTrip(base, "withdrawXfer", {
    gas: getDefaultCotiMineGasPodToken(),
  });
  txs.push({ label: "withdraw-callback", chain: "sepolia", hash: withdrawRound.sepoliaRelayTxHash });
  log("withdraw round-trip", {
    cotiMine: withdrawRound.cotiIncomingRequestId,
    sepoliaCallback: withdrawRound.sepoliaRelayTxHash,
    callbackEtherscan: sepoliaTxUrl(withdrawRound.sepoliaRelayTxHash),
    callbackBlockscout: blockscoutSepoliaTxUrl(withdrawRound.sepoliaRelayTxHash),
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
  console.log(`  Withdraw request:   ${withdrawHash}`);
  console.log(`  Withdraw callback:  ${withdrawRound.sepoliaRelayTxHash}`);
  console.log("===================================================\n");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
