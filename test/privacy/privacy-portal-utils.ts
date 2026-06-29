import assert from "node:assert/strict";
import { encodePacked, getAddress, keccak256, zeroAddress, zeroHash, type PublicClient, type WalletClient } from "viem";
import { deployInboxWithInit } from "../system/mpc-test-utils.js";

export const RECIPIENT = "0x00000000000000000000000000000000000000b0" as `0x${string}`;

export const DEFAULT_WITHDRAW = {
  transferFee: 100n,
  transferCallbackFee: 11n,
  burnFee: 200n,
  burnCallbackFee: 22n,
  permitDeadline: 999_999_999n,
  v: 27,
  r: zeroHash,
  s: zeroHash,
} as const;

export type PortalTestContext = {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
  recipient: `0x${string}`;
  underlying: any;
  pToken: any;
  portal: any;
};

const writeOpts = (ctx: PortalTestContext) => ({ account: ctx.owner });

export async function deployDirectPortalContext(params: {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
}): Promise<PortalTestContext> {
  const underlying = await params.viem.deployContract("MockERC20", ["USD Coin", "USDC"], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const pToken = await params.viem.deployContract("MockPodERC20ForPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const portal = await params.viem.deployContract("PrivacyPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  await portal.write.initialize([params.owner, underlying.address, pToken.address, 18, false], {
    account: params.owner,
  });

  return {
    viem: params.viem,
    publicClient: params.publicClient,
    wallet: params.wallet,
    owner: params.owner,
    recipient: RECIPIENT,
    underlying,
    pToken,
    portal,
  };
}

export async function fundUserAndApprovePortal(ctx: PortalTestContext, amount: bigint) {
  await ctx.underlying.write.mint([ctx.owner, amount], writeOpts(ctx));
  await ctx.underlying.write.approve([ctx.portal.address, amount], writeOpts(ctx));
}

export async function depositPublicToken(
  ctx: PortalTestContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; fee?: bigint; callbackFee?: bigint } = {}
) {
  await ctx.portal.write.deposit([params.recipient ?? ctx.recipient, amount, params.callbackFee ?? 77n], {
    ...writeOpts(ctx),
    value: params.fee ?? 1_000n,
  });
}

export async function deployNativePortalContext(params: {
  viem: any;
  publicClient: PublicClient;
  wallet: WalletClient;
  owner: `0x${string}`;
}): Promise<PortalTestContext> {
  const underlying = await params.viem.deployContract("MockWrappedNative", ["Wrapped Ether", "WETH"], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const pToken = await params.viem.deployContract("MockPodERC20ForPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  const portal = await params.viem.deployContract("PrivacyPortal", [], {
    client: { public: params.publicClient, wallet: params.wallet },
  });
  await portal.write.initialize([params.owner, underlying.address, pToken.address, 18, true], {
    account: params.owner,
  });

  return {
    viem: params.viem,
    publicClient: params.publicClient,
    wallet: params.wallet,
    owner: params.owner,
    recipient: RECIPIENT,
    underlying,
    pToken,
    portal,
  };
}

export async function depositNativeToken(
  ctx: PortalTestContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; mintFee?: bigint; callbackFee?: bigint } = {}
) {
  const mintFee = params.mintFee ?? 1_000n;
  await ctx.portal.write.depositNative([params.recipient ?? ctx.recipient, amount, params.callbackFee ?? 77n], {
    ...writeOpts(ctx),
    value: amount + mintFee,
  });
}

export async function seedPortalVault(ctx: PortalTestContext, amount: bigint) {
  await ctx.underlying.write.mint([ctx.portal.address, amount], writeOpts(ctx));
}

/** Seed a native-wrapped portal vault with ETH-backed WETH (not bare mint). */
export async function seedNativePortalVault(ctx: PortalTestContext, amount: bigint) {
  await ctx.underlying.write.deposit({ account: ctx.owner, value: amount });
  await ctx.underlying.write.transfer([ctx.portal.address, amount], writeOpts(ctx));
}

export async function requestWithdraw(
  ctx: PortalTestContext,
  amount: bigint,
  params: { recipient?: `0x${string}`; transferFee?: bigint; burnFee?: bigint } = {}
) {
  const transferFee = params.transferFee ?? DEFAULT_WITHDRAW.transferFee;
  const burnFee = params.burnFee ?? DEFAULT_WITHDRAW.burnFee;
  const recipient = params.recipient ?? ctx.recipient;
  const nonce = await ctx.portal.read.withdrawalNonce();
  const withdrawalId = keccak256(
    encodePacked(
      ["address", "address", "address", "uint256", "uint256"],
      [ctx.portal.address, ctx.owner, recipient, amount, nonce]
    )
  );
  await ctx.portal.write.requestWithdrawWithPermit(
    [
      recipient,
      amount,
      transferFee,
      DEFAULT_WITHDRAW.transferCallbackFee,
      burnFee,
      DEFAULT_WITHDRAW.burnCallbackFee,
      DEFAULT_WITHDRAW.permitDeadline,
      DEFAULT_WITHDRAW.v,
      DEFAULT_WITHDRAW.r,
      DEFAULT_WITHDRAW.s,
    ],
    { ...writeOpts(ctx), value: transferFee + burnFee }
  );
  const transferRequestId = await ctx.pToken.read.lastTransferRequestId();
  return { withdrawalId, transferRequestId };
}

