/**
 * Fork / dry-run setup CLI — Anvil (source) + sim-coti (COTI).
 *
 * COTI uses **sim-coti-node** (chain 7082401) with:
 *   - Hardhat EDR tip-fork of live COTI by default (Band StdRef + CreateX state)
 *   - default upstream: https://mainnet-archivenode-01.coti.io/rpc (archive)
 *   - pin tip-8; CreateX/Band also hardhat_setCode'd so pin aging is less painful
 *   - fake MPC precompile injected @ 0x64
 * Opt out of tip-fork: `COTI_EDR_FORK=0` or `--blank-coti` (CreateX seed only).
 * Anvil forking of COTI is **not** supported.
 *
 * Usage:
 *   npm run fork:cli -- setup --source avalanche --coti mainnet
 *   npm run fork:cli -- setup --source ethereum --coti mainnet
 *   npm run fork:cli -- status
 *   npm run fork:cli -- stop
 *
 * After setup, enable forks in deploy config:
 *   forks:
 *     enabled: true
 *     sourceRpc: "http://127.0.0.1:8545"
 *     cotiRpc: "http://127.0.0.1:8546"
 *     label: "FORKED"
 *
 * Then:
 *   export AVALANCHE_RPC_URL=http://127.0.0.1:8545   # or ETHEREUM_RPC_URL
 *   export SIM_COTI_RPC_URL=http://127.0.0.1:8546
 *   export COTI_FORK_RPC_URL=http://127.0.0.1:8546
 *   export COTI_FORK_NETWORK=localSimCoti
 *   DEPLOY_CLI_NETWORK=avalanche npm run deploy:cli
 *   DEPLOY_CLI_NETWORK=localSimCoti npm run deploy:cli   # COTI side (not cotiMainnet)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";

const PID_FILE = path.resolve(process.cwd(), ".fork-cli.pids.json");
const SIM_COTI_CHAIN_ID = 7082401;
/** MPC precompile address — non-empty code means inject finished. */
const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064";
const CREATEX_ADDRESS = "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed";

/** 10,000 ether in wei (hex) — enough fake gas for dry-run deploys. */
const FUND_WEI_HEX = "0x21e19e0c9bab2400000";

type ForkPids = {
  source?: { pid: number; port: number; chainId: number; label: string; kind: "anvil" };
  coti?: { pid: number; port: number; chainId: number; label: string; kind: "sim-coti" };
};

const SOURCE_PRESETS: Record<string, { chainId: number; rpcEnv: string; defaultRpc: string; label: string }> = {
  avalanche: {
    chainId: 43114,
    rpcEnv: "AVALANCHE_RPC_URL",
    // Official public C-Chain — publicnode archive requests often 403 (breaks Anvil CreateX eth_getCode).
    defaultRpc: "https://api.avax.network/ext/bc/C/rpc",
    label: "Avalanche C-Chain",
  },
  ethereum: {
    chainId: 1,
    rpcEnv: "ETHEREUM_RPC_URL",
    defaultRpc: "https://ethereum-rpc.publicnode.com",
    label: "Ethereum",
  },
  fuji: {
    chainId: 43113,
    rpcEnv: "AVALANCHE_FUJI_RPC_URL",
    defaultRpc: "https://api.avax-test.network/ext/bc/C/rpc",
    label: "Avalanche Fuji",
  },
  sepolia: {
    chainId: 11155111,
    rpcEnv: "SEPOLIA_RPC_URL",
    defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    label: "Sepolia",
  },
};

/** Which deployConfig COTI slot sim aliases + upstream RPC to Hardhat-fork. */
const COTI_PRESETS: Record<
  string,
  { soTChainId: number; label: string; rpcEnv: string; defaultRpc: string }
