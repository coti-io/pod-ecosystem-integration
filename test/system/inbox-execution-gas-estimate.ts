/**
 * Dual-chain (in-memory Hardhat + simCoti) e2e for:
 *   FeeConfig.gasPriceMul / gasPriceDiv skewing prepaid targetFee + callerFee
 *   Public always-revert estimateExecutionGasForMiner before mining
 *
 * Run: `npm run test:inbox-estimate-gas` (sets INBOX_ESTIMATE_GAS_SYSTEM_TESTS=1 and COTI_BACKEND=sim).
 * Step logs: grep `[mpc-test] inbox-estimate:`
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { encodeFunctionData, stringToHex } from "viem";
import { connectDualChainForTests } from "../sim-coti/sim-coti-utils.js";
import {
  applySystemInboxMinFeeConfigs,
  callEstimateExecutionGasForMiner,
  collectInboxFeesAfterTest,
  estimateGas,
  getLatestRequest,
  getRequests,
  getResponseRequestBySource,
  logStep,
  mineRequest,
  pegInboxOracleUsd1to1,
  podTwoWayWriteOptions,
  receiptWaitOptions,
  setupContext,
  toMinedRequest,
  type SystemInboxFeeConfig,
  type TestContext,
} from "./mpc-test-utils.js";

const runSuite = process.env.INBOX_ESTIMATE_GAS_SYSTEM_TESTS === "1";
const d = runSuite ? describe : describe.skip;

const step = (message: string) => logStep(`inbox-estimate: ${message}`);

/**
 * Flat constant-fee templates (same idea as inbox unit `InboxGasEstimateAndFeeSkew`).
 * Used with a 1/1 USD oracle peg so wei→gas stays human-scale under EDR gas caps.
 * Remote constant is high enough that prepaid `targetFee` can cover `respond()` + outbound create
 * inside the estimate stipend (estimateGas also adds a 300k exec term).
 */
const FLAT_FEE: SystemInboxFeeConfig = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
  maxMethodCallBytes: 8192n,
  maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
};

/** Remote leg floor for respond path — needs headroom beyond bare `estimateGas` 300k add-on. */
const REMOTE_FEE: SystemInboxFeeConfig = {
  ...FLAT_FEE,
  constantFee: 1_000_000n,
  maxExecutionGas: 5_000_000n,
};

/**
 * Must match `MPC_FEE_CALC_ASSUMED_GAS_PRICE_WEI` / `setGasPriceBounds` pin in mpc-test-utils
 * (min=max → `_referenceGasPrice` is this value).
 */
const PINNED_GAS_PRICE_WEI = 2_000_000_000n;

/** Fixed two-way payment so expected gas units are exact under 1/1 oracle + pinned gas price.
 * Remote base = 2e6 gas → mul=2 still ≤ maxExecutionGas 5e6; after div=2 still ≥ remote constant 1e6.
 */
const SKEW_TOTAL_WEI = 8_000_000_000_000_000n; // 0.008 ETH
const SKEW_CALLBACK_WEI = 4_000_000_000_000_000n; // 0.004 ETH → remote slice 0.004 ETH

/**
 * Mirror `validateAndPrepareTwoWayFees` with 1/1 oracle (OpenZeppelin `mulDiv` truncates).
 * `local` skew → `callerFee`; `remote` skew → `targetFee`.
 */
function expectedTwoWayGasUnits(params: {
  totalWei: bigint;
  callbackWei: bigint;
  gasPrice: bigint;
  localMul: bigint;
  localDiv: bigint;
  remoteMul: bigint;
  remoteDiv: bigint;
}): { targetFee: bigint; callerFee: bigint } {
  const { totalWei, callbackWei, gasPrice, localMul, localDiv, remoteMul, remoteDiv } = params;
  const callerBase = callbackWei / gasPrice;
  const remoteBase = (totalWei - callbackWei) / gasPrice;
  return {
    callerFee: (callerBase * localMul) / localDiv,
    targetFee: (remoteBase * remoteMul) / remoteDiv,
  };
}

const emptyMethodCall = {
  selector: "0x00000000" as const,
  data: "0x" as const,
  datatypes: [] as const,
  datalens: [] as const,
};

const encodeEstimateEntryCall = () =>
  encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "entry",
        inputs: [{ name: "data", type: "bytes" }],
        outputs: [],
        stateMutability: "nonpayable",
      },
    ],
    functionName: "entry",
    args: ["0x"],
  });

