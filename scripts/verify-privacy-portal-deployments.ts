/**
 * Verify Privacy Portal deployments from deployConfig.json on Sepolia + Fuji.
 *
 * Hardhat build-info may store solcLongVersion without commit hash; Etherscan requires
 * v0.8.28+commit.7893614a. This script patches that once, then runs hardhat verify.
 */
import { spawn } from "node:child_process";
import { patchBuildInfoSolcLongVersion, readDeployConfig } from "./deploy-utils.js";

const OWNER = "0xdf9f8fca4591227c092fcbab45a846c19fb6d1ae";
const INBOX = "0xB4A53FE02401fDFA8DAc00450dA3FfF8D01502F8";
const MOTHER = "0xf8ed2eb0781d840623d38b32069e8f634c26fb6c";
const COTI = "7082400";

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

const jobsForChain = (network: string, chain: Record<string, any>): Job[] => {
  const jobs: Job[] = [];
  const push = (label: string, address?: string, args: string[] = []) => {
    if (address && address.startsWith("0x") && address.length === 42) {
      jobs.push({ network, address, args, label });
    }
  };

  push("portalImplementation", chain.portalImplementation);
  push("podTokenImplementation", chain.podTokenImplementation);
  push("privacyPortalFactory", chain.privacyPortalFactory, [
    OWNER,
    INBOX,
    COTI,
    MOTHER,
    chain.podTokenImplementation,
    chain.portalImplementation,
  ]);

  return jobs;
};

const main = async () => {
  patchBuildInfoSolcLongVersion();
  const cfg = await readDeployConfig();
  const jobs: Job[] = [
    ...jobsForChain("sepolia", cfg.chains["11155111"] ?? {}),
    ...jobsForChain("avalancheFuji", cfg.chains["43113"] ?? {}),
  ];

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
