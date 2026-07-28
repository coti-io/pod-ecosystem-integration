/**
 * Remount-only helpers on top of {@link setupPrivacyPortalSystemContext} (`useFactory: true`).
 */
import assert from "node:assert/strict";
import { parseEventLogs, zeroAddress } from "viem";
import {
  fundContractForInboxFees,
  normalizePrivateKey,
  receiptWaitOptions,
  resolveCotiTestnetPrivateKey,
} from "../system/mpc-test-utils.js";
import {
  ppLog,
  registerPortalAesKeyIfSim,
  type PrivacyPortalSystemContext,
} from "./privacy-portal-system-utils.js";

export type PrivacyPortalRemountContext = PrivacyPortalSystemContext & {
  factory: any;
  portalImpl: any;
  sepoliaViem: any;
  cotiViem: any;
};

function requireFactoryCtx(ctx: PrivacyPortalSystemContext): PrivacyPortalRemountContext {
  if (!ctx.factory || !ctx.sepoliaViem || !ctx.cotiViem) {
    throw new Error("remount helpers require setupPrivacyPortalSystemContext({ useFactory: true })");
  }
  return ctx as PrivacyPortalRemountContext;
}

/** Pause old portal (required), remount onto a new portal clone, rebind ctx.portal / fees / sim AES. */
export async function remountPausedPortal(
  ctx: PrivacyPortalSystemContext,
  params: { bumpImplementation?: boolean; label?: string } = {}
): Promise<{
  oldPortal: any;
  oldPortalAddress: `0x${string}`;
  newPortalAddress: `0x${string}`;
}> {
  const rctx = requireFactoryCtx(ctx);
  const label = params.label ?? "remount";
  const oldPortal = rctx.portal;
  const oldPortalAddress = oldPortal.address as `0x${string}`;
  const pTokenAddress = rctx.pod.address as `0x${string}`;

  ppLog(`${label}: pause old portal ${oldPortalAddress}`);
  const pauseHash = await oldPortal.write.pause({ account: rctx.owner });
  await rctx.base.sepolia.publicClient.waitForTransactionReceipt({
    hash: pauseHash,
    ...receiptWaitOptions,
  });
  assert.equal(await oldPortal.read.paused(), true);

  if (params.bumpImplementation !== false) {
    ppLog(`${label}: deploy + setPortalImplementation`);
    const client = { public: rctx.base.sepolia.publicClient, wallet: rctx.ownerWallet };
    const portalImplV2 = await rctx.sepoliaViem.deployContract("PrivacyPortal", [], { client });
    const setHash = await rctx.factory.write.setPortalImplementation([portalImplV2.address], {
      account: rctx.owner,
    });
    await rctx.base.sepolia.publicClient.waitForTransactionReceipt({
      hash: setHash,
      ...receiptWaitOptions,
    });
    rctx.portalImpl = portalImplV2;
  }

  ppLog(`${label}: createPortalWithExistingPToken`);
  const remountHash = await rctx.factory.write.createPortalWithExistingPToken(
    [rctx.underlying.address, pTokenAddress, false],
    { account: rctx.owner, gas: 5_000_000n }
  );
  const remountReceipt = await rctx.base.sepolia.publicClient.waitForTransactionReceipt({
    hash: remountHash,
    ...receiptWaitOptions,
  });
  const replaced = parseEventLogs({
    abi: rctx.factory.abi,
    logs: remountReceipt.logs,
    eventName: "PortalReplaced",
  });
  assert.ok(replaced.length > 0, "PortalReplaced missing");

  const newPortalAddress = (await rctx.factory.read.portalForUnderlying([
    rctx.underlying.address,
  ])) as `0x${string}`;
  assert.notEqual(newPortalAddress.toLowerCase(), oldPortalAddress.toLowerCase());
  assert.equal(
    (
      (await rctx.factory.read.pTokenForUnderlying([rctx.underlying.address])) as string
    ).toLowerCase(),
    pTokenAddress.toLowerCase()
  );
  assert.equal(
    ((await rctx.pod.read.minter()) as string).toLowerCase(),
    newPortalAddress.toLowerCase()
  );

  const newPortal = await rctx.sepoliaViem.getContractAt("PrivacyPortal", newPortalAddress, {
    client: { public: rctx.base.sepolia.publicClient, wallet: rctx.ownerWallet },
  });
  assert.equal(await newPortal.read.paused(), true);
  assert.equal(await oldPortal.read.isDepositEnabled(), false);
  assert.equal(((await oldPortal.read.factory()) as string).toLowerCase(), zeroAddress);
  assert.equal(
    ((await oldPortal.read.bindingFactory()) as string).toLowerCase(),
    (rctx.factory.address as string).toLowerCase()
  );

  const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey());
  await registerPortalAesKeyIfSim(rctx.cotiViem, newPortalAddress, cotiPk);
  await fundContractForInboxFees(
    rctx.ownerWallet,
    rctx.base.sepolia.publicClient,
    newPortalAddress
  );

  rctx.portal = newPortal;
  ppLog(`${label}: new portal=${newPortalAddress} (old=${oldPortalAddress})`);
  return { oldPortal, oldPortalAddress, newPortalAddress };
}

/** Soft-ops migrate: rescue ERC20 from paused old → fund new → unpause new. */
export async function migrateCollateralAndUnpause(
  ctx: PrivacyPortalSystemContext,
  oldPortal: any,
  params: { label?: string } = {}
) {
  const rctx = requireFactoryCtx(ctx);
  const label = params.label ?? "migrate";
  const newPortalAddress = rctx.portal.address as `0x${string}`;
  const oldBal = (await rctx.underlying.read.balanceOf([oldPortal.address])) as bigint;
  ppLog(`${label}: rescueERC20 ${oldBal} from old portal → rescueRecipient`);
  if (oldBal > 0n) {
    const rescueHash = await oldPortal.write.rescueERC20([rctx.underlying.address, oldBal], {
      account: rctx.owner,
    });
    await rctx.base.sepolia.publicClient.waitForTransactionReceipt({
      hash: rescueHash,
      ...receiptWaitOptions,
    });
    const xferHash = await rctx.underlying.write.transfer([newPortalAddress, oldBal], {
      account: rctx.owner,
    });
    await rctx.base.sepolia.publicClient.waitForTransactionReceipt({
      hash: xferHash,
      ...receiptWaitOptions,
    });
  }
  assert.equal((await rctx.underlying.read.balanceOf([oldPortal.address])) as bigint, 0n);
  assert.equal((await rctx.underlying.read.balanceOf([newPortalAddress])) as bigint, oldBal);

  ppLog(`${label}: unpause new portal`);
  const unpauseHash = await rctx.portal.write.unpause({ account: rctx.owner });
  await rctx.base.sepolia.publicClient.waitForTransactionReceipt({
    hash: unpauseHash,
    ...receiptWaitOptions,
  });
  assert.equal(await rctx.portal.read.paused(), false);
}
