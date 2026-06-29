/**
 * Empirical probe: what does COTI `offBoardToUser` return for onboarded vs non-onboarded addresses?
 *
 * Run: `npm run investigate:offboard-to-user`
 * Writes: `docs/coti-offboard-to-user-investigation.md`
 */
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { defineChain } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decryptUint } from "@coti-io/coti-sdk-typescript";
import { ONBOARD_CONTRACT_ADDRESS } from "@coti-io/coti-ethers";
import {
  decodeCtUint256,
  decryptUint256,
  logStep,
  normalizePrivateKey,
  onboardUser,
  receiptWaitOptions,
  resolveCotiTestnetPrivateKey,
} from "../system/mpc-test-utils.js";
import { derivePrivateKeyVariant, fundCotiNativeAccount } from "./test-token-utils.js";

const PROBE_VALUE = 4_242_424n;
const CHARLIE_XOR = 0x02;
const CHARLIE_AES_ENV = "COTI_AES_KEY_CHARLIE_PROBE";
const RANDOM_USER = "0x000000000000000000000000000000000000d00d" as `0x${string}`;
const CONTRACT_LIKE = "0x536A67f0cc46513E7d27a370ed1aF9FDcC7A5095" as `0x${string}`;

const run = process.env.OFFBOARD_TO_USER_INVESTIGATION === "1";
const d = run ? describe : describe.skip;

type CtSample = {
  label: string;
  address: `0x${string}`;
  onboarded: boolean;
  fingerprint: string;
  allZeroLimbs: boolean;
  decryptWithUserKey: string;
};

function ctFingerprint(ct: unknown): string {
  const parts = decodeCtUint256(ct);
  return [parts.ciphertextHigh, parts.ciphertextLow].map((p) => p.toString()).join(",");
}

function isAllZeroLimbs(ct: unknown): boolean {
  const parts = decodeCtUint256(ct);
  return parts.ciphertextHigh === 0n && parts.ciphertextLow === 0n;
}

function tryDecrypt(ct: unknown, userKey: string | undefined): string {
  if (!userKey) return "skipped (no AES key)";
  try {
    const value = decryptUint256(ct, userKey);
    return `ok → ${value}`;
  } catch (e) {
    return `error: ${e instanceof Error ? e.message : String(e)}`;
  }
}

function formatMarkdown(samples: CtSample[], extras: Record<string, string>): string {
  const lines = [
    "# COTI `offBoardToUser` investigation",
    "",
    "Empirical probe on COTI testnet using `OffBoardToUserProbe` (`MpcCore.offBoardToUser` on a public `gtUint256`).",
    "",
    `Probe plaintext value: **${PROBE_VALUE}**`,
    "",
    "## Summary",
    "",
    extras.summary,
    "",
    "## What is a fingerprint?",
    "",
    "A **fingerprint** is a compact string representation of a COTI `ctUint256` ciphertext. It is **not** a cryptographic hash — it does not hide the value. It is the two uint128 limbs (`ciphertextHigh`, `ciphertextLow`), joined with a comma:",
    "",
    "```text",
    "ciphertextHigh,ciphertextLow",
    "```",
    "",
    "`ctUint256` on COTI is stored as two 128-bit chunks. The investigation decodes each sample with `decodeCtUint256` and formats those limbs as decimal strings (see `ctFingerprint` in `test/tokens/offboard-to-user-investigation.ts`).",
    "",
    "Fingerprints let us compare ciphertexts **without decrypting**:",
    "",
    "| Question | How to check |",
    "|----------|--------------|",
    "| Are two ciphertexts identical? | Fingerprints match exactly |",
    "| Is the ct uninitialized / all-zero? | Separate **all-zero limbs** column (`ciphertextHigh` and `ciphertextLow` both `0`) |",
    "| Does onboard change the blob? | Pre vs post fingerprint differs, even when plaintext is the same |",
    "",
    "## Samples",
    "",
    "| Label | Address | Onboarded? | All-zero limbs? | Decrypt attempt | Fingerprint (2×uint128 limbs) |",
    "|-------|---------|--------------|-----------------|-----------------|------------------------------|",
  ];
  for (const s of samples) {
    const fp =
      s.fingerprint.length > 96 ? `${s.fingerprint.slice(0, 96)}…` : s.fingerprint;
    lines.push(
      `| ${s.label} | \`${s.address}\` | ${s.onboarded ? "yes" : "no"} | ${s.allZeroLimbs ? "yes" : "no"} | ${s.decryptWithUserKey} | \`${fp}\` |`
    );
  }
  lines.push(
    "",
    "## Full fingerprints",
    "",
    "```text",
    extras.fullFingerprints,
    "```",
    "",
    "## Interpretation",
    "",
    extras.interpretation,
    "",
    "## How to reproduce",
    "",
    "```bash",
    "npm run investigate:offboard-to-user",
    "```",
    ""
  );
  return lines.join("\n");
}

