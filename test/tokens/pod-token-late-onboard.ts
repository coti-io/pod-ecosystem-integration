/**
 * Late-onboard recipient/spender: transfer and approve succeed before COTI onboarding;
 * after onboard + sync (and re-approve for allowance), PoD ciphertext decrypts to expected values.
 *
 * Run: `npm run test:pod-token-late-onboard` (sets `POD_TOKEN_LATE_ONBOARD_TESTS=1`).
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { decryptUint } from "@coti-io/coti-sdk-typescript";
import { ONBOARD_CONTRACT_ADDRESS } from "@coti-io/coti-ethers";
import {
  collectInboxFeesAfterTest,
  decryptUint256,
  isSimCotiBackend,
  logStep,
  normalizePrivateKey,
  onboardUser,
  podTwoWayWriteOptions,
  resolveCotiTestnetPrivateKey,
} from "../system/mpc-test-utils.js";
import { connectDualChainForTests, registerUserOnSim } from "../sim-coti/sim-coti-utils.js";
import {
  completePodOpRoundTrip,
  mintOnCotiAndSync,
  readDecryptedBalance,
  setupFundedUnonboardedUser,
  setupPodTokenTestContext,
  syncPodBalancesRoundTrip,
  type PodTokenTestContext,
} from "./test-token-utils.js";
const runLateOnboard = process.env.POD_TOKEN_LATE_ONBOARD_TESTS === "1";
const d = runLateOnboard ? describe : describe.skip;

if (!runLateOnboard) {
  logStep(
    'pod-token-late-onboard: suite skipped — set POD_TOKEN_LATE_ONBOARD_TESTS=1. Use: npm run test:pod-token-late-onboard'
  );
}

const lo = (message: string) => logStep(`pod-token-late-onboard: ${message}`);

/** Charlie uses xor 0x02 so it does not collide with Bob (0x01). */
const CHARLIE_XOR = 0x02;
const CHARLIE_AES_ENV = "COTI_AES_KEY_CHARLIE";