export async function completePTokenTransferCallback(ctx: PortalTestContext) {
  await ctx.pToken.write.triggerLastTransferCallback([], writeOpts(ctx));
}

export async function markPTokenTransferSuccessful(ctx: PortalTestContext) {
  await ctx.pToken.write.markLastTransferSuccessful([], writeOpts(ctx));
}

export async function triggerWithdrawalRelease(ctx: PortalTestContext, withdrawalId: `0x${string}`) {
  await ctx.portal.write.triggerWithdrawalRelease([withdrawalId], writeOpts(ctx));
}

export async function setBurnSubmissionFailure(ctx: PortalTestContext, shouldFail: boolean) {
  await ctx.pToken.write.setBurnShouldRevert([shouldFail], writeOpts(ctx));
}

export async function burnAccumulatedDebt(ctx: PortalTestContext, amount: bigint) {
  await ctx.portal.write.burnAccumulatedDebt(
    [amount, DEFAULT_WITHDRAW.burnFee, DEFAULT_WITHDRAW.burnCallbackFee],
    { ...writeOpts(ctx), value: DEFAULT_WITHDRAW.burnFee }
  );
}

export async function expectDepositMintSubmitted(
  ctx: PortalTestContext,
  params: { amount: bigint; recipient?: `0x${string}`; fee?: bigint; callbackFee?: bigint }
) {
  assert.equal(await ctx.underlying.read.balanceOf([ctx.portal.address]), params.amount);
  assert.equal(await ctx.pToken.read.lastMintRecipient(), getAddress(params.recipient ?? ctx.recipient));
  assert.equal(await ctx.pToken.read.lastMintAmount(), params.amount);
  assert.equal(await ctx.pToken.read.lastMintValue(), params.fee ?? 1_000n);
  assert.equal(await ctx.pToken.read.lastMintCallbackFee(), params.callbackFee ?? 77n);
}

export async function expectWithdrawTransferSubmitted(ctx: PortalTestContext, amount: bigint) {
  assert.equal(await ctx.pToken.read.lastTransferFrom(), getAddress(ctx.owner));
  assert.equal(await ctx.pToken.read.lastTransferTo(), getAddress(ctx.portal.address));
  assert.equal(await ctx.pToken.read.lastTransferAmount(), amount);
  assert.equal(await ctx.pToken.read.lastTransferValue(), DEFAULT_WITHDRAW.transferFee);
  assert.equal(await ctx.pToken.read.lastTransferCallbackFee(), DEFAULT_WITHDRAW.transferCallbackFee);
  assert.equal(await ctx.portal.read.withdrawalNonce(), 1n);
}

export async function deployCotiMother(ctx: PortalTestContext, inboxAddress: `0x${string}`) {
  return ctx.viem.deployContract("PodErc20CotiMother", [inboxAddress, ctx.owner], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
}

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const deployInboxWithFees = async (viem: any, chainId: bigint, client: { public: PublicClient; wallet: WalletClient }) => {
  const inbox = await deployInboxWithInit(viem, chainId, { client });
  const oracle = await viem.deployContract("PriceOracle", [client.wallet.account.address], { client });
  await oracle.write.setLocalTokenPriceUSD([10n ** 18n], { account: client.wallet.account.address });
  await oracle.write.setRemoteTokenPriceUSD([10n ** 18n], { account: client.wallet.account.address });
  await inbox.write.setPriceOracle([oracle.address], { account: client.wallet.account.address });
  await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], {
    account: client.wallet.account.address,
  });
  return inbox;
};

export async function deployPortalFactory(ctx: PortalTestContext) {
  const client = { public: ctx.publicClient, wallet: ctx.wallet };
  const inbox = await deployInboxWithFees(ctx.viem, 31337n, client);
  const mother = await deployCotiMother(ctx, inbox.address);
  const portalImplementation = await ctx.viem.deployContract("PrivacyPortal", [], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
  const tokenImplementation = await ctx.viem.deployContract("PodErc20MintableInitializable", [], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });
  const factory = await ctx.viem.deployContract(
    "PrivacyPortalFactory",
    [ctx.owner, inbox.address, 7082400n, mother.address, tokenImplementation.address, portalImplementation.address],
    { client: { public: ctx.publicClient, wallet: ctx.wallet } }
  );
  return { factory, mother, inbox };
}

export async function deployFactoryPortalPair(ctx: PortalTestContext) {
  const { factory } = await deployPortalFactory(ctx);
  const underlying = await ctx.viem.deployContract("MockERC20", ["Second", "SEC"], {
    client: { public: ctx.publicClient, wallet: ctx.wallet },
  });

  await factory.write.createPortal(
    [underlying.address, "Private SEC", "pSEC", 6, false, ctx.owner],
    { ...writeOpts(ctx), value: 2_500_000_000_000n }
  );

  const portal = await factory.read.portalForUnderlying([underlying.address]);
  const pToken = await factory.read.pTokenForUnderlying([underlying.address]);
  return { factory, underlying, portal, pToken };
}

export { zeroAddress };
