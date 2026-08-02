import assert from "node:assert/strict";
import { privateKeyToAccount } from "viem/accounts";
import { parseEventLogs, parseSignature, zeroAddress } from "viem";
import {
  fundContractForInboxFees,
  getLatestRequest,
  logStep,
  mineRequest,
  normalizePrivateKey,
  receiptWaitOptions,
  resolveCotiTestnetPrivateKey,
  runCrossChainTwoWayRoundTrip,
  setupContext,
  type MineRequestOptions,
  type TestContext,
} from "../system/mpc-test-utils.js";
import { oracleTokensForChain } from "../../scripts/oracle-tokens.js";
import {
  completePodOpRoundTrip,
  getDefaultCotiMineGasPodToken,
  estimateOneWayRegistrationFeeWei,
  registerPodTokenOnMother,
  setupBobUser,
  syncPodBalancesRoundTrip,
  type PodTokenTestContext,
} from "../tokens/test-token-utils.js";
import { MAX_PACKED_FEE } from "./privacy-portal-utils.js";

export const PP_WITHDRAW_RECIPIENT = "0x00000000000000000000000000000000000000b0" as `0x${string}`;

export type PrivacyPortalSystemContext = PodTokenTestContext & {
  portal: any;
  underlying: any;
  /** Hardhat wallet for `owner` (COTI-funded key) — used for EIP-712 permit signing. */
  ownerWallet: any;
  /** Default underlying recipient for portal withdrawals (distinct from Bob for pToken flows). */
  withdrawRecipient: `0x${string}`;
  /** Present when `useFactory: true` (real {PrivacyPortalFactory}). */
  factory?: any;
  portalImpl?: any;
  sepoliaViem?: any;
  cotiViem?: any;
};

/** Step log prefix for PP system tests (grep `privacy-portal-system`). */
export const ppLog = (message: string) => logStep(`privacy-portal-system: ${message}`);

/** Register portal AES key on sim COTI (needed for withdraw offBoard-to-portal). No-op on live. */
export async function registerPortalAesKeyIfSim(
  cotiViem: any,
  portalAddress: `0x${string}`,
  cotiPk: string
) {
  const backend = (process.env.COTI_BACKEND ?? "").trim().toLowerCase();
  if (!["sim", "simcoti", "fork"].includes(backend)) {
    return;
  }
  const { registerUserOnSim, deriveUserAesKey } = await import("../sim-coti/sim-coti-utils.js");
  const portalKey = deriveUserAesKey(cotiPk);
  const [signer] = await cotiViem.getWalletClients();
  await registerUserOnSim(cotiViem, portalAddress, portalKey, signer.account);
  ppLog(`simCoti: registered portal AES key for ${portalAddress}`);
}

type PpSetupCore = {
  base: TestContext;
  owner: `0x${string}`;
  ownerWallet: any;
  cotiPk: string;
  podCotiMother: any;
  underlying: any;
  bob: Awaited<ReturnType<typeof setupBobUser>>;
};

/** Shared dual-chain infra: inboxes via `setupContext`, mother, underlying, Bob. */
async function setupPrivacyPortalInfra(params: {
  sepoliaViem: any;
  cotiViem: any;
}): Promise<PpSetupCore> {
  const base = await setupContext(params);
  const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey());
  const owner = privateKeyToAccount(cotiPk as `0x${string}`).address;
  const ownerWallet = await params.sepoliaViem.getWalletClient(owner);

  ppLog("deploy PodErc20CotiMother on COTI");
  const podCotiMother = await params.cotiViem.deployContract(
    "PodErc20CotiMother",
    [base.contracts.inboxCoti.address, owner],
    { client: { public: base.coti.publicClient, wallet: base.coti.wallet } } as any
  );

  ppLog("deploy underlying MockERC20Decimals on Hardhat");
  const underlying = await params.sepoliaViem.deployContract("MockERC20Decimals", [
    "Test USD",
    "TUSD",
    18,
  ]);

  const bob = await setupBobUser(cotiPk, { cotiViem: params.cotiViem });
  return { base, owner, ownerWallet, cotiPk, podCotiMother, underlying, bob };
}

async function fundPortalAndPToken(
  ownerWallet: any,
  publicClient: any,
  portalAddress: `0x${string}`,
  pTokenAddress: `0x${string}`
) {
  ppLog("fund portal and pToken with native inbox fees");
  await fundContractForInboxFees(ownerWallet, publicClient, pTokenAddress);
  await fundContractForInboxFees(ownerWallet, publicClient, portalAddress);
}