> = {
  mainnet: {
    soTChainId: 2632500,
    label: "simCoti EDR-fork COTI Mainnet tip + MPC inject",
    rpcEnv: "COTI_MAINNET_RPC_URL",
    // Archive RPC — public mainnet.coti.io prunes ~128 blocks (Hardhat fork dies).
    defaultRpc: "https://mainnet-archivenode-01.coti.io/rpc",
  },
  testnet: {
    soTChainId: 7082400,
    label: "simCoti EDR-fork COTI Testnet tip + MPC inject",
    rpcEnv: "COTI_TESTNET_RPC_URL",
    defaultRpc: "https://testnet.coti.io/rpc",
  },
};

const readPids = (): ForkPids => {
  if (!fs.existsSync(PID_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(PID_FILE, "utf8")) as ForkPids;
  } catch {
    return {};
  }
};

const writePids = (pids: ForkPids) => {
  fs.writeFileSync(PID_FILE, `${JSON.stringify(pids, null, 2)}\n`);
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const isPidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Kill a detached process group first, then the pid itself. */
const killPid = (pid: number, label: string) => {
  if (!pid) return;
  let killed = false;
  for (const target of [-pid, pid] as const) {
    try {
      process.kill(target, "SIGTERM");
      killed = true;
    } catch {
      /* ignore */
    }
  }
  if (killed) console.log(`[fork-cli] stopped ${label} pid=${pid}`);
  else console.warn(`[fork-cli] could not stop ${label} pid=${pid} (already dead?)`);
};

/** PIDs listening on a TCP port (Linux: ss / fuser / lsof fallbacks). */
const pidsOnPort = (port: number): number[] => {
  const found = new Set<number>();
  const add = (n: number) => {
    if (Number.isFinite(n) && n > 0 && n !== port) found.add(n);
  };
  const run = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  };
  for (const m of run("ss", ["-ltnp"]).matchAll(new RegExp(`:${port}\\b[^\\n]*pid=(\\d+)`, "g"))) {
    add(Number(m[1]));
  }
  // fuser prints "8545/tcp:  1234 5678" — only parse PIDs after the colon.
  const fuserOut = run("fuser", [`${port}/tcp`]);
  const afterColon = fuserOut.includes(":") ? fuserOut.slice(fuserOut.indexOf(":") + 1) : fuserOut;
  for (const m of afterColon.matchAll(/\b(\d+)\b/g)) add(Number(m[1]));
  for (const m of run("lsof", ["-ti", `TCP:${port}`, `-sTCP:LISTEN`]).matchAll(/\b(\d+)\b/g)) {
    add(Number(m[1]));
  }
  return [...found];
};

const freePort = (port: number) => {
  const pids = pidsOnPort(port);
  for (const pid of pids) {
    killPid(pid, `port :${port}`);
  }
  if (pids.length) console.log(`[fork-cli] freed :${port} (was pids ${pids.join(", ")})`);
};

const assertProcAlive = (proc: ChildProcess, label: string) => {
  if (proc.exitCode != null || proc.signalCode != null) {
    throw new Error(
      `[fork-cli] ${label} exited early (code=${proc.exitCode} signal=${proc.signalCode}). Check port conflicts — run: npm run fork:cli -- stop`
    );
  }
  if (proc.pid != null && !isPidAlive(proc.pid)) {
    throw new Error(`[fork-cli] ${label} pid ${proc.pid} is dead`);
  }
};

const resolveSimCotiBin = (): { bin: string; cwd: string } => {
  const require = createRequire(path.join(process.cwd(), "package.json"));
  try {
    const pkgJson = require.resolve("@coti-io/sim-coti-node/package.json");
    const root = path.dirname(pkgJson);
    const bin = path.join(root, "bin", "sim-coti-node.js");
    if (!fs.existsSync(bin)) {
      throw new Error(`sim-coti-node bin missing at ${bin}`);
    }
    return { bin, cwd: root };
  } catch (e) {
    const sibling = path.resolve(process.cwd(), "../sim-coti-node");
    const bin = path.join(sibling, "bin", "sim-coti-node.js");
    if (fs.existsSync(bin)) return { bin, cwd: sibling };
    throw new Error(
      `Cannot find @coti-io/sim-coti-node. Install the workspace dep or clone ../sim-coti-node. (${e instanceof Error ? e.message : e})`
    );
  }
};