async function configureEstimateFees(params: {
  label: string;
  ctx: TestContext;
  sepoliaViem: any;
  cotiViem: any;
  local?: Partial<SystemInboxFeeConfig>;
  remote?: Partial<SystemInboxFeeConfig>;
}) {
  const { label, ctx, sepoliaViem, cotiViem, local, remote } = params;
  await pegInboxOracleUsd1to1({
    label: `${label} hardhat`,
    viem: sepoliaViem,
    inbox: ctx.contracts.inboxSepolia,
    publicClient: ctx.sepolia.publicClient,
    walletClient: ctx.sepolia.wallet,
  });
  await pegInboxOracleUsd1to1({
    label: `${label} coti`,
    viem: cotiViem,
    inbox: ctx.contracts.inboxCoti,
    publicClient: ctx.coti.publicClient,
    walletClient: ctx.coti.wallet,
  });
  await applySystemInboxMinFeeConfigs({
    label: `${label} hardhat`,
    inbox: ctx.contracts.inboxSepolia,
    publicClient: ctx.sepolia.publicClient,
    walletClient: ctx.sepolia.wallet,
    local: { ...FLAT_FEE, ...local },
    remote: { ...REMOTE_FEE, ...remote },
  });
  // Destination must admit respond()/raise return-leg creates during estimate + mine.
  await applySystemInboxMinFeeConfigs({
    label: `${label} coti`,
    inbox: ctx.contracts.inboxCoti,
    publicClient: ctx.coti.publicClient,
    walletClient: ctx.coti.wallet,
    local: { ...FLAT_FEE },
    remote: { ...REMOTE_FEE },
  });
  // Keep reference gas pinned after fee retunes (same as ensureMpcInboxOracleAndFees).
  const deployer = ctx.sepolia.wallet.account.address as `0x${string}`;
  const boundsHash = await ctx.contracts.inboxSepolia.write.setGasPriceBounds(
    [0n, PINNED_GAS_PRICE_WEI, PINNED_GAS_PRICE_WEI],
    { account: deployer }
  );
  await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: boundsHash, ...receiptWaitOptions });
  ctx.podTwoWayFees = await estimateGas(ctx.contracts.inboxSepolia);
}

/** Mine any Hardhat→COTI outbounds not yet ingested (keeps nonce contiguity for later tests). */
async function minePendingHardhatToCoti(ctx: TestContext, label: string) {
  const cotiChainId = BigInt(ctx.chainIds.coti);
  const sourceChainId = BigInt(ctx.chainIds.sepolia);
  const count = Number(await ctx.contracts.inboxSepolia.read.getRequestsLen([cotiChainId]));
  if (count === 0) return;
  const pending = await getRequests(ctx.contracts.inboxSepolia, cotiChainId, 0, count);
  for (const req of pending) {
    const stored = await ctx.contracts.inboxCoti.read.incomingRequests([req.requestId]);
    const storedId = ((stored as any).requestId ?? (stored as any)[0]) as string;
    if (
      storedId &&
      storedId !== "0x0000000000000000000000000000000000000000000000000000000000000000"
    ) {
      continue;
    }
    step(`${label}: mining pending outbound ${req.requestId}`);
    await mineRequest(ctx, "coti", sourceChainId, req, `${label} drain`, { gas: 16_000_000n });
  }
}

if (!runSuite) {
  logStep(
    'inbox-estimate: suite skipped — INBOX_ESTIMATE_GAS_SYSTEM_TESTS is not "1". Use: npm run test:inbox-estimate-gas'
  );
}

