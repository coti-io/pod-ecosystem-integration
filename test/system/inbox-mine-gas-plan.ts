/**
 * Hardhat/simCoti e2e for inbox mine gas planning (estimateExecutionGasForMiner + buffer +
 * eth_estimateGas max). Exercises adversarial targets that try to fool eth_estimateGas.
 *
 * Run: `npm run test:inbox-mine-gas`
 */
import assert from "node:assert/strict";
import { afterEach, before, describe, it } from "node:test";
import { encodeFunctionData, stringToHex, type Hex } from "viem";
import {
  DEFAULT_MINE_GAS_CONFIG,
  gasLimitHeadroomBps,
  planMineBatch,
  type MineGasConfig,
} from "../../scripts/inbox-mine-gas.js";
import { connectDualChainForTests } from "../sim-coti/sim-coti-utils.js";
import {
  applySystemInboxMinFeeConfigs,
  callEstimateExecutionGasForMiner,
  collectInboxFeesAfterTest,
  estimateGas,
  getLatestRequest,
  getRequests,
  logStep,
  mineRequest,
  pegInboxOracleUsd1to1,
  podTwoWayWriteOptions,
  receiptWaitOptions,
  setupContext,
  toMinedRequest,
  type MinedRequest,
  type SystemInboxFeeConfig,
  type TestContext,
} from "./mpc-test-utils.js";

const runSuite = process.env.INBOX_MINE_GAS_SYSTEM_TESTS === "1";
const d = runSuite ? describe : describe.skip;

const step = (message: string) => logStep(`inbox-mine-gas: ${message}`);

/** Max acceptable over-estimate vs actual receipt gas (basis points). */
// Projection includes POST_CALL_GAS_RESERVE (200k); respond/raise paths often leave ~25–30% unused.
const MAX_HEADROOM_BPS_PROJECTION = 3_500n; // when estimateExecutionGas floor wins (e.g. griefing)
const MAX_HEADROOM_BPS_ETH_ESTIMATE = 5_000n; // Hardhat eth_estimateGas often pads ~15–50%

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

const REMOTE_FEE: SystemInboxFeeConfig = {
  ...FLAT_FEE,
  constantFee: 2_000_000n,
  maxExecutionGas: 8_000_000n,
};

const Mode = {
  FixedBurn: 0n,
  FixedBurnRespond: 1n,
  FixedBurnRaise: 2n,
  EstimateGasGrief: 3n,
  RevertAfterBurn: 4n,
  EmptySuccess: 5n,
} as const;

const encodeEntryCall = () =>
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

async function configureFees(params: {
  label: string;
  ctx: TestContext;
  sepoliaViem: any;
  cotiViem: any;
}) {
  const { label, ctx, sepoliaViem, cotiViem } = params;
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
    local: { ...FLAT_FEE },
    remote: { ...REMOTE_FEE },
  });
  await applySystemInboxMinFeeConfigs({
    label: `${label} coti`,
    inbox: ctx.contracts.inboxCoti,
    publicClient: ctx.coti.publicClient,
    walletClient: ctx.coti.wallet,
    local: { ...FLAT_FEE },
    remote: { ...REMOTE_FEE },
  });
  ctx.podTwoWayFees = await estimateGas(ctx.contracts.inboxSepolia);
}

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
    step(`${label}: drain ${req.requestId}`);
    await mineRequest(ctx, "coti", sourceChainId, req, `${label} drain`, { gas: 16_000_000n });
  }
}

async function sendAdversarialOutbound(params: {
  ctx: TestContext;
  target: `0x${string}`;
  isTwoWay: boolean;
}): Promise<MinedRequest> {
  const { ctx, target, isTwoWay } = params;
  const deployer = ctx.sepolia.wallet.account.address as `0x${string}`;
  const methodCall = {
    selector: "0x00000000" as const,
    data: encodeEntryCall(),
    datatypes: [] as const,
    datalens: [] as const,
  };
  const fees = podTwoWayWriteOptions(ctx.podTwoWayFees);
  const hash = isTwoWay
    ? await ctx.contracts.inboxSepolia.write.sendTwoWayMessage(
        [
          BigInt(ctx.chainIds.coti),
          target,
          methodCall,
          "0x12345678",
          "0x87654321",
          ctx.podTwoWayFees.callbackFeeWei,
        ],
        { ...fees, account: deployer }
      )
    : await ctx.contracts.inboxSepolia.write.sendOneWayMessage(
        [BigInt(ctx.chainIds.coti), target, methodCall, "0x00000000"],
        { ...fees, account: deployer }
      );
  await ctx.sepolia.publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
  return toMinedRequest(await getLatestRequest(ctx.contracts.inboxSepolia, ctx.chainIds.coti));
}

