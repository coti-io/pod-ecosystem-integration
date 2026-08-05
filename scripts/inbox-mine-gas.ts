/**
 * Inbox mine gas planning — single source of truth for CMS (Python port) and PEI tests.
 *
 * Algorithm:
 * 1. Per request: `estimateExecutionGasForMiner` → user `gasUsed` (+ reply sizes).
 * 2. Apply configurable buffer to user gas.
 * 3. Project per-request mine cost (buffered user gas + reply overhead + post-call reserve).
 * 4. Greedy-pack requests while projected sum ≤ `maxBatchGas`.
 * 5. `eth_estimateGas` the full `batchProcessRequests` tx.
 * 6. `gasLimit = max(projectedBatchGas, eth_estimateGas)` — covers estimateGas griefing
 *    without large fixed headrooms when both agree.
 *
 * Do not re-apply FeeConfig.gasPriceMul/Div: prepaid `targetFee` already includes skew.
 */

export const POST_CALL_GAS_RESERVE = 100_000n;
/** Matches InboxMiner.ESTIMATE_OUTER_RESERVE (estimator stipend cushion only). */
export const ESTIMATE_OUTER_RESERVE = 150_000n;

/** Default: 5% buffer on measured user gas. */
export const DEFAULT_USER_GAS_BUFFER_BPS = 500n;
/** Fixed inbox work outside the user subcall (store request, encode, accounting). Calibrated in e2e. */
export const DEFAULT_PER_REQUEST_OVERHEAD = 40_000n;
/** Outer tx / batch loop baseline beyond per-request costs. Calibrated in e2e. */
export const DEFAULT_BATCH_BASE_OVERHEAD = 30_000n;
/** Base cost to create a respond/raise outbound when size > 0. */
export const DEFAULT_REPLY_BASE_GAS = 70_000n;
/** Extra gas per reply payload byte (covers calldata + memory + fee accounting). */
export const DEFAULT_REPLY_GAS_PER_BYTE = 12n;

export type ExecutionGasEstimate = {
  gasUsed: bigint;
  responseDataSize: bigint;
  errorDataSize: bigint;
};

export type MineGasConfig = {
  /** Basis points added to measured user gas (500 = +5%). */
  userGasBufferBps: bigint;
  /** Absolute gas added after BPS buffer. */
  userGasBufferAbsolute: bigint;
  /** Cap for packing a mine batch (projected costs). */
  maxBatchGas: bigint;
  /** Stipend passed to estimateExecutionGasForMiner. */
  maxUserGas: bigint;
  perRequestOverhead: bigint;
  batchBaseOverhead: bigint;
  replyBaseGas: bigint;
  replyGasPerByte: bigint;
  postCallGasReserve: bigint;
};

export const DEFAULT_MINE_GAS_CONFIG: MineGasConfig = {
  userGasBufferBps: DEFAULT_USER_GAS_BUFFER_BPS,
  userGasBufferAbsolute: 0n,
  maxBatchGas: 12_000_000n,
  maxUserGas: 8_000_000n,
  perRequestOverhead: DEFAULT_PER_REQUEST_OVERHEAD,
  batchBaseOverhead: DEFAULT_BATCH_BASE_OVERHEAD,
  replyBaseGas: DEFAULT_REPLY_BASE_GAS,
  replyGasPerByte: DEFAULT_REPLY_GAS_PER_BYTE,
  postCallGasReserve: POST_CALL_GAS_RESERVE,
};

export type RequestGasProjection = {
  estimate: ExecutionGasEstimate;
  bufferedUserGas: bigint;
  replyOverhead: bigint;
  projectedGas: bigint;
};

export type MineBatchPlan<T> = {
  /** Contiguous prefix of input requests selected for this mine tx. */
  selected: T[];
  projections: RequestGasProjection[];
  /** Sum of per-request projected gas + batch base. */
  projectedBatchGas: bigint;
  /** Result of eth_estimateGas on the encoded batch (0n if skipped). */
  ethEstimateGas: bigint;
  /** max(projectedBatchGas, ethEstimateGas). */
  gasLimit: bigint;
};

/** Apply BPS + absolute buffer to measured user subcall gas. */
export function applyUserGasBuffer(
  gasUsed: bigint,
  config: Pick<MineGasConfig, "userGasBufferBps" | "userGasBufferAbsolute">
): bigint {
  const bps = config.userGasBufferBps;
  const withBps = bps === 0n ? gasUsed : (gasUsed * (10_000n + bps) + 9_999n) / 10_000n;
  return withBps + config.userGasBufferAbsolute;
}