/** Mine the latest Sepolia→COTI one-way request (factory `createPortal` mother registration). */
async function mineLatestMotherRegistration(base: TestContext, label: string) {
  const outboundRequest = await getLatestRequest(base.contracts.inboxSepolia, base.chainIds.coti);
  await mineRequest(base, "coti", BigInt(base.chainIds.sepolia), outboundRequest, label, {
    gas: getDefaultCotiMineGasPodToken(),
  });
}

/**
 * Dual-chain Privacy Portal stack for system tests.
 * @param useFactory When true, deploy real {PrivacyPortalFactory} + `createPortal` (required for remount).
 *                   Default false uses MockPrivacyPortalFactory + direct portal/pToken (existing PP system suite).
 */
export async function setupPrivacyPortalSystemContext(params: {
  sepoliaViem: any;
  cotiViem: any;
  useFactory?: boolean;
}): Promise<PrivacyPortalSystemContext> {
  const infra = await setupPrivacyPortalInfra(params);
  const { base, owner, ownerWallet, cotiPk, podCotiMother, underlying, bob } = infra;
  const client = { public: base.sepolia.publicClient, wallet: ownerWallet };

  if (params.useFactory) {
    ppLog("deploy PrivacyPortal + PodErc20MintableInitializable implementations");
    const portalImpl = await params.sepoliaViem.deployContract("PrivacyPortal", [], { client });
    const tokenImpl = await params.sepoliaViem.deployContract("PodErc20MintableInitializable", [], {
      client,
    });
    const { portalNative } = oracleTokensForChain(base.chainIds.sepolia);
    ppLog(
      `deploy PrivacyPortalFactory (inbox=${base.contracts.inboxSepolia.address}, mother=${podCotiMother.address})`
    );
    const factory = await params.sepoliaViem.deployContract(
      "PrivacyPortalFactory",
      [
        owner,
        base.contracts.inboxSepolia.address,
        BigInt(base.chainIds.coti),
        podCotiMother.address,
        tokenImpl.address,
        portalImpl.address,
        owner,
        owner,
        portalNative,
        zeroAddress,
        0n,
        0n,
        MAX_PACKED_FEE,
        0n,
        0n,
        MAX_PACKED_FEE,
      ],
      { client }
    );

    ppLog("allowlist factory on COTI mother");
    await podCotiMother.write.setAllowedFactory(
      [BigInt(base.chainIds.sepolia), factory.address, true],
      { account: base.coti.wallet.account }
    );

    ppLog("createPortal (one-way mother registration)");
    const createValue = await estimateOneWayRegistrationFeeWei(base.contracts.inboxSepolia);
    const createHash = await factory.write.createPortal(
      [underlying.address, "Private TUSD", "pTUSD", 18, false],
      {
        account: owner,
        value: createValue,
        gas: 5_000_000n,
      }
    );
    await base.sepolia.publicClient.waitForTransactionReceipt({
      hash: createHash,
      ...receiptWaitOptions,
    });

    const portalAddress = (await factory.read.portalForUnderlying([
      underlying.address,
    ])) as `0x${string}`;
    const pTokenAddress = (await factory.read.pTokenForUnderlying([
      underlying.address,
    ])) as `0x${string}`;
    assert.notEqual(portalAddress.toLowerCase(), zeroAddress);
    assert.notEqual(pTokenAddress.toLowerCase(), zeroAddress);

    ppLog(`mine mother registration for pToken=${pTokenAddress}`);
    await mineLatestMotherRegistration(base, "ppFactoryRegister");
    assert.ok(
      await podCotiMother.read.isRegistered([BigInt(base.chainIds.sepolia), pTokenAddress]),
      "pToken namespace not registered on COTI mother"
    );

    const portal = await params.sepoliaViem.getContractAt("PrivacyPortal", portalAddress, {
      client,
    });
    const pod = await params.sepoliaViem.getContractAt(
      "PodErc20MintableInitializable",
      pTokenAddress,
      { client }
    );
    await registerPortalAesKeyIfSim(params.cotiViem, portalAddress, cotiPk);
    await fundPortalAndPToken(ownerWallet, base.sepolia.publicClient, portalAddress, pTokenAddress);

    ppLog(
      `setup complete (factory=${factory.address}, portal=${portalAddress}, pToken=${pTokenAddress})`
    );
    return {
      base,
      pod,
      podAsCoti: pod,
      podCotiMother,
      owner,
      ownerWallet,
      bob,
      portal,
      underlying,
      withdrawRecipient: PP_WITHDRAW_RECIPIENT,
      factory,
      portalImpl,
      sepoliaViem: params.sepoliaViem,
      cotiViem: params.cotiViem,
    };
  }

  ppLog("deploy PrivacyPortal clone + PodErc20Mintable (minter = portal)");
  const { portalNative } = oracleTokensForChain(base.chainIds.sepolia);
  const mockFactory = await params.sepoliaViem.deployContract(
    "MockPrivacyPortalFactory",
    [owner, portalNative],
    { client }
  );
  const cloneHelper = await params.sepoliaViem.deployContract("CloneHelper", [], { client });
  const portalImpl = await params.sepoliaViem.deployContract("PrivacyPortal", [], { client });
  const cloneTx = await cloneHelper.write.clone([portalImpl.address], { account: owner });
  const cloneReceipt = await base.sepolia.publicClient.waitForTransactionReceipt({
    hash: cloneTx,
    ...receiptWaitOptions,
  });
  if (cloneReceipt.status !== "success") {
    throw new Error(`CloneHelper.clone reverted (tx ${cloneTx})`);
  }
  const portalAddress = (await cloneHelper.read.lastClone()) as `0x${string}`;
  if (!portalAddress || portalAddress === zeroAddress) {
    throw new Error(`CloneHelper.lastClone returned zero after clone tx ${cloneTx}`);
  }
  const portal = await params.sepoliaViem.getContractAt("PrivacyPortal", portalAddress, {
    client,
  });
  // Use `portalAddress` (not `portal.address`) — hardhat-viem getContractAt can omit `.address`
  // when a custom client is passed, which previously encoded minter as address(0).
  const pod = await params.sepoliaViem.deployContract(
    "PodErc20Mintable",
    [
      portalAddress,
      base.chainIds.coti,
      base.contracts.inboxSepolia.address,
      podCotiMother.address,
      "Private TUSD",
      "pTUSD",
    ],
    { client }
  );

  await portal.write.initialize([underlying.address, pod.address, 18, false, mockFactory.address], {
    account: owner,
  });

  await registerPortalAesKeyIfSim(params.cotiViem, portalAddress, cotiPk);
  await fundPortalAndPToken(
    ownerWallet,
    base.sepolia.publicClient,
    portalAddress,
    pod.address as `0x${string}`
  );

  ppLog("register pToken namespace on COTI mother");
  await registerPodTokenOnMother({
    base,
    mother: podCotiMother,
    pTokenAddress: pod.address,
    registrar: owner,
    name: "Private TUSD",
    symbol: "pTUSD",
    decimals: 18,
  });

  const podAsCoti = await params.sepoliaViem.getContractAt("PodErc20Mintable", pod.address, {
    client,
  });

  ppLog(
    `setup complete (owner=${owner}, portal=${portal.address}, pToken=${pod.address}, mother=${podCotiMother.address})`
  );
  return {
    base,
    pod,
    podAsCoti,
    podCotiMother,
    owner,
    ownerWallet,
    bob,
    portal,
    underlying,
    withdrawRecipient: PP_WITHDRAW_RECIPIENT,
  };
}