const startAnvil = (params: {
  port: number;
  forkUrl: string;
  chainId: number;
  label: string;
}): ChildProcess => {
  const args = [
    "--fork-url",
    params.forkUrl,
    "--port",
    String(params.port),
    "--chain-id",
    String(params.chainId),
    "--block-time",
    "1",
  ];
  console.log(`[fork-cli] Starting Anvil for ${params.label} on :${params.port}`);
  console.log(`[fork-cli]   fork-url=${params.forkUrl}`);
  console.log(`[fork-cli]   chain-id=${params.chainId}`);
  const child = spawn("anvil", args, {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  child.stdout?.on("data", (buf) => {
    const line = String(buf);
    if (/Listening on/i.test(line)) console.log(`[fork-cli] ${params.label}: ${line.trim()}`);
  });
  child.stderr?.on("data", (buf) => {
    const line = String(buf).trim();
    if (line) console.warn(`[fork-cli] ${params.label} stderr: ${line}`);
  });
  child.unref();
  return child;
};

/** Start sim-coti-node (blank or EDR-fork) then inject MPC @ 0x64. Chain 7082401. */
const startSimCoti = (params: {
  port: number;
  label: string;
  /** When set, Hardhat EDR-forks this URL (pin block for pruned public RPCs). */
  edrForkUrl?: string;
  edrForkBlock?: number;
}): ChildProcess => {
  const { bin, cwd } = resolveSimCotiBin();
  const args = [bin, "start", "--port", String(params.port)];
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (params.edrForkUrl) {
    args.push("--fork-url", params.edrForkUrl);
    env.COTI_FORK_URL = params.edrForkUrl;
    if (params.edrForkBlock !== undefined) {
      args.push("--fork-block", String(params.edrForkBlock));
      env.COTI_FORK_BLOCK = String(params.edrForkBlock);
    }
    console.log(`[fork-cli] Starting sim-coti on :${params.port} (EDR fork + MPC inject)`);
    console.log(`[fork-cli]   fork-url=${params.edrForkUrl}`);
    if (params.edrForkBlock !== undefined) {
      console.log(`[fork-cli]   fork-block=${params.edrForkBlock} (near-tip pin for ~128-block prune)`);
    }
  } else {
    delete env.COTI_FORK_URL;
    delete env.SIM_COTI_FORK_URL;
    delete env.COTI_FORK_BLOCK;
    delete env.SIM_COTI_FORK_BLOCK;
    args.push("--no-fork");
    console.log(`[fork-cli] Starting sim-coti on :${params.port} (blank + CreateX seed + MPC inject)`);
  }
  console.log(`[fork-cli]   bin=${bin}`);
  console.log(`[fork-cli]   chain-id=${SIM_COTI_CHAIN_ID}`);
  const child = spawn(process.execPath, args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env,
  });
  child.stdout?.on("data", (buf) => {
    const line = String(buf).trim();
    if (line) console.log(`[fork-cli] sim-coti: ${line}`);
  });
  child.stderr?.on("data", (buf) => {
    const line = String(buf).trim();
    if (line) console.warn(`[fork-cli] sim-coti stderr: ${line}`);
  });
  child.unref();
  return child;
};

const rpcCall = async (rpcUrl: string, method: string, params: unknown[]): Promise<unknown> => {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) {
    throw new Error(`RPC ${method} HTTP ${res.status} at ${rpcUrl}`);
  }
  const json = (await res.json()) as { result?: unknown; error?: { message?: string } };
  if (json.error) {
    throw new Error(`RPC ${method}: ${json.error.message ?? JSON.stringify(json.error)}`);
  }
  return json.result;
};