async function planAndMine(params: {
  ctx: TestContext;
  mined: MinedRequest[];
  config?: Partial<MineGasConfig>;
  label: string;
}): Promise<{ gasLimit: bigint; actualGas: bigint; headroomBps: bigint; projected: bigint; ethEst: bigint }> {
  const { ctx, mined, config, label } = params;
  const inbox = ctx.contracts.inboxCoti;
  const publicClient = ctx.coti.publicClient;
  const account = ctx.coti.wallet.account.address as `0x${string}`;
  const sourceChainId = BigInt(ctx.chainIds.sepolia);

  const plan = await planMineBatch({
    requests: mined,
    config: { ...DEFAULT_MINE_GAS_CONFIG, maxBatchGas: 15_000_000n, maxUserGas: 5_000_000n, ...config },
    estimateRequest: async (req, maxUserGas) =>
      callEstimateExecutionGasForMiner({
        inbox,
        publicClient,
        sourceChainId,
        mined: req,
        maxUserGas,
        account,
      }),
    estimateTxGas: async (selected) => {
      const data = encodeFunctionData({
        abi: inbox.abi,
        functionName: "batchProcessRequests",
        args: [sourceChainId, selected],
      });
      return publicClient.estimateGas({
        account,
        to: inbox.address,
        data,
      });
    },
  });

  assert.equal(plan.selected.length, mined.length, `${label}: expected full batch pack`);
  step(
    `${label}: projected=${plan.projectedBatchGas} ethEst=${plan.ethEstimateGas} gasLimit=${plan.gasLimit}`
  );

  const txHash = (await inbox.write.batchProcessRequests([sourceChainId, plan.selected], {
    account,
    gas: plan.gasLimit,
  })) as Hex;
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    ...receiptWaitOptions,
  });
  assert.equal(receipt.status, "success", `${label}: mine tx must succeed`);
  const actualGas = receipt.gasUsed as bigint;
  const headroomBps = gasLimitHeadroomBps(plan.gasLimit, actualGas);
  step(`${label}: actualGas=${actualGas} headroomBps=${headroomBps}`);
  assert.ok(plan.gasLimit >= actualGas, `${label}: gasLimit under-estimated actual`);
  const ethDominates = plan.ethEstimateGas >= plan.projectedBatchGas;
  const maxHeadroom = ethDominates ? MAX_HEADROOM_BPS_ETH_ESTIMATE : MAX_HEADROOM_BPS_PROJECTION;
  assert.ok(
    headroomBps <= maxHeadroom,
    `${label}: headroom ${headroomBps} bps exceeds ${maxHeadroom} (ethDominates=${ethDominates})`
  );
  return {
    gasLimit: plan.gasLimit,
    actualGas,
    headroomBps,
    projected: plan.projectedBatchGas,
    ethEst: plan.ethEstimateGas,
  };
}

if (!runSuite) {
  logStep('inbox-mine-gas: skipped — set INBOX_MINE_GAS_SYSTEM_TESTS=1 (npm run test:inbox-mine-gas)');
}

