/**
 * Cross-chain Privacy Portal remount E2E (Hardhat/Sepolia ↔ sim COTI or live COTI testnet).
 *
 * Soft-ops model: pause old → remount (same pToken) → migrate collateral → unpause new → withdraw.
 *
 * Run (sim):  `npm run test:pp-remount`
 * Live COTI:  `COTI_BACKEND=live npm run test:pp-remount`
 *
 * Requires sibling coti-contracts with portal remount APIs linked via `npm run link:contracts`.
 * Step logs: grep `[mpc-test] privacy-portal-system:`
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { collectInboxFeesAfterTest, logStep } from "../system/mpc-test-utils.js";
import { connectDualChainForTests } from "../sim-coti/sim-coti-utils.js";
import {
  depositAndComplete,
  fundUnderlyingForDeposit,
  ppLog,
  readDecryptedBalance,
  seedZeroBalanceOnPod,
  setupPrivacyPortalSystemContext,
  withdrawAndComplete,
  type PrivacyPortalSystemContext,
} from "./privacy-portal-system-utils.js";
import {
  migrateCollateralAndUnpause,
  remountPausedPortal,
} from "./privacy-portal-remount-system-utils.js";

const runRemount = process.env.PP_REMOUNT_SYSTEM_TESTS === "1";
const d = runRemount ? describe : describe.skip;

if (!runRemount) {
  logStep(
    'privacy-portal-remount-system: suite skipped — PP_REMOUNT_SYSTEM_TESTS is not "1". Use: npm run test:pp-remount'
  );
}

d("PrivacyPortal remount (Sepolia ↔ COTI system)", { concurrency: 1 }, async function () {
  const { sepoliaViem, cotiViem } = await connectDualChainForTests();

  let ctx: PrivacyPortalSystemContext;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx.base);
  });

  before(async function () {
    ppLog("before: shared PP system setup with real factory (useFactory)");
    if (process.env.COTI_REUSE_CONTRACTS === undefined) {
      process.env.COTI_REUSE_CONTRACTS = "false";
    }
    ctx = await setupPrivacyPortalSystemContext({ sepoliaViem, cotiViem, useFactory: true });
    await seedZeroBalanceOnPod(ctx, ctx.owner, "seedOwnerZero");
    ppLog(`before: ready (factory=${ctx.factory!.address}, portal=${ctx.portal.address})`);
  });

  it("reverts remount when old portal is not paused", async function () {
    ppLog("case remount-not-paused: expect OldPortalNotPaused");
    await assert.rejects(
      ctx.factory.write.createPortalWithExistingPToken(
        [ctx.underlying.address, ctx.pod.address, false],
        { account: ctx.owner, gas: 5_000_000n }
      ),
      (err: unknown) => {
        const msg = String(err);
        return msg.includes("OldPortalNotPaused") || msg.includes("0x");
      }
    );
    ppLog("case remount-not-paused: done");
  });

  it("rejects remount that flips wrap mode (non-native → native)", async function () {
    ppLog("case remount-wrap-flip: pause then remount with nativeWrappedUnderlying=true");
    const pauseHash = await ctx.portal.write.pause({ account: ctx.owner });
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: pauseHash });

    await assert.rejects(
      ctx.factory.write.createPortalWithExistingPToken(
        [ctx.underlying.address, ctx.pod.address, true],
        { account: ctx.owner, gas: 5_000_000n }
      ),
      (err: unknown) => {
        const msg = String(err);
        return (
          msg.includes("NativeWrapMismatch") ||
          msg.includes("NativePortalRequiresNative") ||
          msg.includes("0x")
        );
      }
    );

    const unpauseHash = await ctx.portal.write.unpause({ account: ctx.owner });
    await ctx.base.sepolia.publicClient.waitForTransactionReceipt({ hash: unpauseHash });
    ppLog("case remount-wrap-flip: done (unpaused for happy path)");
  });

  it("deposit → remount → migrate → withdraw on new portal", async function () {
    ppLog("case remount-happy: start");
    const amount = 12_000n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);

    await fundUnderlyingForDeposit(ctx, amount);
    await depositAndComplete(ctx, amount, { recipient: ctx.owner, label: "remountDeposit" });
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + amount);
    assert.equal(
      (await ctx.underlying.read.balanceOf([ctx.portal.address])) as bigint,
      amount
    );

    const { oldPortal, oldPortalAddress, newPortalAddress } = await remountPausedPortal(ctx, {
      label: "remountHappy",
    });

    // Soft close: deposits rejected on paused new portal before migrate/unpause.
    await fundUnderlyingForDeposit(ctx, 1n);
    await assert.rejects(
      ctx.portal.write.deposit([ctx.owner, 1n, 0n, ctx.base.podTwoWayFees.callbackFeeWei], {
        account: ctx.owner,
        value: ctx.base.podTwoWayFees.totalValueWei,
        gas: 5_000_000n,
      }),
      /DepositsPaused|paused|0x/i
    );

    await migrateCollateralAndUnpause(ctx, oldPortal, { label: "remountHappy" });
    assert.equal(
      (await ctx.underlying.read.balanceOf([newPortalAddress])) as bigint,
      amount
    );
    assert.equal((await ctx.underlying.read.balanceOf([oldPortalAddress])) as bigint, 0n);

    const recipientBefore = (await ctx.underlying.read.balanceOf([
      ctx.withdrawRecipient,
    ])) as bigint;
    await withdrawAndComplete(ctx, amount, { label: "remountWithdraw" });

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore);
    assert.equal(
      (await ctx.underlying.read.balanceOf([ctx.withdrawRecipient])) as bigint,
      recipientBefore + amount
    );
    assert.equal((await ctx.portal.read.pendingBurnAmount()) as bigint, 0n);
    ppLog("case remount-happy: done");
  });
});