const waitForRpc = async (rpcUrl: string, timeoutMs = 60_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await rpcCall(rpcUrl, "eth_chainId", []);
      return;
    } catch {
      await sleep(400);
    }
  }
  throw new Error(`RPC not ready at ${rpcUrl} after ${timeoutMs}ms`);
};

/** Wait until MPC inject has set code at 0x64 (Hardhat fork alone is not enough). */
const waitForSimInject = async (rpcUrl: string, timeoutMs = 180_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const code = (await rpcCall(rpcUrl, "eth_getCode", [MPC_PRECOMPILE, "latest"])) as string;
      if (code && code !== "0x" && code.length > 4) {
        console.log(`[fork-cli] sim-coti MPC precompile ready at ${MPC_PRECOMPILE}`);
        return;
      }
    } catch {
      /* still starting */
    }
    await sleep(500);
  }
  throw new Error(
    `sim-coti MPC inject not ready at ${rpcUrl} after ${timeoutMs}ms (no code at ${MPC_PRECOMPILE})`
  );
};

const BAND_STD_REF_MAINNET = "0x9503d502435f8e228b874Ba0F792301d4401b523";

const assertCreateX = async (rpcUrl: string, label: string) => {
  try {
    const code = (await rpcCall(rpcUrl, "eth_getCode", [CREATEX_ADDRESS, "latest"])) as string;
    if (!code || code === "0x" || code.length <= 4) {
      throw new Error(`CreateX missing on ${label} at ${CREATEX_ADDRESS}`);
    }
    console.log(`[fork-cli] CreateX present on ${label}`);
  } catch (e) {
    throw new Error(
      `[fork-cli] CreateX check failed on ${label}: ${e instanceof Error ? e.message : e}`
    );
  }
};

/**
 * Public COTI RPCs prune historical state (~128 blocks). Pin Hardhat fork to tip-lag
 * so eth_getBalance/getCode at the fork block still succeed during startup.
 */
const resolveNearTipForkBlock = async (upstreamRpc: string): Promise<number> => {
  const explicit = process.env.COTI_FORK_BLOCK?.trim() || process.env.SIM_COTI_FORK_BLOCK?.trim();
  if (explicit && Number.isFinite(Number(explicit))) {
    return Number(explicit);
  }
  const lagRaw = process.env.COTI_EDR_FORK_LAG?.trim();
  const lag = lagRaw && Number.isFinite(Number(lagRaw)) ? Math.max(0, Number(lagRaw)) : 8;
  const tipHex = (await rpcCall(upstreamRpc, "eth_blockNumber", [])) as string;
  const tip = Number.parseInt(tipHex, 16);
  if (!Number.isFinite(tip) || tip <= 0) {
    throw new Error(`Could not read tip from ${upstreamRpc}: ${tipHex}`);
  }
  const block = Math.max(0, tip - lag);
  console.log(`[fork-cli] COTI tip=${tip} → pin fork block ${block} (lag=${lag})`);
  return block;
};

/** Copy tip bytecode into local overlay so deploys survive after upstream prunes the pin. */
const seedCodeFromUpstream = async (
  localRpc: string,
  upstreamRpc: string,
  address: string,
  label: string
) => {
  const code = (await rpcCall(upstreamRpc, "eth_getCode", [address, "latest"])) as string;
  if (!code || code === "0x" || code.length <= 4) {
    throw new Error(`Upstream ${upstreamRpc} has no code at ${address} (${label})`);
  }
  await rpcCall(localRpc, "hardhat_setCode", [address, code]);
  const local = (await rpcCall(localRpc, "eth_getCode", [address, "latest"])) as string;
  if (!local || local === "0x" || local.length <= 4) {
    throw new Error(`hardhat_setCode failed for ${label} at ${address}`);
  }
  console.log(`[fork-cli] seeded ${label} code (${(local.length - 2) / 2} bytes) at ${address}`);
};

