/**
 * Derive + register a sim-coti AES key for a wallet (dry-run / fork:cli).
 *
 * On live COTI you onboard via AccountOnboard. On sim-coti there is no real MPC
 * onboard — you must call `simRegisterUserKey` on the fake precompile @ 0x64.
 *
 * Usage (sim-coti must already be running via `npm run fork:cli -- setup`):
 *
 *   cd pod-ecosystem-integration
 *   PRIVATE_KEY=0x… npm run sim:register-aes
 *   # or: COTI_MAINNET_PRIVATE_KEY / COTI_TESTNET_PRIVATE_KEY
 *
 * Optional:
 *   SIM_COTI_RPC_URL=http://127.0.0.1:8546
 *   SIM_COTI_CHAIN_ID=7082401
 *   --print-only   derive AES only (no on-chain register)
 *   --also 0xContract…   also register the same AES for a contract address
 *
 * Put the printed `user_aes_key` into secrets.mainnet.dryrun.yaml
 * (`services.pod-encryption-service.common.user_aes_key`).
 */
import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aesKeyToBigInt,
  deriveSimAesKey,
  MPC_PRECOMPILE,
  SIM_COTI_CHAIN_ID,
} from "@coti-io/sim-coti-node";

const REGISTER_ABI = [
  {
    type: "function",
    name: "simRegisterUserKey",
    stateMutability: "nonpayable",
    inputs: [
      { name: "user", type: "address" },
      { name: "aesKey", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const normalizePk = (raw: string): Hex => {
  const t = raw.trim();
  return (t.startsWith("0x") ? t : `0x${t}`) as Hex;
};

const main = async () => {
  const argv = process.argv.slice(2);
  const printOnly = argv.includes("--print-only");
  const alsoIdx = argv.indexOf("--also");
  const alsoAddrs: Address[] = [];
  if (alsoIdx >= 0) {
    for (let i = alsoIdx + 1; i < argv.length; i++) {
      if (argv[i].startsWith("-")) break;
      if (!/^0x[a-fA-F0-9]{40}$/.test(argv[i])) {
        throw new Error(`--also expects address(es); got ${argv[i]}`);
      }
      alsoAddrs.push(argv[i] as Address);
    }
  }

  const pkRaw =
    process.env.PRIVATE_KEY?.trim() ||
    process.env.COTI_MAINNET_PRIVATE_KEY?.trim() ||
    process.env.COTI_TESTNET_PRIVATE_KEY?.trim() ||
    process.env.COTI_PRIVATE_KEY?.trim();
  if (!pkRaw) {
    console.error(
      "Set PRIVATE_KEY (or COTI_MAINNET_PRIVATE_KEY / COTI_TESTNET_PRIVATE_KEY) to the wallet SK."
    );
    process.exit(1);
  }

  const pk = normalizePk(pkRaw);
  const account = privateKeyToAccount(pk);
  const rpc = process.env.SIM_COTI_RPC_URL?.trim() || "http://127.0.0.1:8546";
  const chainId = Number(process.env.SIM_COTI_CHAIN_ID || SIM_COTI_CHAIN_ID);
  const aesKey = deriveSimAesKey(pk, chainId);
  const aesUint = aesKeyToBigInt(aesKey);

  console.log("────────────────────────────────────────────────────────────");
  console.log("sim-coti AES (dry-run) — not live AccountOnboard");
  console.log(`  rpc       = ${rpc}`);
  console.log(`  chainId   = ${chainId}`);
  console.log(`  address   = ${account.address}`);
  console.log(`  user_aes_key = ${aesKey}`);
  console.log("────────────────────────────────────────────────────────────");
  console.log("Paste into secrets.mainnet.dryrun.yaml:");
  console.log(`  user_aes_key: "${aesKey}"`);
  console.log("");

  if (printOnly) {
    console.log("(--print-only: skipped on-chain simRegisterUserKey)");
    return;
  }

  const chain = {
    id: chainId,
    name: "simCoti",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  } as const;

  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });

  // Ensure MPC inject is present.
  const code = await publicClient.getBytecode({ address: MPC_PRECOMPILE });
  if (!code || code === "0x") {
    throw new Error(
      `No MPC precompile at ${MPC_PRECOMPILE} on ${rpc}. Run: npm run fork:cli -- setup`
    );
  }

  // Fund if empty (Hardhat/anvil impersonation-free: hardhat_setBalance on sim-coti).
  const bal = await publicClient.getBalance({ address: account.address });
  if (bal === 0n) {
    console.log(`[sim-register-aes] balance=0 — funding via hardhat_setBalance…`);
    await publicClient.request({
      method: "hardhat_setBalance" as any,
      params: [account.address, "0x21e19e0c9bab2400000"], // 10_000 ether
    });
  }

  const targets: Address[] = [account.address, ...alsoAddrs];
  for (const user of targets) {
    const data = encodeFunctionData({
      abi: REGISTER_ABI,
      functionName: "simRegisterUserKey",
      args: [user, aesUint],
    });
    const hash = await walletClient.sendTransaction({
      to: MPC_PRECOMPILE,
      data,
      account,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") {
      throw new Error(`simRegisterUserKey failed for ${user} tx=${hash}`);
    }
    console.log(`[sim-register-aes] registered ${user}  tx=${hash}`);
  }

  console.log("");
  console.log("Done. Re-run after every `fork:cli setup` (sim state resets).");
};

main().catch((err) => {
  console.error("[sim-register-aes] Failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