/** Overhead for outbound respond/raise attributed by the estimator. */
export function estimateReplyOverhead(
  estimate: Pick<ExecutionGasEstimate, "responseDataSize" | "errorDataSize">,
  config: Pick<MineGasConfig, "replyBaseGas" | "replyGasPerByte">
): bigint {
  const size = estimate.responseDataSize > estimate.errorDataSize
    ? estimate.responseDataSize
    : estimate.errorDataSize;
  if (size === 0n) return 0n;
  return config.replyBaseGas + size * config.replyGasPerByte;
}

/** Project outer mine cost for one request from an ExecutionGasEstimate. */
export function projectRequestMineGas(
  estimate: ExecutionGasEstimate,
  config: MineGasConfig
): RequestGasProjection {
  const bufferedUserGas = applyUserGasBuffer(estimate.gasUsed, config);
  const replyOverhead = estimateReplyOverhead(estimate, config);
  const projectedGas =
    bufferedUserGas + replyOverhead + config.perRequestOverhead + config.postCallGasReserve;
  return { estimate, bufferedUserGas, replyOverhead, projectedGas };
}

export function projectBatchGas(
  projections: RequestGasProjection[],
  config: Pick<MineGasConfig, "batchBaseOverhead">
): bigint {
  let sum = config.batchBaseOverhead;
  for (const p of projections) sum += p.projectedGas;
  return sum;
}

/**
 * Greedy pack requests in order while projected batch gas ≤ maxBatchGas.
 * Always includes at least the first request (even if alone it exceeds the cap).
 */
export function selectBatchByProjectedGas<T>(
  items: T[],
  projections: RequestGasProjection[],
  config: Pick<MineGasConfig, "maxBatchGas" | "batchBaseOverhead">
): { selected: T[]; selectedProjections: RequestGasProjection[]; projectedBatchGas: bigint } {
  if (items.length !== projections.length) {
    throw new Error("selectBatchByProjectedGas: items/projections length mismatch");
  }
  if (items.length === 0) {
    return { selected: [], selectedProjections: [], projectedBatchGas: 0n };
  }

  const selected: T[] = [];
  const selectedProjections: RequestGasProjection[] = [];
  let projected = config.batchBaseOverhead;

  for (let i = 0; i < items.length; i++) {
    const next = projected + projections[i].projectedGas;
    if (selected.length > 0 && next > config.maxBatchGas) break;
    selected.push(items[i]);
    selectedProjections.push(projections[i]);
    projected = next;
  }

  return { selected, selectedProjections, projectedBatchGas: projected };
}

/** Final gas limit: max of projection model and eth_estimateGas (no extra fixed headroom). */
export function chooseMineGasLimit(projectedBatchGas: bigint, ethEstimateGas: bigint): bigint {
  return projectedBatchGas > ethEstimateGas ? projectedBatchGas : ethEstimateGas;
}

/**
 * Full plan: estimate each request → pack → eth_estimateGas → choose gasLimit.
 * `estimateRequest` / `estimateTxGas` are injected so PEI and CMS share pure logic.
 */
export async function planMineBatch<T>(params: {
  requests: T[];
  config?: Partial<MineGasConfig>;
  estimateRequest: (request: T, maxUserGas: bigint) => Promise<ExecutionGasEstimate>;
  /**
   * Encode + eth_estimateGas for the selected batch.
   * Called only after packing; may return 0n to rely on projection alone (unit tests).
   */
  estimateTxGas: (selected: T[], projections: RequestGasProjection[]) => Promise<bigint>;
}): Promise<MineBatchPlan<T>> {
  const config: MineGasConfig = { ...DEFAULT_MINE_GAS_CONFIG, ...params.config };
  const projections: RequestGasProjection[] = [];
  for (const req of params.requests) {
    const estimate = await params.estimateRequest(req, config.maxUserGas);
    projections.push(projectRequestMineGas(estimate, config));
  }

  const packed = selectBatchByProjectedGas(params.requests, projections, config);
  if (packed.selected.length === 0) {
    return {
      selected: [],
      projections: [],
      projectedBatchGas: 0n,
      ethEstimateGas: 0n,
      gasLimit: 0n,
    };
  }

  const ethEstimateGas = await params.estimateTxGas(packed.selected, packed.selectedProjections);
  const gasLimit = chooseMineGasLimit(packed.projectedBatchGas, ethEstimateGas);

  return {
    selected: packed.selected,
    projections: packed.selectedProjections,
    projectedBatchGas: packed.projectedBatchGas,
    ethEstimateGas,
    gasLimit,
  };
}

/** How much headroom `gasLimit` has over `actualGasUsed` (basis points). */
export function gasLimitHeadroomBps(gasLimit: bigint, actualGasUsed: bigint): bigint {
  if (actualGasUsed === 0n) return 0n;
  if (gasLimit < actualGasUsed) return -1n;
  return ((gasLimit - actualGasUsed) * 10_000n) / actualGasUsed;
}