const seedCreateXFromUpstream = async (localRpc: string, upstreamRpc: string) => {
  console.log(`[fork-cli] Seeding CreateX from ${upstreamRpc} → ${localRpc}`);
  await seedCodeFromUpstream(localRpc, upstreamRpc, CREATEX_ADDRESS, "CreateX");
  await assertCreateX(localRpc, "sim-coti (seeded)");
};

/** Touch Band StdRef while the tip pin is still in the prune window (caches storage locally). */
const warmBandOracle = async (localRpc: string, upstreamRpc: string) => {
  const bandRef =
    process.env.COTI_BAND_STD_REF?.trim() ||
    BAND_STD_REF_MAINNET;
  try {
    await seedCodeFromUpstream(localRpc, upstreamRpc, bandRef, "Band StdRef");
  } catch (e) {
    console.warn(`[fork-cli] Band code seed skipped:`, e instanceof Error ? e.message : e);
    return;
  }
  // getReferenceData(string,string) — warm COTI/USD + ETH/USD via upstream tip eth_call is not
  // enough; call on the local fork so Hardhat caches storage for the pin.
  const { encodeFunctionData, parseAbi } = await import("viem");
  const abi = parseAbi([
    "function getReferenceData(string base, string quote) view returns (uint256,uint256,uint256)",
  ]);
  for (const [base, quote] of [
    ["COTI", "USD"],
    ["ETH", "USD"],
    ["USDC", "USD"],
  ] as const) {
    try {
      const data = encodeFunctionData({
        abi,
        functionName: "getReferenceData",
        args: [base, quote],
      });
      const result = (await rpcCall(localRpc, "eth_call", [{ to: bandRef, data }, "latest"])) as string;
      if (result && result !== "0x") {
        console.log(`[fork-cli] warmed Band ${base}/${quote}`);
      }
    } catch (e) {
      console.warn(
        `[fork-cli] Band warm ${base}/${quote} failed:`,
        e instanceof Error ? e.message : e
      );
    }
  }
};

/** Resolve deployer address from active deploy config (inboxSalt.deployer / roles.owner). */
const resolveDeployerAddress = (): string | undefined => {
  const raw = process.env.DEPLOY_CONFIG?.trim() || "deployConfig.testnet.yaml";
  const filePath = path.isAbsolute(raw) ? raw : path.resolve(process.cwd(), raw);
  if (!fs.existsSync(filePath)) {
    console.warn(`[fork-cli] deploy config not found at ${filePath}; skipping fund`);
    return undefined;
  }
  try {
    const cfg = parseYaml(fs.readFileSync(filePath, "utf8")) as {
      inboxSalt?: { deployer?: string };
      roles?: { owner?: string };
    };
    const addr = (cfg.inboxSalt?.deployer || cfg.roles?.owner || "").trim();
    return addr || undefined;
  } catch (e) {
    console.warn(`[fork-cli] could not read deployer from ${filePath}:`, e instanceof Error ? e.message : e);
    return undefined;
  }
};

