import { JsonRpcProvider, Wallet as EthersWallet } from "ethers";
import type { Hex, PrivateKeyAccount } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aesKeyToBigInt,
  buildOnboardPayload,
  buildSimIt256CtBytes,
  buildSimIt256Signature,
  buildSimItSignature,
  deriveSimAesKey,
  simDecryptUint,
  simDecryptUint128,
  simDecryptUint256,
  simEncryptUint,
  simEncryptUint128,
  simEncryptUint256,
} from "./crypto.js";
import type { CtUint256, ItUint128, ItUint256, ItUint64, SimUserOnboardInfo } from "./types.js";
import { MPC_PRECOMPILE, SIM_COTI_CHAIN_ID } from "./types.js";

export type SimWalletOptions = {
  chainId?: number;
  aesKey?: string;
};

/**
 * Drop-in test wallet for simCOTI. Mirrors the subset of `@coti-io/coti-ethers` Wallet used in PoD tests.
 */
export class SimWallet {
  readonly address: `0x${string}`;
  readonly account: PrivateKeyAccount;
  private readonly privateKey: Hex;
  readonly provider: JsonRpcProvider;
  private aesKey?: string;
  private readonly chainId: number;

  constructor(privateKey: string, provider: JsonRpcProvider, options: SimWalletOptions = {}) {
    const pk = (privateKey.startsWith("0x") ? privateKey : `0x${privateKey}`) as Hex;
    this.privateKey = pk;
    this.account = privateKeyToAccount(pk);
    this.address = this.account.address;
    this.provider = provider;
    this.chainId = options.chainId ?? SIM_COTI_CHAIN_ID;
    this.aesKey = options.aesKey?.replace(/^0x/, "").toLowerCase();
  }

  getUserOnboardInfo(): SimUserOnboardInfo | undefined {
    if (!this.aesKey) return undefined;
    return { aesKey: this.aesKey };
  }

  setAesKey(aesKey: string): void {
    this.aesKey = aesKey.replace(/^0x/, "").toLowerCase();
  }

  getPrivateKey(): Hex {
    return this.privateKey;
  }

  async generateOrRecoverAes(onboardAddress?: string): Promise<void> {
    if (!this.aesKey) {
      this.aesKey = deriveSimAesKey(this.privateKey, this.chainId);
    }

    const signer = new EthersWallet(this.privateKey, this.provider);
    if (onboardAddress) {
      const onboard = new EthersWallet(this.privateKey, this.provider).connect(this.provider);
      const contract = new (require("ethers").Contract as typeof import("ethers").Contract)(
        onboardAddress,
        ["function onboardAccount(bytes calldata publicKey, bytes calldata signedEK) public"],
        signer
      );
      const payload = buildOnboardPayload(this.aesKey);
      await (await contract.onboardAccount("0x01", payload)).wait();
    } else {
      const contract = new (require("ethers").Contract as typeof import("ethers").Contract)(
        MPC_PRECOMPILE,
        ["function simRegisterUserKey(address user, uint256 aesKey) external"],
        signer
      );
      await (await contract.simRegisterUserKey(this.address, aesKeyToBigInt(this.aesKey))).wait();
    }
  }

  async encryptValue(
    value: bigint | number,
    contractAddress: string,
    functionSelector: string
  ): Promise<ItUint64> {
    if (!this.aesKey) {
      throw new Error("SimWallet: call generateOrRecoverAes() first");
    }
    const plain = BigInt(value);
    const ciphertext = simEncryptUint(plain, this.aesKey, 64);
    const selector = (functionSelector.startsWith("0x")
      ? functionSelector
      : `0x${functionSelector}`) as `0x${string}`;
    const signature = await buildSimItSignature({
      privateKey: this.privateKey,
      contractAddress: contractAddress as `0x${string}`,
      functionSelector: selector,
      ciphertext,
    });
    return { ciphertext, signature };
  }

  async encryptValue256(
    value: bigint | number,
    contractAddress: string,
    functionSelector: string
  ): Promise<ItUint256> {
    if (!this.aesKey) {
      throw new Error("SimWallet: call generateOrRecoverAes() first");
    }
    const plain = BigInt(value);
    const ciphertext = simEncryptUint256(plain, this.aesKey);
    const ctBytes = buildSimIt256CtBytes(ciphertext.ciphertextHigh, ciphertext.ciphertextLow);
    const selector = (functionSelector.startsWith("0x")
      ? functionSelector
      : `0x${functionSelector}`) as `0x${string}`;
    const signature = await buildSimIt256Signature({
      privateKey: this.privateKey,
      contractAddress: contractAddress as `0x${string}`,
      functionSelector: selector,
      ctBytes,
    });
    return { ciphertext, signature };
  }

  async decryptValue(ct: bigint | CtUint256 | { ciphertext: bigint }): Promise<bigint> {
    if (!this.aesKey) {
      throw new Error("SimWallet: AES key not set");
    }
    if (typeof ct === "bigint") {
      return simDecryptUint(ct, this.aesKey, 64);
    }
    if ("ciphertextHigh" in ct && "ciphertextLow" in ct) {
      return simDecryptUint256(ct as CtUint256, this.aesKey);
    }
    if ("ciphertext" in ct && typeof ct.ciphertext === "bigint") {
      return simDecryptUint128(ct.ciphertext, this.aesKey);
    }
    return simDecryptUint(BigInt(ct as unknown as string), this.aesKey, 64);
  }

  async sendTransaction(tx: { to?: string; value?: bigint; data?: string; gasLimit?: bigint }) {
    const signer = new EthersWallet(this.privateKey, this.provider);
    return signer.sendTransaction({
      to: tx.to,
      value: tx.value,
      data: tx.data,
      gasLimit: tx.gasLimit,
    });
  }
}

/** Sim replacement for `prepareIT` from `@coti-io/coti-sdk-typescript`. */
export const prepareSimIT = async (
  plaintext: bigint,
  sender: { wallet: SimWallet; userKey: string },
  contractAddress: string,
  functionSelector: string
): Promise<ItUint128> => {
  sender.wallet.setAesKey(sender.userKey);
  const ciphertext = simEncryptUint128(plaintext, sender.userKey);
  const signature = await buildSimItSignature({
    privateKey: sender.wallet.getPrivateKey(),
    contractAddress: contractAddress as `0x${string}`,
    functionSelector: functionSelector as `0x${string}`,
    ciphertext,
  });
  return { ciphertext, signature };
};

/** Sim replacement for `prepareIT256`. */
export const prepareSimIT256 = async (
  plaintext: bigint,
  sender: { wallet: SimWallet; userKey: string },
  contractAddress: string,
  functionSelector: string
): Promise<ItUint256> => {
  sender.wallet.setAesKey(sender.userKey);
  return sender.wallet.encryptValue256(plaintext, contractAddress, functionSelector);
};

/** Sim replacement for `decryptUint`. */
export const decryptSimUint = (ciphertext: bigint, userKey: string, bits = 64): bigint => {
  return simDecryptUint(ciphertext, userKey, bits);
};

/** Sim replacement for `decryptUint128`. */
export const decryptSimUint128 = (ciphertext: bigint, userKey: string): bigint => {
  return simDecryptUint128(ciphertext, userKey);
};

/** Sim replacement for `decryptUint256`. */
export const decryptSimUint256 = (ciphertext: CtUint256, userKey: string): bigint => {
  return simDecryptUint256(ciphertext, userKey);
};
