/**
 * Register a deterministic sim AES key for a wallet on sim-coti MPC @0x64.
 *
 * Usage:
 *   PRIVATE_KEY=0x… npm run sim:register-aes
 *   PRIVATE_KEY=0x… npm run sim:register-aes -- --print-only
 *   PRIVATE_KEY=0x… npm run sim:register-aes -- --also 0xContract…
 *
 * Env: SIM_COTI_RPC_URL (default http://127.0.0.1:8546), SIM_COTI_CHAIN_ID (default from eth_chainId).
 */
import { createPublicClient, createWalletClient, defineChain, getContract, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aesKeyToBigInt,
  deriveSimAesKey,
  MPC_PRECOMPILE,
} from "@coti-io/sim-coti-node";

const SIM_REGISTER_ABI = [
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

const main = async () => {
  const pkRaw = process.env.PRIVATE_KEY?.trim() || process.env.COTI_TESTNET_PRIVATE_KEY?.trim();
  if (!pkRaw) {
    console.error("Set PRIVATE_KEY (or COTI_TESTNET_PRIVATE_KEY)");
    process.exit(1);
  }
  const pk = (pkRaw.startsWith("0x") ? pkRaw : `0x${pkRaw}`) as `0x${string}`;
  const rpc = (process.env.SIM_COTI_RPC_URL || "http://127.0.0.1:8546").trim();
  const printOnly = process.argv.includes("--print-only");
  const alsoIdx = process.argv.indexOf("--also");
  const alsoAddrs = alsoIdx >= 0 && process.argv[alsoIdx + 1] ? [process.argv[alsoIdx + 1] as `0x${string}`] : [];

  const probe = await fetch(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }),
  }).then((r) => r.json() as Promise<{ result?: string }>);
  if (!probe.result) {
    console.error(`Cannot reach sim-coti at ${rpc}`);
    process.exit(1);
  }
  const chainId = Number.parseInt(probe.result, 16);
  const account = privateKeyToAccount(pk);
  const aesKey = deriveSimAesKey(pk, chainId);
  console.log(`address: ${account.address}`);
  console.log(`chainId: ${chainId}`);
  console.log(`user_aes_key: ${aesKey}`);
  console.log(`rpc: ${rpc}`);

  if (printOnly) return;

  const chain = defineChain({
    id: chainId,
    name: "sim-coti",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  });
  const publicClient = createPublicClient({ chain, transport: http(rpc) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpc) });
  const sim = getContract({
    address: MPC_PRECOMPILE,
    abi: SIM_REGISTER_ABI,
    client: { public: publicClient, wallet: walletClient },
  });

  const targets = [account.address, ...alsoAddrs];
  for (const user of targets) {
    const hash = await sim.write.simRegisterUserKey([user, aesKeyToBigInt(aesKey)]);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`simRegisterUserKey ok for ${user} tx=${hash}`);
  }
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