const fundAddress = async (rpcUrl: string, address: string, label: string) => {
  // Prefer hardhat_* on sim-coti; Anvil rejects it and needs anvil_*.
  const attempts: Array<[string, unknown[]]> = [
    ["hardhat_setBalance", [address, FUND_WEI_HEX]],
    ["anvil_setBalance", [address, FUND_WEI_HEX]],
  ];
  let lastErr: unknown;
  for (const [method, params] of attempts) {
    try {
      await rpcCall(rpcUrl, method, params);
      lastErr = undefined;
      break;
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastErr) {
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }
  const bal = (await rpcCall(rpcUrl, "eth_getBalance", [address, "latest"])) as string;
  if (BigInt(bal) === 0n) {
    throw new Error(`setBalance reported ok but ${address} still has 0 on ${label}`);
  }
  console.log(`[fork-cli] funded ${address} on ${label} (balance=${bal})`);
};

const printOverlay = (
  sourcePort: number,
  cotiPort: number,
  sourceChainId: number,
  soTCotiChainId: number,
  sourceRpcEnv: string
) => {
  console.log("");
  console.log("────────────────────────────────────────────────────────────");
  console.log("*** DRY-RUN / FORKED *** — not production");
  console.log("");
  console.log("sourceRpc = Anvil tracking the SOURCE tip (--source avalanche|ethereum|…)");
  console.log("cotiRpc   = sim-coti Hardhat EDR tip-fork of COTI + MPC @ 0x64 (default).");
  console.log("            Upstream default: https://mainnet-archivenode-01.coti.io/rpc");
  console.log("            Override: COTI_ARCHIVE_RPC_URL / COTI_FORK_URL");
  console.log("            Opt out: COTI_EDR_FORK=0 or --blank-coti (CreateX seed only).");
  console.log(`sim-coti chain id ${SIM_COTI_CHAIN_ID} aliases deployConfig chains.${soTCotiChainId}`);
  console.log("");
  console.log("Fork overlay for deployConfig.*.yaml:");
  console.log("");
  console.log("forks:");
  console.log("  enabled: true");
  console.log(`  sourceRpc: "http://127.0.0.1:${sourcePort}"`);
  console.log(`  cotiRpc: "http://127.0.0.1:${cotiPort}"`);
  console.log('  label: "FORKED"');
  console.log("");
  console.log("Env helpers:");
  console.log(`  export ${sourceRpcEnv}=http://127.0.0.1:${sourcePort}`);
  console.log(`  export SIM_COTI_RPC_URL=http://127.0.0.1:${cotiPort}`);
  console.log(`  export SOURCE_FORK_RPC_URL=http://127.0.0.1:${sourcePort}`);
  console.log(`  export COTI_FORK_RPC_URL=http://127.0.0.1:${cotiPort}`);
  console.log(`  export SOURCE_FORK_CHAIN_ID=${sourceChainId}`);
  console.log(`  export COTI_FORK_CHAIN_ID=${SIM_COTI_CHAIN_ID}`);
  console.log("  export COTI_FORK_NETWORK=localSimCoti");
  console.log("  export DEPLOY_CONFIG=deployConfig.mainnet.yaml");
  console.log("  # Source: DEPLOY_CLI_NETWORK=avalanche|ethereum npm run deploy:cli");
  console.log("  # COTI:   DEPLOY_CLI_NETWORK=localSimCoti npm run deploy:cli");
  console.log("  #         (do NOT use cotiMainnet against sim-coti)");
  console.log("────────────────────────────────────────────────────────────");
};

const cmdSetup = async (argv: string[]) => {
  let sourceKey = "avalanche";
  let cotiKey = "mainnet";
  let sourcePort = 8545;
  let cotiPort = 8546;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--source" && argv[i + 1]) sourceKey = argv[++i];
    else if (argv[i] === "--coti" && argv[i + 1]) cotiKey = argv[++i];
    else if (argv[i] === "--source-port" && argv[i + 1]) sourcePort = Number(argv[++i]);
    else if (argv[i] === "--coti-port" && argv[i + 1]) cotiPort = Number(argv[++i]);
  }

  const source = SOURCE_PRESETS[sourceKey];
  const coti = COTI_PRESETS[cotiKey];
  if (!source) {
    console.error(`Unknown --source ${sourceKey}. Known: ${Object.keys(SOURCE_PRESETS).join(", ")}`);
    process.exit(1);
  }
  if (!coti) {
    console.error(`Unknown --coti ${cotiKey}. Known: ${Object.keys(COTI_PRESETS).join(", ")}`);
    process.exit(1);
  }

  const existing = readPids();
  if (existing.source?.pid || existing.coti?.pid || pidsOnPort(sourcePort).length || pidsOnPort(cotiPort).length) {
    console.warn("[fork-cli] Existing forks / busy ports — stopping before setup…");
    await cmdStop([sourcePort, cotiPort]);
  }

  // Upstream RPC for Anvil --fork-url (live tip). Prefer FORK_UPSTREAM_* if local RPC already set.
  const sourceRpc =
    process.env[`FORK_UPSTREAM_${source.rpcEnv}`]?.trim() ||
    process.env[`UPSTREAM_${source.rpcEnv}`]?.trim() ||
    (!process.env[source.rpcEnv]?.includes("127.0.0.1")
      ? process.env[source.rpcEnv]?.trim()
      : undefined) ||
    source.defaultRpc;

  const cotiUpstreamRpc =
    process.env.COTI_FORK_URL?.trim() ||
    process.env.COTI_ARCHIVE_RPC_URL?.trim() ||
    process.env[`FORK_UPSTREAM_${coti.rpcEnv}`]?.trim() ||
    process.env[`UPSTREAM_${coti.rpcEnv}`]?.trim() ||
    (!process.env[coti.rpcEnv]?.includes("127.0.0.1")
      ? process.env[coti.rpcEnv]?.trim()
      : undefined) ||
    coti.defaultRpc;

  // Default: Hardhat EDR tip-fork (archive RPC recommended). Opt out: COTI_EDR_FORK=0 / --blank-coti.
  const wantEdrFork = !(
    process.env.COTI_EDR_FORK === "0" ||
    process.env.COTI_EDR_FORK === "false" ||
    argv.includes("--no-edr-fork") ||
    argv.includes("--blank-coti")
  );

  let edrForkBlock: number | undefined;
  if (wantEdrFork) {
    edrForkBlock = await resolveNearTipForkBlock(cotiUpstreamRpc);
  }

  const sourceProc = startAnvil({
    port: sourcePort,
    forkUrl: sourceRpc,
    chainId: source.chainId,
    label: source.label,
  });
  const cotiProc = startSimCoti({
    port: cotiPort,
    label: coti.label,
    edrForkUrl: wantEdrFork ? cotiUpstreamRpc : undefined,
    edrForkBlock,
  });

  const sourceLocal = `http://127.0.0.1:${sourcePort}`;
  const cotiLocal = `http://127.0.0.1:${cotiPort}`;

  console.log("[fork-cli] waiting for RPCs…");
  await waitForRpc(sourceLocal, 60_000);
  assertProcAlive(sourceProc, source.label);
  await waitForRpc(cotiLocal, wantEdrFork ? 180_000 : 90_000);
  assertProcAlive(cotiProc, "sim-coti");
  console.log("[fork-cli] waiting for MPC precompile inject…");
  await waitForSimInject(cotiLocal, 180_000);
  assertProcAlive(cotiProc, "sim-coti");

  if (wantEdrFork) {
    // Overlay tip bytecode immediately so CreateX/Band survive after the pin ages out of
    // the public RPC ~128-block prune window.
    await seedCreateXFromUpstream(cotiLocal, cotiUpstreamRpc);
    await warmBandOracle(cotiLocal, cotiUpstreamRpc);
  } else {
    await seedCreateXFromUpstream(cotiLocal, cotiUpstreamRpc);
  }

  writePids({
    source: {
      pid: sourceProc.pid!,
      port: sourcePort,
      chainId: source.chainId,
      label: source.label,
      kind: "anvil",
    },
    coti: {
      pid: cotiProc.pid!,
      port: cotiPort,
      chainId: SIM_COTI_CHAIN_ID,
      label: coti.label,
      kind: "sim-coti",
    },
  });

  const deployer = resolveDeployerAddress();
  if (deployer) {
    try {
      await fundAddress(sourceLocal, deployer, source.label);
    } catch (e) {
      console.warn(`[fork-cli] source fund failed:`, e instanceof Error ? e.message : e);
    }
    try {
      // After tip-fork + inject, mainnet state has 0 balance — must setBalance here.
      await fundAddress(cotiLocal, deployer, coti.label);
    } catch (e) {
      console.warn(`[fork-cli] coti fund failed:`, e instanceof Error ? e.message : e);
      throw e;
    }
  } else {
    console.warn("[fork-cli] no deployer address found — skip setBalance");
  }

  console.log(
    `[fork-cli] *** FORKED MODE *** source=${source.label} (Anvil) coti=sim-coti` +
      (wantEdrFork
        ? `(EDR fork ${cotiUpstreamRpc} @ ${edrForkBlock})`
        : `(CreateX seeded from ${cotiUpstreamRpc})`)
  );
  console.log(`[fork-cli] PIDs written to ${PID_FILE}`);
  printOverlay(sourcePort, cotiPort, source.chainId, coti.soTChainId, source.rpcEnv);
};

