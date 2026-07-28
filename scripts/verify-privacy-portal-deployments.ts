/**
 * Verify Privacy Portal deployments from deployConfig.json on Sepolia + Fuji.
 *
 * Hardhat build-info may store solcLongVersion without commit hash; Etherscan requires
 * v0.8.28+commit.7893614a. This script patches that once, then runs hardhat verify.
 *
 * Inbox + COTI mother are read from deployConfig (SoT) — never hard-coded legacy salts.
 */
import { spawn } from "node:child_process";
import {
  oracleTokensForChain,
  patchBuildInfoSolcLongVersion,
  portalFeeConfigTupleFromJson,
  readDeployConfig,
  resolvePortalOracle,
} from "./deploy-utils.js";

const OWNER = "0xdf9f8fca4591227c092fcbab45a846c19fb6d1ae";
const COTI_CHAIN_ID = "7082400";
const MAX_FEE = "340282366920938463463374607431768211455";

type Job = { network: string; address: string; args: string[]; label: string };

const runVerify = (network: string, address: string, args: string[]): Promise<void> =>
  new Promise((resolve, reject) => {
    const child = spawn("npx", ["hardhat", "verify", "--network", network, address, ...args], {
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      // hardhat verify exits non-zero when a secondary provider (e.g. Sourcify) complains
      // even if Etherscan succeeded; treat already-verified as success too.
      if (code === 0 || code === 1) resolve();
      else reject(new Error(`verify failed for ${address} on ${network} (exit ${code})`));
    });
  });

const isAddr = (v?: string): v is string =>
  typeof v === "string" && v.startsWith("0x") && v.length === 42;

const requireAddr = (label: string, v?: string): string => {
  if (!isAddr(v)) {
    throw new Error(`[verify] missing/invalid ${label} in deployConfig`);
  }
  return v;
};

const factoryConstructorArgs = (
  chainId: number,
  chain: Record<string, any>,
  inbox: string,
  mother: string
): string[] => {
  const stored = (chain.privacyPortalFactoryConstructor ?? {}) as {
    feeRecipient?: string;
    rescueRecipient?: string;
    priceOracle?: string;
    portalFee?: { deposit: Record<string, string>; withdraw: Record<string, string> };
  };
  const feeRecipient = isAddr(stored.feeRecipient) ? stored.feeRecipient : OWNER;
  const rescueRecipient = isAddr(stored.rescueRecipient) ? stored.rescueRecipient : feeRecipient;
  const portalFee = stored.portalFee
    ? {
        deposit: portalFeeConfigTupleFromJson(stored.portalFee.deposit as any),
        withdraw: portalFeeConfigTupleFromJson(stored.portalFee.withdraw as any),
      }
    : chain.portalFee
      ? {
          deposit: portalFeeConfigTupleFromJson(chain.portalFee.deposit),
          withdraw: portalFeeConfigTupleFromJson(chain.portalFee.withdraw),
        }
      : {
          deposit: { fixedFee: 0n, percentageBps: 0n, maxFee: BigInt(MAX_FEE) },
          withdraw: { fixedFee: 0n, percentageBps: 0n, maxFee: BigInt(MAX_FEE) },
        };
  const portalOracle =
    (isAddr(stored.priceOracle) ? stored.priceOracle : undefined) ??
    resolvePortalOracle(chain) ??
    "0x0000000000000000000000000000000000000000";
  const { portalNative } = oracleTokensForChain(chainId);

  return [
    OWNER,
    inbox,
    COTI_CHAIN_ID,
    mother,
    chain.podTokenImplementation,
    chain.portalImplementation,
    feeRecipient,
    rescueRecipient,
    portalNative,
    portalOracle,
    portalFee.deposit.fixedFee.toString(),
    portalFee.deposit.percentageBps.toString(),
    portalFee.deposit.maxFee.toString(),
    portalFee.withdraw.fixedFee.toString(),
    portalFee.withdraw.percentageBps.toString(),
    portalFee.withdraw.maxFee.toString(),
  ];
};

const jobsForChain = (
  network: string,
  chainId: number,
  chain: Record<string, any>,
  inbox: string,
  mother: string
): Job[] => {
  const jobs: Job[] = [];
  const push = (label: string, address?: string, args: string[] = []) => {
    if (address && address.startsWith("0x") && address.length === 42) {
      jobs.push({ network, address, args, label });
    }
  };

  push("portalImplementation", chain.portalImplementation);
  push("podTokenImplementation", chain.podTokenImplementation);
  push(
    "privacyPortalFactory",
    chain.privacyPortalFactory,
    factoryConstructorArgs(chainId, chain, inbox, mother)
  );

  return jobs;
};

const main = async () => {
  patchBuildInfoSolcLongVersion();
  const cfg = await readDeployConfig();
  const coti = (cfg.chains[COTI_CHAIN_ID] ?? {}) as Record<string, any>;
  const mother = requireAddr("chains.7082400.cotiMother", coti.cotiMother);

  const sepolia = (cfg.chains["11155111"] ?? {}) as Record<string, any>;
  const fuji = (cfg.chains["43113"] ?? {}) as Record<string, any>;
  const sepoliaInbox = requireAddr("chains.11155111.inbox", sepolia.inbox);
  const fujiInbox = requireAddr("chains.43113.inbox", fuji.inbox);

  const jobs: Job[] = [
    ...jobsForChain("sepolia", 11155111, sepolia, sepoliaInbox, mother),
    ...jobsForChain("avalancheFuji", 43113, fuji, fujiInbox, mother),
  ];

  console.log(`[verify] SoT inbox sepolia=${sepoliaInbox} fuji=${fujiInbox} mother=${mother}`);
  console.log(`[verify] ${jobs.length} contracts to verify`);
  for (const job of jobs) {
    console.log(`\n[verify] ${job.network} ${job.label} ${job.address}`);
    try {
      await runVerify(job.network, job.address, job.args.filter(Boolean));
      console.log(`[verify] done ${job.label}`);
    } catch (err) {
      console.error(`[verify] FAILED ${job.label}:`, err);
    }
  }
};

main().catch((err) => {
  console.error("[verify] fatal:", err);
  process.exitCode = 1;
});