d("PodERC20 late onboard (non-onboarded recipient/spender)", { concurrency: 1 }, async function () {
  const { sepoliaViem, cotiViem } = await connectDualChainForTests();

  let ctx: PodTokenTestContext;
  let charlie: { address: `0x${string}`; privateKey: `0x${string}` };
  let charlieUserKey: string | undefined;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx.base);
  });

  before(async function () {
    if (process.env.COTI_REUSE_CONTRACTS === undefined) {
      process.env.COTI_REUSE_CONTRACTS = "false";
    }
    const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey());
    lo("before: deploy stack + fund Charlie on COTI without onboarding");
    ctx = await setupPodTokenTestContext({ sepoliaViem, cotiViem });
    await syncPodBalancesRoundTrip(ctx, [ctx.owner], "seedOwnerZero");
    const funded = await setupFundedUnonboardedUser(cotiPk, CHARLIE_XOR);
    charlie = { address: funded.address, privateKey: funded.privateKey };
    lo(`before: ready (owner=${ctx.owner}, charlie=${charlie.address}, onboarded=false)`);
  });

  function allowanceOwnerCiphertext(allowance: unknown): unknown {
    const tuple = allowance as Record<string, unknown>;
    return tuple.ownerCiphertext ?? tuple[0];
  }

  function allowanceSpenderCiphertext(allowance: unknown): unknown {
    const tuple = allowance as Record<string, unknown>;
    return tuple.spenderCiphertext ?? tuple[1];
  }

  async function readOwnerAllowanceHalf(owner: `0x${string}`, spender: `0x${string}`): Promise<bigint> {
    const allowance = await ctx.pod.read.allowance([owner, spender]);
    return decryptUint256(allowanceOwnerCiphertext(allowance), ctx.base.crypto.userKey, decryptUint);
  }

  async function onboardCharlie(): Promise<string> {
    const cotiRpcUrl = isSimCotiBackend()
      ? "http://127.0.0.1:8545"
      : process.env.COTI_TESTNET_RPC_URL!;
    const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;
    const userKey = await onboardUser(charlie.privateKey, cotiRpcUrl, onboardAddress, CHARLIE_AES_ENV);
    if (isSimCotiBackend()) {
      await registerUserOnSim(cotiViem, charlie.address, userKey);
    }
    charlieUserKey = userKey;
    lo("onboarded Charlie on COTI");
    return userKey;
  }

  function readCharlieBalance(): Promise<bigint> {
    assert.ok(charlieUserKey, "Charlie must be onboarded before decrypt");
    return ctx.pod.read.balanceOf([charlie.address]).then((ct: unknown) =>
      decryptUint256(ct, charlieUserKey!, decryptUint)
    );
  }

  async function readCharlieAllowanceAsOwner(owner: `0x${string}`): Promise<bigint> {
    assert.ok(charlieUserKey, "Charlie must be onboarded before decrypt");
    const allowance = await ctx.pod.read.allowance([owner, charlie.address]);
    const ownerCt = (allowance as { spenderCiphertext?: unknown }).spenderCiphertext ?? (allowance as unknown[])[1];
    return decryptUint256(ownerCt, charlieUserKey!, decryptUint);
  }

  it("transfer to non-onboarded recipient succeeds; sync after onboard reveals balance", async function () {
    lo("case transfer: start");
    const fundAmt = 12_000n;
    const sendAmt = 4_500n;
    await syncPodBalancesRoundTrip(ctx, [ctx.owner], "xferOwnerBaseline");
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);
    assert.equal(ownerBefore, 0n);

    lo(`case transfer: fund owner ${fundAmt}`);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: fundAmt }], "lateXferFund");

    lo(`case transfer: send ${sendAmt} owner → Charlie (Charlie not onboarded)`);
    await completePodOpRoundTrip(ctx, "lateXfer", () =>
      ctx.podAsCoti.write.transfer(
        [charlie.address, sendAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + fundAmt - sendAmt);
    lo("case transfer: owner PoD balance reduced (sender was onboarded)");

    await onboardCharlie();
    await syncPodBalancesRoundTrip(ctx, [charlie.address], "lateXferSyncCharlie");

    assert.equal(await readCharlieBalance(), sendAmt);
    lo("case transfer: done (Charlie balance after onboard + sync)");
  });

  it("approve non-onboarded spender succeeds; re-approve after onboard reveals allowance", async function () {
    lo("case approve: start");
    const fundAmt = 9_000n;
    const allowanceAmt = 3_200n;
    const ownerBefore = await readDecryptedBalance(ctx, ctx.owner);

    lo(`case approve: fund owner ${fundAmt}`);
    await mintOnCotiAndSync(ctx, [{ address: ctx.owner, amount: fundAmt }], "lateApprFund");

    lo(`case approve: owner approves Charlie allowance=${allowanceAmt} (Charlie not onboarded)`);
    await completePodOpRoundTrip(ctx, "lateAppr", () =>
      ctx.podAsCoti.write.approve(
        [charlie.address, allowanceAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    assert.equal(await readOwnerAllowanceHalf(ctx.owner, charlie.address), allowanceAmt);
    lo("case approve: owner-side allowance ciphertext OK while spender not onboarded");

    await onboardCharlie();
    lo("case approve: re-approve after onboard to refresh spender-side ciphertext");
    await completePodOpRoundTrip(ctx, "lateApprRefresh", () =>
      ctx.podAsCoti.write.approve(
        [charlie.address, allowanceAmt, ctx.base.podTwoWayFees.callbackFeeWei],
        podTwoWayWriteOptions(ctx.base.podTwoWayFees)
      )
    );

    const allowance = await ctx.pod.read.allowance([ctx.owner, charlie.address]);
    const ownerPart = decryptUint256(allowanceOwnerCiphertext(allowance), ctx.base.crypto.userKey, decryptUint);
    const spenderPart = decryptUint256(
      allowanceSpenderCiphertext(allowance),
      charlieUserKey!,
      decryptUint
    );
    assert.equal(ownerPart, allowanceAmt);
    assert.equal(spenderPart, allowanceAmt);
    assert.equal(await readCharlieAllowanceAsOwner(ctx.owner), allowanceAmt);
    assert.equal(await readDecryptedBalance(ctx, ctx.owner), ownerBefore + fundAmt);
    lo("case approve: done");
  });
});