const cmdStop = async (extraPorts: number[] = []) => {
  const pids = readPids();
  const ports = new Set<number>(extraPorts);
  for (const side of ["source", "coti"] as const) {
    const entry = pids[side];
    if (!entry?.pid) continue;
    killPid(entry.pid, entry.label);
    if (entry.port) ports.add(entry.port);
  }
  // Always clear the usual dry-run ports (stale pid files / orphaned listeners).
  ports.add(8545);
  ports.add(8546);
  for (const port of ports) freePort(port);
  await sleep(800);
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  console.log("[fork-cli] done");
};

const cmdStatus = async () => {
  const pids = readPids();
  if (!pids.source && !pids.coti) {
    console.log("[fork-cli] no pid file");
  } else {
    console.log("[fork-cli] *** FORKED ***");
    for (const side of ["source", "coti"] as const) {
      const entry = pids[side];
      if (!entry) continue;
      const alive = isPidAlive(entry.pid);
      const kind = "kind" in entry ? (entry as { kind?: string }).kind : "?";
      console.log(
        `  ${side}: ${entry.label} kind=${kind} chainId=${entry.chainId} :${entry.port} pid=${entry.pid} ${alive ? "RUNNING" : "DEAD"}`
      );
    }
  }
  for (const port of [8545, 8546]) {
    const listeners = pidsOnPort(port);
    console.log(`  port :${port}: ${listeners.length ? `LISTEN pids=${listeners.join(",")}` : "free"}`);
  }
  for (const [label, url] of [
    ["source", "http://127.0.0.1:8545"],
    ["coti", "http://127.0.0.1:8546"],
  ] as const) {
    try {
      const id = (await rpcCall(url, "eth_chainId", [])) as string;
      console.log(`  rpc ${label}: ok chainId=${id}`);
    } catch {
      console.log(`  rpc ${label}: DOWN`);
    }
  }
};

const interactive = async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  console.log("Fork CLI — Anvil (source) + sim-coti forked from COTI tip (MPC inject)");
  console.log("  1) setup avalanche + sim-coti←COTI mainnet");
  console.log("  2) setup ethereum + sim-coti←COTI mainnet");
  console.log("  3) status");
  console.log("  4) stop");
  const choice = (await ask("Choice [1-4]: ")).trim();
  rl.close();
  if (choice === "1") await cmdSetup(["--source", "avalanche", "--coti", "mainnet"]);
  else if (choice === "2") await cmdSetup(["--source", "ethereum", "--coti", "mainnet"]);
  else if (choice === "3") await cmdStatus();
  else if (choice === "4") await cmdStop();
  else console.log("Cancelled.");
};

const main = async () => {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd) {
    await interactive();
    return;
  }
  if (cmd === "setup") await cmdSetup(argv.slice(1));
  else if (cmd === "stop") await cmdStop();
  else if (cmd === "status") await cmdStatus();
  else {
    console.error(`Unknown command ${cmd}. Use: setup | stop | status`);
    process.exit(1);
  }
};

main().catch((e) => {
  console.error("[fork-cli] failed:", e);
  process.exit(1);
});
