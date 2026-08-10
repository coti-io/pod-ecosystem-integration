/**
 * System test: {MpcAbiReEncode} via DELEGATECALL on COTI testnet.
 *
 * Proves `validateCiphertext` accepts it-* when re-encode runs under DELEGATECALL
 * (address(this) = harness). Plain CALL to the codec with the same it (encrypted for
 * the harness) must fail.
 *
 * Requires: `COTI_TESTNET_RPC_URL`, and `COTI_TESTNET_PRIVATE_KEY` or `PRIVATE_KEY`.
 * Optional: `MPC_COTI_CONTRACT_DEPLOY_GAS`, `COTI_ONBOARD_CONTRACT_ADDRESS`, `COTI_AES_KEY`.
 *
 * Run from pod-ecosystem-integration:
 *   npm run test:mpc-abi-reencode-delegate-coti
 */
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { network } from "hardhat";
import {
  defineChain,
  encodeAbiParameters,
  toFunctionSelector,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ONBOARD_CONTRACT_ADDRESS, Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { JsonRpcProvider } from "ethers";
import { onboardUser, receiptWaitOptions } from "./mpc-test-utils.js";

const cotiReceiptWaitOptions = { ...receiptWaitOptions, timeout: 900_000 };

const cotiRpc = process.env.COTI_TESTNET_RPC_URL?.trim();
const cotiPkRaw =
  process.env.COTI_TESTNET_PRIVATE_KEY?.trim() || process.env.PRIVATE_KEY?.trim();
const canRunCoti = Boolean(cotiRpc && cotiPkRaw);

const deployGas = process.env.MPC_COTI_CONTRACT_DEPLOY_GAS?.trim()
  ? BigInt(process.env.MPC_COTI_CONTRACT_DEPLOY_GAS.trim())
  : 12_000_000n;

const GAS_REENCODE = process.env.MPC_COTI_REENCODE_GAS?.trim()
  ? BigInt(process.env.MPC_COTI_REENCODE_GAS.trim())
  : 8_000_000n;


const runCotiSystem = process.env.COTI_SYSTEM_TESTS === "1" || process.env.COTI_BACKEND === "sim";
const describeCoti = runCotiSystem ? describe : describe.skip;

describeCoti("MpcAbiReEncode DELEGATECALL (COTI)", { concurrency: false, timeout: 900_000 }, async function () {
  if (!canRunCoti) {
    it.skip(
      "set COTI_TESTNET_RPC_URL and COTI_TESTNET_PRIVATE_KEY (or PRIVATE_KEY) to run this file",
      () => {}
    );
    return;
  }

  const { viem } = await network.connect({ network: "cotiTestnet" });
  const cotiChainId = Number.parseInt(process.env.COTI_TESTNET_CHAIN_ID ?? "7082400", 10);
  const cotiChain = defineChain({
    id: cotiChainId,
    name: "COTI Testnet",
    nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
    rpcUrls: { default: { http: [cotiRpc!] } },
  });
  const pkHex = (cotiPkRaw!.startsWith("0x") ? cotiPkRaw : `0x${cotiPkRaw}`) as `0x${string}`;
  const account = privateKeyToAccount(pkHex);
  const publicClient = await viem.getPublicClient({ chain: cotiChain });
  const wallet = await viem.getWalletClient(account.address, { chain: cotiChain });
  const deployOpts = { client: { public: publicClient, wallet } } as const;

  let nextNonce: number | undefined;
  const txOpts = async (gas?: bigint) => {
    const gasPrice = await publicClient.getGasPrice();
    if (nextNonce === undefined) {
      nextNonce = await publicClient.getTransactionCount({
        address: account.address,
        blockTag: "pending",
      });
    }
    const nonce = nextNonce;
    nextNonce += 1;
    return {
      account: wallet.account,
      gasPrice: gasPrice + (gasPrice * 4n) / 5n + 1n,
      nonce,
      ...(gas === undefined ? {} : { gas }),
    } as const;
  };

  const syncNonceFromError = (err: unknown): boolean => {
    const message = err instanceof Error ? err.message : String(err);
    const next = message.match(/next nonce (\d+)/i);
    if (next?.[1]) {
      nextNonce = Number(next[1]);
      return true;
    }
    if (message.match(/nonce .*lower than the current nonce/i)) {
      nextNonce = (nextNonce ?? 0) + 1;
      return true;
    }
    return false;
  };

  const withNonceRetry = async <T>(
    fn: (opts: Awaited<ReturnType<typeof txOpts>>) => Promise<T>,
    gas?: bigint
  ): Promise<T> => {
    let lastError: unknown;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await fn(await txOpts(gas));
      } catch (err) {
        lastError = err;
        if (!syncNonceFromError(err)) throw err;
      }
    }
    throw lastError;
  };

  let codec: Awaited<ReturnType<(typeof viem)["deployContract"]>>;
  let harness: Awaited<ReturnType<(typeof viem)["deployContract"]>>;
  let aesKey: string;

  before(async function () {
    const onboardAddress =
      process.env.COTI_ONBOARD_CONTRACT_ADDRESS?.trim() || ONBOARD_CONTRACT_ADDRESS;
    aesKey = await onboardUser(pkHex, cotiRpc!, onboardAddress);

    // Prefer the inbox-contracts artifact (builder lib stays in coti-contracts).
    codec = await withNonceRetry(
      (opts) => viem.deployContract("MpcAbiReEncode", [], { ...deployOpts, ...opts } as any),
      deployGas
    );
    harness = await withNonceRetry(
      (opts) =>
        viem.deployContract("DelegateCodecHarness", [codec.address], {
          ...deployOpts,
          ...opts,
        } as any),
      deployGas
    );
  }, { timeout: 900_000 });

  const encryptItUint64For = async (contractAddress: `0x${string}`, value: bigint) => {
    const provider = new JsonRpcProvider(cotiRpc!) as any;
    const cotiWallet = new CotiWallet(pkHex, provider);
    cotiWallet.setUserOnboardInfo({ aesKey });
    const selector = toFunctionSelector(
      "encodeItUint64ViaDelegate(bytes4,(uint256,bytes))"
    );
    const encrypted = await cotiWallet.encryptValue(value, contractAddress, selector);
    const signature =
      typeof encrypted.signature === "string"
        ? (encrypted.signature as Hex)
        : toHex(encrypted.signature as any);
    const ciphertext =
      typeof encrypted.ciphertext === "bigint"
        ? encrypted.ciphertext
        : BigInt(encrypted.ciphertext as any);
    return { ciphertext, signature };
  };

  it("DELEGATECALL reEncodeWithGt accepts itUint64 encrypted for harness", async () => {
    const plain = 42n;
    const it = await encryptItUint64For(harness.address, plain);
    const selector = toFunctionSelector("noop(uint64)");
    const hash = await withNonceRetry(
      (opts) =>
        harness.write.encodeItUint64ViaDelegate(
          [selector, { ciphertext: it.ciphertext, signature: it.signature }],
          opts
        ),
      GAS_REENCODE
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      ...cotiReceiptWaitOptions,
    });
    assert.equal(receipt.status, "success", "DELEGATECALL re-encode must succeed");
    const encoded = (await harness.read.lastEncoded()) as Hex;
    assert.ok(encoded.startsWith("0x") && encoded.length >= 10);
    // selector (4) + one uint256 word
    assert.ok(encoded.length >= 2 + 8 + 64);
  });

  it("CALL to codec with harness-targeted itUint64 fails (wrong address(this))", async () => {
    const plain = 7n;
    const it = await encryptItUint64For(harness.address, plain);
    const selector = toFunctionSelector("noop(uint64)");
    const arg = encodeAbiParameters(
      [
        {
          type: "tuple",
          components: [
            { type: "uint256", name: "ciphertext" },
            { type: "bytes", name: "signature" },
          ],
        },
      ],
      [{ ciphertext: it.ciphertext, signature: it.signature }]
    );
    const methodCall = {
      selector,
      data: arg,
      datatypes: [toHex(14, { size: 8 })], // IT_UINT64
      datalens: [toHex(BigInt((arg.length - 2) / 2), { size: 32 })],
    };

    let failed = false;
    try {
      const hash = await withNonceRetry(
        (opts) => codec.write.reEncodeWithGt([methodCall], opts),
        GAS_REENCODE
      );
      const receipt = await publicClient.waitForTransactionReceipt({
        hash,
        ...cotiReceiptWaitOptions,
      });
      failed = receipt.status !== "success";
    } catch {
      failed = true;
    }
    assert.equal(
      failed,
      true,
      "direct CALL must reject it encrypted for harness (MPC identity is codec, not harness)"
    );
  });

  it("DELEGATECALL reEncodeWithGt succeeds for plain uint256 (no MPC)", async () => {
    const selector = toFunctionSelector("noop(uint256)");
    const data = encodeAbiParameters([{ type: "uint256" }], [99n]);
    const methodCall = {
      selector,
      data,
      datatypes: [toHex(0, { size: 8 })],
      datalens: [toHex(32n, { size: 32 })],
    };
    const hash = await withNonceRetry(
      (opts) => harness.write.encodeViaDelegate([methodCall], opts),
      GAS_REENCODE
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash,
      ...cotiReceiptWaitOptions,
    });
    assert.equal(receipt.status, "success");
  });
});
