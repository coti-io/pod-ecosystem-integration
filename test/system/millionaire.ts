import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { decryptUint } from "@coti-io/coti-sdk-typescript";
import { privateKeyToAccount } from "viem/accounts";
import { createWalletClient, custom, parseEther } from "viem";
import {
  buildEncryptedInput,
  envOrEmpty,
  fundContractForInboxFees,
  getRequests,
  getResponseRequestBySource,
  getTupleField,
  logStep,
  mineRequest,
  normalizePrivateKey,
  requirePrivateKey,
  resolveCotiTestnetPrivateKey,
  receiptWaitOptions,
  setupContext,
  type TestContext,
  getCotiCrypto,
  collectInboxFeesAfterTest,
  podTwoWayWriteOptions,
} from "./mpc-test-utils.js";
import { connectDualChainForTests } from "../sim-coti/sim-coti-utils.js";
import { derivePrivateKeyVariant } from "../tokens/test-token-utils.js";
import { podConfigureKeepInbox } from "../../scripts/deploy-utils.js";

describe("Millionaire (system)", { concurrency: 1 }, async function () {
  const { sepoliaViem, cotiViem } = await connectDualChainForTests();

  let ctx: TestContext;
  let walletA: any;
  let walletB: any;
  let accountA: ReturnType<typeof privateKeyToAccount>;
  let accountB: ReturnType<typeof privateKeyToAccount>;
  let userKeyB = "";

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  const decodeCtBool = (value: unknown): bigint => {
    return (
      getTupleField(value, "ciphertext", 0) ??
      getTupleField(value, "value", 0) ??
      (value as bigint)
    );
  };

  before(async function () {
    // Deploy fresh COTI contracts for clean nonces.
    process.env.COTI_REUSE_CONTRACTS = "false";
    ctx = await setupContext({ sepoliaViem, cotiViem });

    const cotiPkMain = await resolveCotiTestnetPrivateKey();
    accountA = privateKeyToAccount(normalizePrivateKey(cotiPkMain) as `0x${string}`);

    let cotiKeyB =
      envOrEmpty("COTI_TESTNET_PRIVATE_KEY_B") ||
      derivePrivateKeyVariant(normalizePrivateKey(cotiPkMain), 0x01);
    if (normalizePrivateKey(cotiKeyB).toLowerCase() === normalizePrivateKey(cotiPkMain).toLowerCase()) {
      const fallbacks = [
        process.env.PRIVATE_KEY?.trim(),
        process.env._PRIVATE_KEY?.trim(),
        process.env.COTI_TESTNET_PRIVATE_KEY?.trim(),
      ].filter((k): k is string => !!k);
      const next = fallbacks.find(
        (k) => normalizePrivateKey(k).toLowerCase() !== normalizePrivateKey(cotiPkMain).toLowerCase()
      );
      if (!next) {
        throw new Error("Millionaire test needs two distinct COTI/Hardhat private keys");
      }
      cotiKeyB = next;
      logStep(`Millionaire: using alternate key B (${privateKeyToAccount(normalizePrivateKey(cotiKeyB) as `0x${string}`).address})`);
    }
    accountB = privateKeyToAccount(normalizePrivateKey(cotiKeyB) as `0x${string}`);
    if (accountA.address.toLowerCase() === accountB.address.toLowerCase()) {
      throw new Error(
        "Millionaire test needs two distinct Hardhat/COTI accounts (set COTI_TESTNET_PRIVATE_KEY_B or fund _PRIVATE_KEY)"
      );
    }

    try {
      userKeyB = (
        await getCotiCrypto(cotiKeyB, process.env.COTI_TESTNET_RPC_URL || "", "USER_AES_KEY_2")
      ).userKey;
    } catch (err) {
      logStep(
        `Millionaire: user B onboard failed (${err instanceof Error ? err.message : String(err)}); using main userKey`
      );
      userKeyB = ctx.crypto.userKey;
    }

    const transport = custom({
      request: (args) => ctx.sepolia.publicClient.request(args),
    });
    const [funder] = await sepoliaViem.getWalletClients();
    const ensureFunds = async (address: `0x${string}`) => {
      const balance = await ctx.sepolia.publicClient.getBalance({ address });
      if (balance < parseEther("0.1")) {
        await funder.sendTransaction({ to: address, value: parseEther("1") });
      }
    };

    await ensureFunds(accountA.address);
    await ensureFunds(accountB.address);

    walletA = createWalletClient({
      account: accountA,
      chain: ctx.sepolia.publicClient.chain,
      transport,
    });
    walletB = createWalletClient({
      account: accountB,
      chain: ctx.sepolia.publicClient.chain,
      transport,
    });
  });

  const deployMillionaire = async () => {
    const deployed = await sepoliaViem.deployContract(
      "Millionaire",
      [ctx.contracts.inboxSepolia.address],
      { client: { public: ctx.sepolia.publicClient, wallet: walletA } }
    );
    await fundContractForInboxFees(walletA, ctx.sepolia.publicClient, deployed.address as `0x${string}`);
    const millionaire = await sepoliaViem.getContractAt("Millionaire", deployed.address, {
      client: { public: ctx.sepolia.publicClient, wallet: walletA },
    });
    const millionaireAsB = await sepoliaViem.getContractAt("Millionaire", deployed.address, {
      client: { public: ctx.sepolia.publicClient, wallet: walletB },
    });
    await millionaire.write.configure(
      podConfigureKeepInbox(ctx.contracts.mpcExecutor.address, ctx.chainIds.coti),
      { account: accountA }
    );
    return { millionaire, millionaireAsB };
  };

  const runCase = async (label: string, wealthA: bigint, wealthB: bigint, expectAGtB: boolean) => {
    const { millionaire, millionaireAsB } = await deployMillionaire();

    logStep(`${label}: encrypt inputs`);
    const itA = await buildEncryptedInput(ctx, wealthA);
    const itB = await buildEncryptedInput(ctx, wealthB);

    logStep(`${label}: register wealth A`);
    let txHash = await millionaire.write.registerMyWealth([itA], { account: accountA });
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });

    logStep(`${label}: register wealth B`);
    txHash = await millionaireAsB.write.registerMyWealth([itB], { account: accountB });
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });

    logStep(`${label}: check reveal not possible yet`);
    const [existsBeforeA] = await millionaire.read.revealMyWealthGtThan(
      [accountB.address],
      { account: accountA.address }
    );
    const [existsBeforeB] = await millionaireAsB.read.revealMyWealthGtThan([accountA.address], {
      account: accountB.address,
    });
    assert.equal(existsBeforeA, false);
    assert.equal(existsBeforeB, false);

    const countBefore = await ctx.contracts.inboxSepolia.read.getRequestsLen([BigInt(ctx.chainIds.coti)]);
    logStep(`${label}: sending reveal`);
    const revealValue = ctx.podTwoWayFees.totalValueWei * 2n;
    txHash = await millionaire.write.reveal(
      [accountA.address, accountB.address, ctx.podTwoWayFees.callbackFeeWei],
      { account: accountA, value: revealValue }
    );
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: txHash, ...receiptWaitOptions });
    const countAfter = await ctx.contracts.inboxSepolia.read.getRequestsLen([BigInt(ctx.chainIds.coti)]);
    assert.equal(Number(countAfter), Number(countBefore) + 2);

    const newRequests = await getRequests(ctx.contracts.inboxSepolia, ctx.chainIds.coti, Number(countBefore), 2);
    assert.equal(newRequests.length, 2);

    logStep(`${label}: mining 2 requests on COTI`);
    for (let i = 0; i < newRequests.length; i += 1) {
      const request = newRequests[i];
      const stepLabel = `${label}-req${i + 1}`;
      await mineRequest(ctx, "coti", BigInt(ctx.chainIds.sepolia), request, stepLabel);
      const responseRequest = await getResponseRequestBySource(ctx.contracts.inboxCoti, request.requestId, stepLabel);
      await mineRequest(ctx, "sepolia", ctx.chainIds.coti, responseRequest, stepLabel);
    }

    logStep(`${label}: verifying reveal result`);
    const [existsA, ctBoolA] = await millionaire.read.revealMyWealthGtThan(
      [accountB.address],
      { account: accountA.address }
    );
    const [existsB, ctBoolB] = await millionaireAsB.read.revealMyWealthGtThan(
      [accountA.address],
      { account: accountB.address }
    );
    assert.equal(existsA, true);
    assert.equal(existsB, true);
    const decryptedA = decryptUint(decodeCtBool(ctBoolA), ctx.crypto.userKey);
    const decryptedB = decryptUint(decodeCtBool(ctBoolB), userKeyB);
    logStep(
      `${label}: existsA=${existsA} existsB=${existsB} decryptedA=${decryptedA.toString()} decryptedB=${decryptedB.toString()}`
    );
    const isTrueA = decryptedA !== 0n;
    const isTrueB = decryptedB !== 0n;
    logStep(`${label}: isTrueA=${isTrueA} isTrueB=${isTrueB} expectAGtB=${expectAGtB}`);
    assert.equal(isTrueA, expectAGtB);
    assert.equal(isTrueB, !expectAGtB);
  };

  it("Should reveal A greater-than B for multiple cases", async function () {
    await runCase("Case1", 50n, 10n, true);
    await runCase("Case2", 10n, 50n, false);
  });
});