d("Inbox execution gas estimate + gasPrice fee skew (system)", { concurrency: 1 }, async function () {
  const { sepoliaViem, cotiViem } = await connectDualChainForTests();

  let ctx: TestContext;
  let estTarget: any;
  let nonMiner: `0x${string}`;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  before(async function () {
    step("fresh dual-chain setup (Hardhat ↔ simCoti)");
    process.env.COTI_REUSE_CONTRACTS = "false";
    ctx = await setupContext({ sepoliaViem, cotiViem });

    step("deploy EstimateGasTarget on COTI (destination execution target)");
    estTarget = await cotiViem.deployContract(
      "EstimateGasTarget",
      [ctx.contracts.inboxCoti.address],
      { client: { public: ctx.coti.publicClient, wallet: ctx.coti.wallet } } as any
    );

    const wallets = await sepoliaViem.getWalletClients();
    nonMiner = wallets[1].account.address as `0x${string}`;
    step(`EstimateGasTarget=${estTarget.address} nonMiner=${nonMiner}`);
  });

  it("gasPriceMul/Div skew: exact targetFee + callerFee for target-higher and source-higher", async function () {
    const deployer = ctx.sepolia.wallet.account.address as `0x${string}`;
    const cases: Array<{
      name: string;
      localMul: bigint;
      localDiv: bigint;
      remoteMul: bigint;
      remoteDiv: bigint;
    }> = [
      {
        name: "baseline 1/1 both legs",
        localMul: 1n,
        localDiv: 1n,
        remoteMul: 1n,
        remoteDiv: 1n,
      },
      {
        name: "target gasPrice higher (remote mul=2)",
        localMul: 1n,
        localDiv: 1n,
        remoteMul: 2n,
        remoteDiv: 1n,
      },
      {
        name: "target gasPrice lower / source higher (remote div=2)",
        localMul: 1n,
        localDiv: 1n,
        remoteMul: 1n,
        remoteDiv: 2n,
      },
      {
        name: "callback/source gasPrice higher (local mul=2)",
        localMul: 2n,
        localDiv: 1n,
        remoteMul: 1n,
        remoteDiv: 1n,
      },
      {
        name: "callback/source gasPrice lower (local div=2)",
        localMul: 1n,
        localDiv: 2n,
        remoteMul: 1n,
        remoteDiv: 1n,
      },
      {
        name: "both legs skewed (remote 3/2, local 2/3)",
        localMul: 2n,
        localDiv: 3n,
        remoteMul: 3n,
        remoteDiv: 2n,
      },
    ];

    for (const c of cases) {
      step(`configure ${c.name}`);
      await configureEstimateFees({
        label: `skew ${c.name}`,
        ctx,
        sepoliaViem,
        cotiViem,
        local: { gasPriceMul: c.localMul, gasPriceDiv: c.localDiv },
        remote: { gasPriceMul: c.remoteMul, gasPriceDiv: c.remoteDiv },
      });

      const expected = expectedTwoWayGasUnits({
        totalWei: SKEW_TOTAL_WEI,
        callbackWei: SKEW_CALLBACK_WEI,
        gasPrice: PINNED_GAS_PRICE_WEI,
        localMul: c.localMul,
        localDiv: c.localDiv,
        remoteMul: c.remoteMul,
        remoteDiv: c.remoteDiv,
      });
      step(
        `${c.name}: expect targetFee=${expected.targetFee} callerFee=${expected.callerFee} ` +
          `(remote ${c.remoteMul}/${c.remoteDiv}, local ${c.localMul}/${c.localDiv})`
      );
      assert.ok(expected.targetFee >= REMOTE_FEE.constantFee, "fixture must clear remote min after skew");
      assert.ok(expected.callerFee >= FLAT_FEE.constantFee, "fixture must clear local min after skew");

      const hash = await ctx.contracts.inboxSepolia.write.sendTwoWayMessage(
        [
          BigInt(ctx.chainIds.coti),
          deployer,
          emptyMethodCall,
          "0x12345678",
          "0x87654321",
          SKEW_CALLBACK_WEI,
        ],
        { account: deployer, value: SKEW_TOTAL_WEI, gas: 8_000_000n }
      );
      await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
      const req = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
      step(`${c.name}: stored targetFee=${req.targetFee} callerFee=${req.callerFee}`);
      assert.equal(req.targetFee, expected.targetFee, `${c.name}: targetFee (remote skew)`);
      assert.equal(req.callerFee, expected.callerFee, `${c.name}: callerFee (local/callback skew)`);
    }
  });

  it("gasPriceMul=0 is rejected (FeeConfigInvalid)", async function () {
    step("attempt updateMinFeeConfigs with gasPriceMul=0");
    await assert.rejects(
      () =>
        applySystemInboxMinFeeConfigs({
          label: "fee-skew mul=0",
          inbox: ctx.contracts.inboxSepolia,
          publicClient: ctx.sepolia.publicClient,
          walletClient: ctx.sepolia.wallet,
          local: { ...FLAT_FEE },
          remote: { ...REMOTE_FEE, gasPriceMul: 0n },
        }),
      /FeeConfigInvalid/
    );
  });

  it("estimate before mine reports gasUsed and respond size; state rolls back", async function () {
    step("drain any unmined fee-skew outbounds so COTI nonces stay contiguous");
    await minePendingHardhatToCoti(ctx, "pre-respond");

    step("reset flat fees (mul=1) and refresh wei quote");
    await configureEstimateFees({ label: "estimate fees", ctx, sepoliaViem, cotiViem });

    const respondPayload = stringToHex("estimate-e2e-respond-payload");
    step(`configure EstimateGasTarget to respond with ${respondPayload}`);
    await estTarget.write.configure([0n, true, false, respondPayload], {
      account: ctx.coti.wallet.account.address,
    });

    const deployer = ctx.sepolia.wallet.account.address as `0x${string}`;
    const methodCall = {
      selector: "0x00000000" as const,
      data: encodeEstimateEntryCall(),
      datatypes: [] as const,
      datalens: [] as const,
    };

    step("Hardhat: sendTwoWay → EstimateGasTarget.entry (will respond on COTI)");
    const sendHash = await ctx.contracts.inboxSepolia.write.sendTwoWayMessage(
      [
        BigInt(ctx.chainIds.coti),
        estTarget.address,
        methodCall,
        "0x12345678",
        "0x87654321",
        ctx.podTwoWayFees.callbackFeeWei,
      ],
      { ...podTwoWayWriteOptions(ctx.podTwoWayFees), account: deployer }
    );
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: sendHash, ...receiptWaitOptions });

    const outbound = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);
    const mined = toMinedRequest(outbound);
    step(`outbound requestId=${outbound.requestId} prepaid targetFee=${outbound.targetFee}`);

    step("COTI eth_call: estimateExecutionGasForMiner (always reverts with sizes)");
    const estimate = await callEstimateExecutionGasForMiner({
      inbox: ctx.contracts.inboxCoti,
      publicClient: ctx.coti.publicClient,
      sourceChainId: BigInt(ctx.chainIds.sepolia),
      mined,
      maxUserGas: 1_000_000n,
      account: deployer,
    });
    step(
      `estimate gasUsed=${estimate.gasUsed} responseDataSize=${estimate.responseDataSize} ` +
        `errorDataSize=${estimate.errorDataSize}`
    );
    assert.ok(estimate.gasUsed > 0n, "user subcall should consume gas");
    assert.ok(estimate.responseDataSize > 0n, "respond() → responseDataSize > 0");
    assert.equal(estimate.errorDataSize, 0n, "no raise/system-error on success path");

    step("confirm estimate left no persisted incoming request");
    const stored = await ctx.contracts.inboxCoti.read.incomingRequests([outbound.requestId]);
    const storedId = (stored as any).requestId ?? (stored as any)[0];
    assert.equal(
      storedId,
      "0x0000000000000000000000000000000000000000000000000000000000000000"
    );

    step("mine for real on COTI using prepaid targetFee (estimate was advisory only)");
    const { requestIdUsed } = await mineRequest(
      ctx,
      "coti",
      BigInt(ctx.chainIds.sepolia),
      outbound,
      "estimate→mine",
      { gas: 16_000_000n }
    );

    step("load return leg created by respond()");
    const returnLeg = await getResponseRequestBySource(
      ctx.contracts.inboxCoti,
      requestIdUsed,
      "estimate return leg"
    );
    assert.equal(returnLeg.isTwoWay, false);
    assert.ok((returnLeg.methodCall.data as string).length > 2);
  });

  it("non-miner account can eth_call the estimate API", async function () {
    step("configure EstimateGasTarget for a quiet execute (no respond/raise)");
    await estTarget.write.configure([0n, false, false, "0x"], {
      account: ctx.coti.wallet.account.address,
    });

    await configureEstimateFees({ label: "public estimate fees", ctx, sepoliaViem, cotiViem });

    const deployer = ctx.sepolia.wallet.account.address as `0x${string}`;
    const methodCall = {
      selector: "0x00000000" as const,
      data: encodeEstimateEntryCall(),
      datatypes: [] as const,
      datalens: [] as const,
    };

    step("Hardhat: enqueue one more two-way toward EstimateGasTarget");
    const sendHash = await ctx.contracts.inboxSepolia.write.sendTwoWayMessage(
      [
        BigInt(ctx.chainIds.coti),
        estTarget.address,
        methodCall,
        "0x12345678",
        "0x87654321",
        ctx.podTwoWayFees.callbackFeeWei,
      ],
      { ...podTwoWayWriteOptions(ctx.podTwoWayFees), account: deployer }
    );
    await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash: sendHash, ...receiptWaitOptions });
    const outbound = await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti);

    step(`eth_call estimate as non-miner ${nonMiner}`);
    const estimate = await callEstimateExecutionGasForMiner({
      inbox: ctx.contracts.inboxCoti,
      publicClient: ctx.coti.publicClient,
      sourceChainId: BigInt(ctx.chainIds.sepolia),
      mined: toMinedRequest(outbound),
      maxUserGas: 500_000n,
      account: nonMiner,
    });
    assert.ok(estimate.gasUsed > 0n);
    assert.equal(estimate.responseDataSize, 0n);
    assert.equal(estimate.errorDataSize, 0n);
  });
});