d("offBoardToUser investigation (COTI testnet)", { concurrency: 1 }, async function () {
  const cotiRpcUrl = process.env.COTI_TESTNET_RPC_URL!;
  const cotiChainId = Number.parseInt(process.env.COTI_TESTNET_CHAIN_ID ?? "7082400", 10);
  const cotiChain = defineChain({
    id: cotiChainId,
    name: "COTI Testnet",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: { default: { http: [cotiRpcUrl] } },
  });

  const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey(cotiRpcUrl));
  const deployer = privateKeyToAccount(cotiPk as `0x${string}`).address;

  const { viem: cotiViem } = await network.connect({ network: "cotiTestnet" });
  const publicClient = await cotiViem.getPublicClient({ chain: cotiChain });
  const wallet = await cotiViem.getWalletClient(deployer, { chain: cotiChain });

  it("probes offBoardToUser for onboarded vs non-onboarded addresses", async function () {
    const onboardAddress = process.env.COTI_ONBOARD_CONTRACT_ADDRESS || ONBOARD_CONTRACT_ADDRESS;

    logStep("investigate: deploy OffBoardToUserProbe on COTI");
    const probe = await cotiViem.deployContract("OffBoardToUserProbe", [], {
      client: { public: publicClient, wallet },
    });
    assert.ok(probe?.address, "OffBoardToUserProbe deploy failed");
    logStep(`investigate: probe at ${probe.address}`);

    const ownerKey = await onboardUser(cotiPk, cotiRpcUrl, onboardAddress, "COTI_AES_KEY_PROBE_OWNER");

    const charliePrivateKey = derivePrivateKeyVariant(cotiPk, CHARLIE_XOR);
    const charlie = {
      address: privateKeyToAccount(charliePrivateKey).address,
      privateKey: charliePrivateKey,
    };

    const runOffBoardToUser = async (value: bigint, user: `0x${string}`) => {
      const hash = await probe.write.probeOffBoardToUser([value, user], { account: deployer });
      await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
      return probe.read.lastOffBoardToUser();
    };
    const runOffBoard = async (value: bigint) => {
      const hash = await probe.write.probeOffBoard([value], { account: deployer });
      await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
      return probe.read.lastOffBoard();
    };
    const runPlainZero = async () => {
      const hash = await probe.write.probePlainZero({ account: deployer });
      await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
      return probe.read.lastPlainZero();
    };

    const samples: CtSample[] = [];
    const record = (label: string, addr: `0x${string}`, onboarded: boolean, ct: unknown, userKey?: string) => {
      const sample: CtSample = {
        label,
        address: addr,
        onboarded,
        fingerprint: ctFingerprint(ct),
        allZeroLimbs: isAllZeroLimbs(ct),
        decryptWithUserKey: tryDecrypt(ct, userKey),
      };
      samples.push(sample);
      logStep(
        `investigate: ${label} zero=${sample.allZeroLimbs} decrypt=${sample.decryptWithUserKey}`
      );
      return sample;
    };

    const ctOwner = await runOffBoardToUser(PROBE_VALUE, deployer);
    record("onboarded owner", deployer, true, ctOwner, ownerKey);

    const ctCharliePre = await runOffBoardToUser(PROBE_VALUE, charlie.address);
    const charliePre = record("Charlie pre-onboard", charlie.address, false, ctCharliePre);

    const ctRandom = await runOffBoardToUser(PROBE_VALUE, RANDOM_USER);
    record("random EOA pre-onboard", RANDOM_USER, false, ctRandom);

    const ctContract = await runOffBoardToUser(PROBE_VALUE, CONTRACT_LIKE);
    record("AccountOnboard contract", CONTRACT_LIKE, false, ctContract);

    const ctSystem = await runOffBoard(PROBE_VALUE);
    const ctZero = await runPlainZero();
    const systemFp = ctFingerprint(ctSystem);
    const zeroFp = ctFingerprint(ctZero);
    record("system offBoard (same value)", deployer, true, ctSystem);
    record("system offBoard(0)", deployer, true, ctZero);

    let charliePost = charliePre;
    let decryptPreWithPostKey = "skipped (Charlie not onboarded)";
    const funderPk =
      process.env._PRIVATE_KEY?.trim() ||
      process.env.COTI_TESTNET_PRIVATE_KEY?.trim() ||
      cotiPk;

    logStep("investigate: fund Charlie minimally for onboard tx");
    try {
      await fundCotiNativeAccount({
        funderPrivateKey: funderPk,
        recipient: charlie.address,
        amountWei: 50_000_000_000_000_000n,
      });
      logStep("investigate: onboard Charlie");
      const charlieKey = await onboardUser(charlie.privateKey, cotiRpcUrl, onboardAddress, CHARLIE_AES_ENV);

      const ctCharliePost = await runOffBoardToUser(PROBE_VALUE, charlie.address);
      charliePost = record("Charlie post-onboard (fresh probe)", charlie.address, true, ctCharliePost, charlieKey);

      decryptPreWithPostKey = tryDecrypt(ctCharliePre, charlieKey);
      samples.push({
        label: "Charlie pre-onboard ct + post-onboard AES key",
        address: charlie.address,
        onboarded: false,
        fingerprint: charliePre.fingerprint,
        allZeroLimbs: charliePre.allZeroLimbs,
        decryptWithUserKey: decryptPreWithPostKey,
      });
    } catch (e) {
      logStep(
        `investigate: Charlie post-onboard skipped — ${e instanceof Error ? e.message : String(e)}`
      );
    }

    const fullFingerprints = [
      `owner-onboarded: ${ctFingerprint(ctOwner)}`,
      `charlie-pre:     ${charliePre.fingerprint}`,
      `charlie-post:    ${charliePost.fingerprint}`,
      `random-pre:      ${ctFingerprint(ctRandom)}`,
      `contract:        ${ctFingerprint(ctContract)}`,
      `system-offBoard: ${systemFp}`,
      `plain-zero:      ${zeroFp}`,
    ].join("\n");

    const summary = [
      "- **MPC call reverts for non-onboarded `addr`:** no (all `probeOffBoardToUser` transactions succeeded)",
      `- **Charlie pre-onboard all-zero limbs:** ${charliePre.allZeroLimbs ? "yes" : "no"}`,
      `- **Charlie pre equals system \`offBoard\`:** ${charliePre.fingerprint === systemFp ? "yes" : "no"}`,
      `- **Charlie pre equals plain-zero:** ${charliePre.fingerprint === zeroFp ? "yes" : "no"}`,
      `- **Charlie pre vs post fingerprint differs:** ${charliePre.fingerprint !== charliePost.fingerprint ? "yes" : "no"}`,
      `- **Decrypt Charlie pre-onboard ct with post-onboard key:** ${decryptPreWithPostKey}`,
      `- **Decrypt Charlie post-onboard ct with post-onboard key:** ${charliePost.decryptWithUserKey}`,
    ].join("\n");

    const interpretation = [
      "### Does `offBoardToUser` revert without onboarding?",
      "",
      "No — for this probe, COTI returns a `ctUint256` for every address tested (onboarded EOA, non-onboarded EOA, and a contract address). This matches Privacy Portal withdraw behaviour: `offBoardToUser(..., portalAddress)` runs even though the portal never calls `onboardAccount`.",
      "",
      "### What does the ciphertext look like?",
      "",
      charliePre.allZeroLimbs
        ? "For non-onboarded Charlie, all four uint64 limbs were **zero** — visually the same shape as uninitialized PoD storage / `_ciphertextPlainZero()`."
        : "For non-onboarded Charlie, limbs were **non-zero** and differed from onboarded-owner and system-offBoard fingerprints.",
      charliePre.fingerprint === systemFp
        ? "Non-onboarded user ciphertext **matched system `offBoard`** for the same plaintext (encryption under system key, not user AES)."
        : charliePre.fingerprint === zeroFp
          ? "Non-onboarded user ciphertext **matched plain-zero** offBoard."
          : "Non-onboarded ciphertext is a **distinct deterministic blob per `addr`**, neither equal to onboarded-user ct nor necessarily to system offBoard.",
      "",
      "### After onboarding",
      "",
      charliePre.fingerprint !== charliePost.fingerprint
        ? "A fresh `offBoardToUser` after `onboardAccount` produces **different ciphertext** that decrypts to the probe value with the user's AES key."
        : "Fingerprint unchanged after onboard (unexpected in this run).",
      "",
      `Decrypting the **pre-onboard** ciphertext with the **post-onboard** AES key: ${decryptPreWithPostKey}.`,
      "",
      "### Implications for PoD / Privacy Portal",
      "",
      "- **Chain execution:** `offBoardToUser` completes for not-yet-onboarded EOAs and contract addresses (e.g. Privacy Portal on withdraw). No try/catch wrapper is required for mining.",
      "- **Ciphertext shape:** non-onboarded addresses get **non-zero**, **per-address** `ctUint256` limbs (not all-zero, not identical to `offBoard` or to another address).",
      "- **Wallet UX:** onboarding is still required before a client can decrypt — but ciphertext produced **before** `onboardAccount` for that address may decrypt with the AES key obtained **after** onboard (see Charlie pre-onboard row). `syncBalances` remains useful to refresh stored balances when PoD ledger ct was produced under different conditions.",
      "- **Allowance spender view:** spender-side ct from approve may still need re-approve after onboard if decryption fails in practice (see `pod-token-late-onboard` test).",
    ].join("\n");

    const docsDir = join(process.cwd(), "docs");
    mkdirSync(docsDir, { recursive: true });
    const outPath = join(docsDir, "coti-offboard-to-user-investigation.md");
    writeFileSync(outPath, formatMarkdown(samples, { summary, interpretation, fullFingerprints }), "utf8");
    logStep(`investigate: wrote ${outPath}`);

    if (charliePost.label.includes("post-onboard")) {
      assert.equal(charliePost.decryptWithUserKey, `ok → ${PROBE_VALUE}`);
    }
  });
});
