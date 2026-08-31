/**
 * Fork setup CLI — Anvil (source) + sim-coti tip-fork with MPC @0x64 (COTI).
 *
 * Usage:
 *   npm run fork:cli -- setup --source avalanche --coti mainnet
 *   npm run fork:cli -- setup --source ethereum --coti mainnet
 *   npm run fork:cli -- status
 *   npm run fork:cli -- stop
 *
 * Opt out of COTI tip-fork (blank sim only): COTI_EDR_FORK=0
 * Force Anvil for COTI (no MPC): COTI_USE_ANVIL=1  — not recommended for PoD e2e
 *
 * After setup, enable forks in deploy config and point RPCs:
 *   export AVALANCHE_RPC_URL=http://127.0.0.1:8545
 *   export COTI_MAINNET_RPC_URL=http://127.0.0.1:8546
 *   DEPLOY_CONFIG=deployConfig.mainnet.yaml DEPLOY_CLI_NETWORK=cotiMainnet npm run deploy:cli -- --noverify
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const PID_FILE = path.resolve(process.cwd(), ".fork-cli.pids.json");
const require = createRequire(import.meta.url);

type ForkPids = {
  source?: { pid: number; port: number; chainId: number; label: string };
  coti?: { pid: number; port: number; chainId: number; label: string };
};

const SOURCE_PRESETS: Record<string, { chainId: number; rpcEnv: string; defaultRpc: string; label: string }> = {
  avalanche: {
    chainId: 43114,
    rpcEnv: "AVALANCHE_RPC_URL",
    // Official C-Chain RPC reliably returns CreateX bytecode for Anvil forks.
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
    defaultRpc: "https://avalanche-fuji-c-chain-rpc.publicnode.com",
    label: "Avalanche Fuji",
  },
  sepolia: {
    chainId: 11155111,
    rpcEnv: "SEPOLIA_RPC_URL",
    defaultRpc: "https://ethereum-sepolia-rpc.publicnode.com",
    label: "Sepolia",
  },
};

const COTI_PRESETS: Record<
  string,
  { chainId: number; rpcEnv: string; defaultRpc: string; archiveRpc: string; label: string; simFlag: string }
> = {
  mainnet: {
    chainId: 2632500,
    rpcEnv: "COTI_MAINNET_RPC_URL",
    defaultRpc: "https://mainnet.coti.io/rpc",
    archiveRpc: "https://mainnet-archivenode-01.coti.io/rpc",
    label: "COTI Mainnet",
    simFlag: "--sim-coti-mainnet",
  },
  testnet: {
    chainId: 7082400,
    rpcEnv: "COTI_TESTNET_RPC_URL",
    defaultRpc: "https://testnet.coti.io/rpc",
    archiveRpc: "https://testnet.coti.io/rpc",
    label: "COTI Testnet",
    simFlag: "--sim-coti-testnet",
  },
};

const whichAnvil = (): string => "anvil";

const resolveSimCotiBin = (): string => {
  try {
    const pkgJson = require.resolve("@coti-io/sim-coti-node/package.json");
    const bin = path.join(path.dirname(pkgJson), "bin", "sim-coti-node.js");
    if (fs.existsSync(bin)) return bin;
  } catch {
    // fall through
  }
  const sibling = path.resolve(process.cwd(), "../sim-coti-node/bin/sim-coti-node.js");
  if (fs.existsSync(sibling)) return sibling;
  throw new Error(
    "Cannot find @coti-io/sim-coti-node bin. Install the package or clone sim-coti-node as a sibling."
  );
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

const killPortListeners = async (port: number) => {
  try {
    const { execSync } = await import("node:child_process");
    execSync(`fuser -k ${port}/tcp`, { stdio: "ignore" });
  } catch {
    // ignore
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
  const child = spawn(whichAnvil(), args, {
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

const startSimCoti = (params: {
  port: number;
  chainId: number;
  label: string;
  simFlag: string;
  forkUrl: string | null;
}): ChildProcess => {
  const bin = resolveSimCotiBin();
  const args = ["start", params.simFlag, "--port", String(params.port)];
  if (params.forkUrl) {
    args.push("--fork-url", params.forkUrl);
  } else {
    args.push("--no-fork");
  }
  console.log(`[fork-cli] Starting sim-coti for ${params.label} on :${params.port}`);
  console.log(`[fork-cli]   bin=${bin}`);
  console.log(`[fork-cli]   profile=${params.simFlag} chain-id=${params.chainId}`);
  console.log(`[fork-cli]   fork-url=${params.forkUrl ?? "(blank sim, COTI_EDR_FORK=0)"}`);
  const child = spawn(process.execPath, [bin, ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
    env: process.env,
  });
  child.stdout?.on("data", (buf) => {
    const line = String(buf);
    if (/Precompile injected|simCoti RPC|Listening|Forked from/i.test(line)) {
      console.log(`[fork-cli] ${params.label}: ${line.trim()}`);
    }
  });
  child.stderr?.on("data", (buf) => {
    const line = String(buf).trim();
    if (line) console.warn(`[fork-cli] ${params.label} stderr: ${line}`);
  });
  child.unref();
  return child;
};

const waitForRpc = async (port: number, label: string, timeoutMs = 180_000) => {
  const url = `http://127.0.0.1:${port}`;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await res.json()) as { result?: string };
      if (body.result) {
        console.log(`[fork-cli] ${label} ready on :${port} chainId=${body.result}`);
        return;
      }
    } catch {
      // retry
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`[fork-cli] timed out waiting for ${label} on :${port}`);
};

const printOverlay = (sourcePort: number, cotiPort: number, sourceChainId: number, cotiChainId: number) => {
  console.log("");
  console.log("────────────────────────────────────────────────────────────");
  console.log("Fork overlay for deployConfig.*.yaml:");
  console.log("");
  console.log("forks:");
  console.log("  enabled: true");
  console.log(`  sourceRpc: "http://127.0.0.1:${sourcePort}"`);
  console.log(`  cotiRpc: "http://127.0.0.1:${cotiPort}"`);
  console.log('  label: "FORKED"');
  console.log("");
  console.log("Env helpers:");
  console.log(`  export SOURCE_FORK_RPC_URL=http://127.0.0.1:${sourcePort}`);
  console.log(`  export COTI_FORK_RPC_URL=http://127.0.0.1:${cotiPort}`);
  console.log(`  export AVALANCHE_RPC_URL=http://127.0.0.1:${sourcePort}   # or ETHEREUM_RPC_URL`);
  console.log(`  export COTI_MAINNET_RPC_URL=http://127.0.0.1:${cotiPort}`);
  console.log(`  export SOURCE_FORK_CHAIN_ID=${sourceChainId}`);
  console.log(`  export COTI_FORK_CHAIN_ID=${cotiChainId}`);
  console.log(`  export DEPLOY_CONFIG=deployConfig.mainnet.yaml`);
  console.log(`  # Then: DEPLOY_CLI_NETWORK=cotiMainnet|avalanche npm run deploy:cli -- --noverify`);
  console.log("────────────────────────────────────────────────────────────");
};

const cmdStop = () => {
  const pids = readPids();
  for (const side of ["source", "coti"] as const) {
    const entry = pids[side];
    if (!entry?.pid) continue;
    try {
      process.kill(-entry.pid, "SIGTERM");
    } catch {
      try {
        process.kill(entry.pid, "SIGTERM");
      } catch (e) {
        console.warn(`[fork-cli] could not stop ${entry.label} pid=${entry.pid}: ${e}`);
      }
    }
    console.log(`[fork-cli] stopped ${entry.label} pid=${entry.pid}`);
  }
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  console.log("[fork-cli] done");
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
  if (existing.source?.pid || existing.coti?.pid) {
    console.warn("[fork-cli] Existing fork pids found — stopping them first.");
    cmdStop();
  }
  await killPortListeners(sourcePort);
  await killPortListeners(cotiPort);
  await new Promise((r) => setTimeout(r, 1_000));

  // Prefer upstream live URLs for Anvil fork-url; do not use already-overridden local ports.
  const sourceRpc =
    process.env.SOURCE_FORK_UPSTREAM?.trim() ||
    process.env[`UPSTREAM_${source.rpcEnv}`]?.trim() ||
    (process.env[source.rpcEnv]?.includes("127.0.0.1") ? source.defaultRpc : process.env[source.rpcEnv]?.trim()) ||
    source.defaultRpc;

  const blankCoti = process.env.COTI_EDR_FORK === "0" || process.argv.includes("--blank-coti");
  const useAnvilCoti = process.env.COTI_USE_ANVIL === "1";
  const cotiUpstream =
    process.env.COTI_ARCHIVE_RPC_URL?.trim() ||
    process.env.COTI_FORK_URL?.trim() ||
    process.env.COTI_EDR_FORK_URL?.trim() ||
    coti.archiveRpc;

  const sourceProc = startAnvil({
    port: sourcePort,
    forkUrl: sourceRpc,
    chainId: source.chainId,
    label: source.label,
  });

  let cotiProc: ChildProcess;
  if (useAnvilCoti) {
    console.warn("[fork-cli] COTI_USE_ANVIL=1 — Anvil COTI has no MPC @0x64; PoD e2e will fail.");
    cotiProc = startAnvil({
      port: cotiPort,
      forkUrl: process.env[coti.rpcEnv]?.trim() || coti.defaultRpc,
      chainId: coti.chainId,
      label: coti.label,
    });
  } else {
    cotiProc = startSimCoti({
      port: cotiPort,
      chainId: coti.chainId,
      label: `${coti.label} (sim-coti)`,
      simFlag: coti.simFlag,
      forkUrl: blankCoti ? null : cotiUpstream,
    });
  }

  await waitForRpc(sourcePort, source.label);
  await waitForRpc(cotiPort, coti.label);

  writePids({
    source: {
      pid: sourceProc.pid!,
      port: sourcePort,
      chainId: source.chainId,
      label: source.label,
    },
    coti: {
      pid: cotiProc.pid!,
      port: cotiPort,
      chainId: coti.chainId,
      label: useAnvilCoti ? coti.label : `${coti.label} (sim-coti)`,
    },
  });

  console.log(`[fork-cli] *** FORKED MODE *** source=${source.label} coti=${coti.label}`);
  console.log(`[fork-cli] PIDs written to ${PID_FILE}`);
  printOverlay(sourcePort, cotiPort, source.chainId, coti.chainId);
};

const cmdStatus = async () => {
  const pids = readPids();
  for (const side of ["source", "coti"] as const) {
    const entry = pids[side];
    if (!entry) {
      console.log(`[fork-cli] ${side}: not recorded`);
      continue;
    }
    let alive = false;
    try {
      process.kill(entry.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    let rpcOk = false;
    let chainIdHex = "";
    try {
      const res = await fetch(`http://127.0.0.1:${entry.port}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
        signal: AbortSignal.timeout(3_000),
      });
      const body = (await res.json()) as { result?: string };
      rpcOk = Boolean(body.result);
      chainIdHex = body.result ?? "";
    } catch {
      rpcOk = false;
    }
    console.log(
      `[fork-cli] ${side}: ${entry.label} pid=${entry.pid} port=${entry.port} ` +
        `process=${alive ? "ALIVE" : "DEAD"} rpc=${rpcOk ? "RUNNING" : "DOWN"} chainId=${chainIdHex || "?"}`
    );
  }
};

const main = async () => {
  const [, , cmd, ...rest] = process.argv;
  if (cmd === "setup") await cmdSetup(rest);
  else if (cmd === "stop") cmdStop();
  else if (cmd === "status") await cmdStatus();
  else {
    console.log("Usage: npm run fork:cli -- setup|status|stop [--source avalanche|ethereum] [--coti mainnet|testnet]");
    process.exit(cmd ? 1 : 0);
  }
};

// Allow cmdStop to be called from setup without circular issues
void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
