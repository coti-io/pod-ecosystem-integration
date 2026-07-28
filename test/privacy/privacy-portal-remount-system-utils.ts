/**
 * Factory-backed Privacy Portal remount helpers for dual-chain system tests.
 * Uses the real {PrivacyPortalFactory} (not MockPrivacyPortalFactory) so
 * createPortalWithExistingPToken / retire / minter rotation are exercised end-to-end.
 */
import assert from "node:assert/strict";
import { parseEventLogs, zeroAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { oracleTokensForChain } from "../../scripts/oracle-tokens.js";
import {
  fundContractForInboxFees,
  getLatestRequest,
  mineRequest,
  normalizePrivateKey,
  receiptWaitOptions,
  resolveCotiTestnetPrivateKey,
  setupContext,
} from "../system/mpc-test-utils.js";
import {
  getDefaultCotiMineGasPodToken,
  POD_TOKEN_ONE_WAY_REGISTRATION_FEE_WEI,
  setupBobUser,
} from "../tokens/test-token-utils.js";
import { MAX_PACKED_FEE } from "./privacy-portal-utils.js";
import {
  ppLog,
  type PrivacyPortalSystemContext,
  PP_WITHDRAW_RECIPIENT,
} from "./privacy-portal-system-utils.js";

export type PrivacyPortalRemountContext = PrivacyPortalSystemContext & {
  factory: any;
  portalImpl: any;
  sepoliaViem: any;
  cotiViem: any;
};

async function registerPortalAesKeyIfSim(
  cotiViem: any,
  portalAddress: `0x${string}`,
  cotiPk: string
) {
  if (!["sim", "simcoti"].includes((process.env.COTI_BACKEND ?? "").trim().toLowerCase())) {
    return;
  }
  const { registerUserOnSim, deriveUserAesKey } = await import("../sim-coti/sim-coti-utils.js");
  const portalKey = deriveUserAesKey(cotiPk);
  const [signer] = await cotiViem.getWalletClients();
  await registerUserOnSim(cotiViem, portalAddress, portalKey, signer.account);
  ppLog(`simCoti: registered portal AES key for ${portalAddress}`);
}

/** Deploy mother + PrivacyPortalFactory on the dual-chain harness, create one portal/pToken pair, mine mother registration. */
export async function setupPrivacyPortalRemountContext(params: {
  sepoliaViem: any;
  cotiViem: any;
}): Promise<PrivacyPortalRemountContext> {
  const base = await setupContext(params);

  const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey());
  const cotiAccount = privateKeyToAccount(cotiPk as `0x${string}`);
  const owner = cotiAccount.address;
  const hardhatCotiWallet = await params.sepoliaViem.getWalletClient(owner);
  const client = { public: base.sepolia.publicClient, wallet: hardhatCotiWallet };

  ppLog("deploy PodErc20CotiMother on COTI");
  const podCotiMother = await params.cotiViem.deployContract(
    "PodErc20CotiMother",
    [base.contracts.inboxCoti.address, owner],
    { client: { public: base.coti.publicClient, wallet: base.coti.wallet } } as any
  );

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

  ppLog("deploy underlying MockERC20Decimals");
  const underlying = await params.sepoliaViem.deployContract(
    "MockERC20Decimals",
    ["Test USD", "TUSD", 18],
    { client }
  );

  ppLog("createPortal (one-way mother registration)");
  const createHash = await factory.write.createPortal(
    [underlying.address, "Private TUSD", "pTUSD", 18, false],
    {
      account: owner,
      value: POD_TOKEN_ONE_WAY_REGISTRATION_FEE_WEI,
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
  const outboundRequest = await getLatestRequest(
    base.contracts.inboxSepolia,
    base.chainIds.coti
  );
  await mineRequest(
    base,
    "coti",
    BigInt(base.chainIds.sepolia),
    outboundRequest,
    "ppRemountRegister",
    { gas: getDefaultCotiMineGasPodToken() }
  );
  const registered = await podCotiMother.read.isRegistered([
    BigInt(base.chainIds.sepolia),
    pTokenAddress,
  ]);
  assert.ok(registered, "pToken namespace not registered on COTI mother");

  const portal = await params.sepoliaViem.getContractAt("PrivacyPortal", portalAddress, {
    client,
  });
  const pod = await params.sepoliaViem.getContractAt("PodErc20MintableInitializable", pTokenAddress, {
    client,
  });
  const podAsCoti = pod;

  await registerPortalAesKeyIfSim(params.cotiViem, portalAddress, cotiPk);
  await fundContractForInboxFees(hardhatCotiWallet, base.sepolia.publicClient, pTokenAddress);
  await fundContractForInboxFees(hardhatCotiWallet, base.sepolia.publicClient, portalAddress);

  const bob = await setupBobUser(cotiPk, { cotiViem: params.cotiViem });

  ppLog(
    `remount setup ready (factory=${factory.address}, portal=${portalAddress}, pToken=${pTokenAddress})`
  );

  return {
    base,
    factory,
    portalImpl,
    portal,
    underlying,
    pod,
    podAsCoti,
    podCotiMother,
    owner,
    ownerWallet: hardhatCotiWallet,
    bob,
    withdrawRecipient: PP_WITHDRAW_RECIPIENT,
    sepoliaViem: params.sepoliaViem,
    cotiViem: params.cotiViem,
  };
}

/** Pause old portal (required), remount onto a new portal clone, rebind ctx.portal / fees / sim AES. */
export async function remountPausedPortal(
  ctx: PrivacyPortalRemountContext,
  params: { bumpImplementation?: boolean; label?: string } = {}
): Promise<{
  oldPortal: any;
  oldPortalAddress: `0x${string}`;
  newPortalAddress: `0x${string}`;
}> {
  const label = params.label ?? "remount";
  const oldPortal = ctx.portal;
  const oldPortalAddress = oldPortal.address as `0x${string}`;
  const pTokenAddress = ctx.pod.address as `0x${string}`;

  ppLog(`${label}: pause old portal ${oldPortalAddress}`);
  const pauseHash = await oldPortal.write.pause({ account: ctx.owner });
  await ctx.base.sepolia.publicClient.waitForTransactionReceipt({
    hash: pauseHash,
    ...receiptWaitOptions,
  });
  assert.equal(await oldPortal.read.paused(), true);

  if (params.bumpImplementation !== false) {
    ppLog(`${label}: deploy + setPortalImplementation`);
    const client = { public: ctx.base.sepolia.publicClient, wallet: ctx.ownerWallet };
    const portalImplV2 = await ctx.sepoliaViem.deployContract("PrivacyPortal", [], { client });
    const setHash = await ctx.factory.write.setPortalImplementation([portalImplV2.address], {
      account: ctx.owner,
    });
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({
      hash: setHash,
      ...receiptWaitOptions,
    });
    ctx.portalImpl = portalImplV2;
  }

  ppLog(`${label}: createPortalWithExistingPToken`);
  const remountHash = await ctx.factory.write.createPortalWithExistingPToken(
    [ctx.underlying.address, pTokenAddress, false],
    { account: ctx.owner, gas: 5_000_000n }
  );
  const remountReceipt = await ctx.base.sepolia.publicClient.waitForTransactionReceipt({
    hash: remountHash,
    ...receiptWaitOptions,
  });
  const replaced = parseEventLogs({
    abi: ctx.factory.abi,
    logs: remountReceipt.logs,
    eventName: "PortalReplaced",
  });
  assert.ok(replaced.length > 0, "PortalReplaced missing");

  const newPortalAddress = (await ctx.factory.read.portalForUnderlying([
    ctx.underlying.address,
  ])) as `0x${string}`;
  assert.notEqual(newPortalAddress.toLowerCase(), oldPortalAddress.toLowerCase());
  assert.equal(
    ((await ctx.factory.read.pTokenForUnderlying([ctx.underlying.address])) as string).toLowerCase(),
    pTokenAddress.toLowerCase()
  );
  assert.equal(
    ((await ctx.pod.read.minter()) as string).toLowerCase(),
    newPortalAddress.toLowerCase()
  );

  const newPortal = await ctx.sepoliaViem.getContractAt("PrivacyPortal", newPortalAddress, {
    client: { public: ctx.base.sepolia.publicClient, wallet: ctx.ownerWallet },
  });
  assert.equal(await newPortal.read.paused(), true);
  assert.equal(await oldPortal.read.isDepositEnabled(), false);
  assert.equal(((await oldPortal.read.factory()) as string).toLowerCase(), zeroAddress);
  assert.equal(
    ((await oldPortal.read.bindingFactory()) as string).toLowerCase(),
    (ctx.factory.address as string).toLowerCase()
  );

  const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey());
  await registerPortalAesKeyIfSim(ctx.cotiViem, newPortalAddress, cotiPk);
  await fundContractForInboxFees(
    ctx.ownerWallet,
    ctx.base.sepolia.publicClient,
    newPortalAddress
  );

  ctx.portal = newPortal;
  ppLog(`${label}: new portal=${newPortalAddress} (old=${oldPortalAddress})`);
  return { oldPortal, oldPortalAddress, newPortalAddress };
}

/** Soft-ops migrate: rescue ERC20 from paused old → fund new → unpause new. */
export async function migrateCollateralAndUnpause(
  ctx: PrivacyPortalRemountContext,
  oldPortal: any,
  params: { label?: string } = {}
) {
  const label = params.label ?? "migrate";
  const newPortalAddress = ctx.portal.address as `0x${string}`;
  const oldBal = (await ctx.underlying.read.balanceOf([oldPortal.address])) as bigint;
  ppLog(`${label}: rescueERC20 ${oldBal} from old portal → rescueRecipient`);
  if (oldBal > 0n) {
    const rescueHash = await oldPortal.write.rescueERC20([ctx.underlying.address, oldBal], {
      account: ctx.owner,
    });
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({
      hash: rescueHash,
      ...receiptWaitOptions,
    });
    const xferHash = await ctx.underlying.write.transfer([newPortalAddress, oldBal], {
      account: ctx.owner,
    });
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({
      hash: xferHash,
      ...receiptWaitOptions,
    });
  }
  assert.equal((await ctx.underlying.read.balanceOf([oldPortal.address])) as bigint, 0n);
  assert.equal((await ctx.underlying.read.balanceOf([newPortalAddress])) as bigint, oldBal);

  ppLog(`${label}: unpause new portal`);
  const unpauseHash = await ctx.portal.write.unpause({ account: ctx.owner });
  await ctx.base.sepolia.publicClient.waitForTransactionReceipt({
    hash: unpauseHash,
    ...receiptWaitOptions,
  });
  assert.equal(await ctx.portal.read.paused(), false);
}