export async function assertPortalWiring(ctx: PrivacyPortalSystemContext) {
  assert.equal((await ctx.portal.read.underlyingToken()).toLowerCase(), ctx.underlying.address.toLowerCase());
  assert.equal((await ctx.portal.read.pToken()).toLowerCase(), ctx.pod.address.toLowerCase());
  assert.equal((await ctx.portal.read.decimals()).toString(), "18");
  assert.equal((await ctx.pod.read.minter()).toLowerCase(), ctx.portal.address.toLowerCase());
  const registered = await ctx.podCotiMother.read.isRegistered([
    BigInt(ctx.base.chainIds.sepolia),
    ctx.pod.address,
  ]);
  assert.ok(registered, "pToken namespace not registered on COTI mother");
}

/** EIP-712 `TransferPermit` for `transferFromAndCallWithPermit` (portal withdraw path). */
export async function signPublicTransferPermit(params: {
  ctx: PrivacyPortalSystemContext;
  owner: `0x${string}`;
  spender: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  deadline: bigint;
}): Promise<{ deadline: bigint; v: number; r: `0x${string}`; s: `0x${string}` }> {
  const nonce = (await params.ctx.pod.read.nonces([params.owner])) as bigint;
  const tokenName = (await params.ctx.pod.read.name()) as string;
  const signature = await params.ctx.ownerWallet.signTypedData({
    account: params.owner,
    domain: {
      name: tokenName,
      version: "1",
      chainId: params.ctx.base.chainIds.sepolia,
      verifyingContract: params.ctx.pod.address,
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

export async function fundUnderlyingForDeposit(ctx: PrivacyPortalSystemContext, amount: bigint) {
  await ctx.underlying.write.mint([ctx.owner, amount], { account: ctx.owner });
  await ctx.underlying.write.approve([ctx.portal.address, amount], { account: ctx.owner });
}

/** Portal deposit → pToken public mint → full COTI + callback round-trip. */
export async function depositAndComplete(
  ctx: PrivacyPortalSystemContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; label: string; mineOptions?: MineRequestOptions }
) {
  const recipient = params.recipient ?? ctx.owner;
  const fees = ctx.base.podTwoWayFees;
  ppLog(`${params.label}: deposit ${amount} underlying → mint pToken for ${recipient}`);
  const hash = await ctx.portal.write.deposit([recipient, amount, 0n, fees.callbackFeeWei], {
    account: ctx.owner,
    value: fees.totalValueWei,
    gas: 5_000_000n,
  });
  await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
  await runCrossChainTwoWayRoundTrip(ctx.base, params.label, {
    ...params.mineOptions,
    gas: params.mineOptions?.gas ?? getDefaultCotiMineGasPodToken(),
  });
  const vault = (await ctx.underlying.read.balanceOf([ctx.portal.address])) as bigint;
  ppLog(`${params.label}: portal vault underlying=${vault}`);
}

/** Withdraw with permit: transfer-to-portal round-trip, then owner batch burn round-trip. */
export async function withdrawAndComplete(
  ctx: PrivacyPortalSystemContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; label: string; mineOptions?: MineRequestOptions }
) {
  const recipient = params.recipient ?? ctx.withdrawRecipient;
  const fees = ctx.base.podTwoWayFees;
  const transferFee = fees.totalValueWei;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 86_400);
  const permit = await signPublicTransferPermit({
    ctx,
    owner: ctx.owner,
    spender: ctx.portal.address,
    to: ctx.portal.address,
    value: amount,
    deadline,
  });

  ppLog(`${params.label}: requestWithdraw ${amount} pToken → underlying to ${recipient}`);
  const hash = await ctx.portal.write.requestWithdrawWithPermit(
    [
      recipient,
      amount,
      0n,
      transferFee,
      fees.callbackFeeWei,
      permit.deadline,
      permit.v,
      permit.r,
      permit.s,
    ],
    { account: ctx.owner, value: transferFee, gas: 5_000_000n }
  );
  await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });

  ppLog(`${params.label}: mine transfer leg (pToken → portal, portal callback)`);
  await runCrossChainTwoWayRoundTrip(ctx.base, `${params.label}:xfer`, {
    ...params.mineOptions,
    gas: params.mineOptions?.gas ?? getDefaultCotiMineGasPodToken(),
  });

  ppLog(`${params.label}: owner batch burn ${amount} pTokens held in portal`);
  const burnHash = await ctx.portal.write.burnAccumulatedPTokens([amount, fees.callbackFeeWei], {
    account: ctx.owner,
    value: fees.totalValueWei,
    gas: 5_000_000n,
  });
  const burnReceipt = await ctx.base.sepolia.publicClient.waitForTransactionReceipt({
    hash: burnHash,
    ...receiptWaitOptions,
  });
  const burnSubmitted = parseEventLogs({
    abi: ctx.portal.abi,
    logs: burnReceipt.logs,
    eventName: "BatchBurnSubmitted",
  });
  assert.ok(burnSubmitted.length > 0, "BatchBurnSubmitted event missing");
  const burnRequestId = burnSubmitted[0].args.burnRequestId as `0x${string}`;

  ppLog(`${params.label}: mine batch burn leg`);
  await runCrossChainTwoWayRoundTrip(ctx.base, `${params.label}:burn`, {
    ...params.mineOptions,
    gas: params.mineOptions?.gas ?? getDefaultCotiMineGasPodToken(),
  });

  ppLog(`${params.label}: finalizeBatchBurn ${burnRequestId}`);
  const finalizeHash = await ctx.portal.write.finalizeBatchBurn([burnRequestId], {
    account: ctx.owner,
  });
  await ctx.base.sepolia.publicClient.waitForTransactionReceipt({
    hash: finalizeHash,
    ...receiptWaitOptions,
  });

  const released = (await ctx.underlying.read.balanceOf([recipient])) as bigint;
  ppLog(`${params.label}: recipient underlying balance=${released}`);
}

/** Seed zero ciphertext for an account via `syncBalances` (same as pod-token `before` hook). */
export async function seedZeroBalanceOnPod(ctx: PrivacyPortalSystemContext, account: `0x${string}`, label: string) {
  await syncPodBalancesRoundTrip(ctx, [account], label);
}

/** Re-export pod helpers that accept the shared pod fields on `PrivacyPortalSystemContext`. */
export {
  completePodOpRoundTrip,
  encryptAmount,
  readAllowanceWithPending,
  readBalanceWithPending,
  readDecryptedAllowance,
  readDecryptedBalance,
} from "../tokens/test-token-utils.js";

export type { TestContext };