d("Inbox mine gas planning against adversarial targets", { concurrency: 1 }, async function () {
  const { sepoliaViem, cotiViem } = await connectDualChainForTests();
  let ctx: TestContext;
  let target: any;

  afterEach(async function () {
    if (ctx) await collectInboxFeesAfterTest(ctx);
  });

  before(async function () {
    process.env.COTI_REUSE_CONTRACTS = "false";
    ctx = await setupContext({ sepoliaViem, cotiViem });
    target = await cotiViem.deployContract(
      "AdversarialGasTarget",
      [ctx.contracts.inboxCoti.address],
      { client: { public: ctx.coti.publicClient, wallet: ctx.coti.wallet } } as any
    );
    await configureFees({ label: "setup", ctx, sepoliaViem, cotiViem });
    step(`AdversarialGasTarget=${target.address}`);
  });

  it("empty success is tight", async function () {
    await minePendingHardhatToCoti(ctx, "pre-empty");
    await target.write.configure([Mode.EmptySuccess, 0n, 0n, "0x"], {
      account: ctx.coti.wallet.account.address,
    });
    const mined = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: false,
    });
    await planAndMine({ ctx, mined: [mined], label: "empty" });
  });

  it("fixed burn (~200k) succeeds within headroom", async function () {
    await minePendingHardhatToCoti(ctx, "pre-burn");
    await target.write.configure([Mode.FixedBurn, 200_000n, 0n, "0x"], {
      account: ctx.coti.wallet.account.address,
    });
    const mined = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: false,
    });
    await planAndMine({ ctx, mined: [mined], label: "fixed-burn" });
  });

  it("fixed burn + respond uses reply overhead", async function () {
    await minePendingHardhatToCoti(ctx, "pre-respond");
    const payload = stringToHex("mine-gas-respond-payload-xxxxxxxx");
    await target.write.configure([Mode.FixedBurnRespond, 150_000n, 0n, payload], {
      account: ctx.coti.wallet.account.address,
    });
    const mined = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: true,
    });
    const result = await planAndMine({ ctx, mined: [mined], label: "respond" });
    assert.ok(result.projected > 0n);
  });

  it("fixed burn + raise uses error size path", async function () {
    await minePendingHardhatToCoti(ctx, "pre-raise");
    const payload = stringToHex("mine-gas-raise-payload");
    await target.write.configure([Mode.FixedBurnRaise, 120_000n, 0n, payload], {
      account: ctx.coti.wallet.account.address,
    });
    const mined = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: true,
    });
    await planAndMine({ ctx, mined: [mined], label: "raise" });
  });

  it("eth_estimateGas griefing: projection must cover expensive path", async function () {
    await minePendingHardhatToCoti(ctx, "pre-grief");
    // Cheap under ~1.2M gasleft (estimateGas binary search), burns 1.5M when stipend is large.
    await target.write.configure([Mode.EstimateGasGrief, 1_500_000n, 1_200_000n, "0x"], {
      account: ctx.coti.wallet.account.address,
    });
    const mined = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: false,
    });
    // Prepaid targetFee must admit the expensive burn.
    assert.ok(mined.targetFee >= 1_500_000n, "need prepaid stipend ≥ grief burn");
    const result = await planAndMine({
      ctx,
      mined: [mined],
      label: "grief",
      config: { userGasBufferBps: 1_000n }, // 10% — griefing needs cushion on measured burn
    });
    // Projection should dominate naive eth_estimateGas when griefing works.
    step(`grief: projected=${result.projected} ethEst=${result.ethEst}`);
    assert.ok(
      result.gasLimit >= result.actualGas,
      "grief mine must not OOG"
    );
  });

  it("revert-after-burn still mines successfully (error recorded)", async function () {
    await minePendingHardhatToCoti(ctx, "pre-revert");
    await target.write.configure([Mode.RevertAfterBurn, 100_000n, 0n, "0x"], {
      account: ctx.coti.wallet.account.address,
    });
    const mined = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: false,
    });
    await planAndMine({ ctx, mined: [mined], label: "revert-burn" });
  });

  it("batches two fixed burns under maxBatchGas", async function () {
    await minePendingHardhatToCoti(ctx, "pre-batch");
    await target.write.configure([Mode.FixedBurn, 80_000n, 0n, "0x"], {
      account: ctx.coti.wallet.account.address,
    });
    const a = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: false,
    });
    const b = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: false,
    });
    await planAndMine({
      ctx,
      mined: [a, b],
      label: "batch-2",
      config: { maxBatchGas: 15_000_000n },
    });
  });

  it("maxBatchGas splits: second request left for next mine", async function () {
    await minePendingHardhatToCoti(ctx, "pre-split");
    await target.write.configure([Mode.FixedBurn, 200_000n, 0n, "0x"], {
      account: ctx.coti.wallet.account.address,
    });
    const a = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: false,
    });
    const b = await sendAdversarialOutbound({
      ctx,
      target: target.address,
      isTwoWay: false,
    });

    const inbox = ctx.contracts.inboxCoti;
    const publicClient = ctx.coti.publicClient;
    const account = ctx.coti.wallet.account.address as `0x${string}`;
    const sourceChainId = BigInt(ctx.chainIds.sepolia);

    // Tiny cap forces single-request batches.
    const plan = await planMineBatch({
      requests: [a, b],
      config: {
        ...DEFAULT_MINE_GAS_CONFIG,
        maxBatchGas: 400_000n,
        maxUserGas: 5_000_000n,
        userGasBufferBps: 0n,
      },
      estimateRequest: async (req, maxUserGas) =>
        callEstimateExecutionGasForMiner({
          inbox,
          publicClient,
          sourceChainId,
          mined: req,
          maxUserGas,
          account,
        }),
      estimateTxGas: async () => 0n,
    });
    assert.equal(plan.selected.length, 1, "cap should pack only first request");

    await planAndMine({ ctx, mined: plan.selected, label: "split-first" });
    await planAndMine({ ctx, mined: [b], label: "split-second" });
  });
});
