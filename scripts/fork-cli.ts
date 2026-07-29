/**
 * Fork setup CLI — start Anvil (source) + optional Anvil (COTI) for dry-run deploys.
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
 *   DEPLOY_CONFIG=deployConfig.mainnet.yaml DEPLOY_CLI_NETWORK=forkSource npm run deploy:cli
 *   (or set Hardhat ethereum/avalanche/cotiMainnet URLs via env to the fork ports)
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

const PID_FILE = path.resolve(process.cwd(), ".fork-cli.pids.json");

type ForkPids = {
  source?: { pid: number; port: number; chainId: number; label: string };
  coti?: { pid: number; port: number; chainId: number; label: string };
};

const SOURCE_PRESETS: Record<string, { chainId: number; rpcEnv: string; defaultRpc: string; label: string }> = {
  avalanche: {
    chainId: 43114,
    rpcEnv: "AVALANCHE_RPC_URL",
    defaultRpc: "https://avalanche-c-chain-rpc.publicnode.com",
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

const COTI_PRESETS: Record<string, { chainId: number; rpcEnv: string; defaultRpc: string; label: string }> = {
  mainnet: {
    chainId: 2632500,
    rpcEnv: "COTI_MAINNET_RPC_URL",
    defaultRpc: "https://mainnet.coti.io/rpc",
    label: "COTI Mainnet",
  },
  testnet: {
    chainId: 7082400,
    rpcEnv: "COTI_TESTNET_RPC_URL",
    defaultRpc: "https://testnet.coti.io/rpc",
    label: "COTI Testnet",
  },
};

const whichAnvil = (): string => {
  // Prefer foundry anvil on PATH
  return "anvil";
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
  console.log(`  export SOURCE_FORK_CHAIN_ID=${sourceChainId}`);
  console.log(`  export COTI_FORK_CHAIN_ID=${cotiChainId}`);
  console.log(`  export DEPLOY_CONFIG=deployConfig.mainnet.yaml`);
  console.log(`  # Then: DEPLOY_CLI_NETWORK=forkSource npm run deploy:cli`);
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
  if (existing.source?.pid || existing.coti?.pid) {
    console.warn("[fork-cli] Existing fork pids found — run `npm run fork:cli -- stop` first, or they will be overwritten.");
  }

  const sourceRpc = process.env[source.rpcEnv]?.trim() || source.defaultRpc;
  const cotiRpc = process.env[coti.rpcEnv]?.trim() || coti.defaultRpc;

  const sourceProc = startAnvil({
    port: sourcePort,
    forkUrl: sourceRpc,
    chainId: source.chainId,
    label: source.label,
  });
  const cotiProc = startAnvil({
    port: cotiPort,
    forkUrl: cotiRpc,
    chainId: coti.chainId,
    label: coti.label,
  });

  // Brief wait for listen
  await new Promise((r) => setTimeout(r, 2500));

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
      label: coti.label,
    },
  });

  console.log(`[fork-cli] *** FORKED MODE *** source=${source.label} coti=${coti.label}`);
  console.log(`[fork-cli] PIDs written to ${PID_FILE}`);
  printOverlay(sourcePort, cotiPort, source.chainId, coti.chainId);
};

const cmdStop = () => {
  const pids = readPids();
  for (const side of ["source", "coti"] as const) {
    const entry = pids[side];
    if (!entry?.pid) continue;
    try {
      process.kill(entry.pid, "SIGTERM");
      console.log(`[fork-cli] stopped ${entry.label} pid=${entry.pid}`);
    } catch (e) {
      console.warn(`[fork-cli] could not stop pid ${entry.pid}:`, e instanceof Error ? e.message : e);
    }
  }
  if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
  console.log("[fork-cli] done");
};

const cmdStatus = () => {
  const pids = readPids();
  if (!pids.source && !pids.coti) {
    console.log("[fork-cli] no forks running (no pid file)");
    return;
  }
  console.log("[fork-cli] *** FORKED ***");
  for (const side of ["source", "coti"] as const) {
    const entry = pids[side];
    if (!entry) continue;
    let alive = false;
    try {
      process.kill(entry.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    console.log(
      `  ${side}: ${entry.label} chainId=${entry.chainId} :${entry.port} pid=${entry.pid} ${alive ? "RUNNING" : "DEAD"}`
    );
  }
};

const interactive = async () => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>((res) => rl.question(q, res));
  console.log("Fork CLI — setup local Anvil forks for dry-run deploy");
  console.log("  1) setup avalanche + COTI mainnet");
  console.log("  2) setup ethereum + COTI mainnet");
  console.log("  3) status");
  console.log("  4) stop");
  const choice = (await ask("Choice [1-4]: ")).trim();
  rl.close();
  if (choice === "1") await cmdSetup(["--source", "avalanche", "--coti", "mainnet"]);
  else if (choice === "2") await cmdSetup(["--source", "ethereum", "--coti", "mainnet"]);
  else if (choice === "3") cmdStatus();
  else if (choice === "4") cmdStop();
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
  else if (cmd === "stop") cmdStop();
  else if (cmd === "status") cmdStatus();
  else {
    console.error(`Unknown command ${cmd}. Use: setup | stop | status`);
    process.exit(1);
  }
};

main().catch((e) => {
  console.error("[fork-cli] failed:", e);
  process.exit(1);
});
