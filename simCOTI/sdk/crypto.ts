import {
  encodePacked,
  hexToBytes,
  keccak256,
  type Hex,
  type PrivateKeyAccount,
  type SignableMessage,
} from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";

export const normalizeAesKey = (aesKey: string): string => {
  const trimmed = aesKey.startsWith("0x") ? aesKey.slice(2) : aesKey;
  const lowered = trimmed.toLowerCase();
  if (!/^[0-9a-f]+$/.test(lowered) || lowered.length !== 32) {
    throw new Error("Invalid sim AES key: expected 32 hex chars");
  }
  return lowered;
};

export const aesKeyToBigInt = (aesKey: string): bigint => {
  return BigInt(`0x${normalizeAesKey(aesKey)}`);
};

export const deriveSimAesKey = (privateKey: Hex, chainId: number): string => {
  const hash = keccak256(
    encodePacked(["string", "bytes32", "uint256"], ["sim-coti-aes", privateKey, BigInt(chainId)])
  );
  return hash.slice(2, 34);
};

const maskForBits = (bits: number): bigint => {
  if (bits >= 256) return (1n << 256n) - 1n;
  return (1n << BigInt(bits)) - 1n;
};

export const simEncryptUint = (plain: bigint, aesKey: string, bits = 64): bigint => {
  const mask = maskForBits(bits);
  return (plain + aesKeyToBigInt(aesKey)) & mask;
};

export const simDecryptUint = (ciphertext: bigint, aesKey: string, bits = 64): bigint => {
  if (ciphertext === 0n) return 0n;
  const mask = maskForBits(bits);
  return (ciphertext - aesKeyToBigInt(aesKey)) & mask;
};

export const simEncryptUint128 = (plain: bigint, aesKey: string): bigint => {
  return simEncryptUint(plain, aesKey, 128);
};

export const simDecryptUint128 = (ciphertext: bigint, aesKey: string): bigint => {
  return simDecryptUint(ciphertext, aesKey, 128);
};

export const split256To128 = (value: bigint): { high: bigint; low: bigint } => {
  const mask128 = (1n << 128n) - 1n;
  return { high: value >> 128n, low: value & mask128 };
};

export const combine128To256 = (high: bigint, low: bigint): bigint => {
  return (high << 128n) | low;
};

export const simEncryptUint256 = (
  plain: bigint,
  aesKey: string
): { ciphertextHigh: bigint; ciphertextLow: bigint } => {
  const { high, low } = split256To128(plain);
  return {
    ciphertextHigh: simEncryptUint128(high, aesKey),
    ciphertextLow: simEncryptUint128(low, aesKey),
  };
};

export const simDecryptUint256 = (
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint },
  aesKey: string
): bigint => {
  const high = simDecryptUint128(ciphertext.ciphertextHigh, aesKey);
  const low = simDecryptUint128(ciphertext.ciphertextLow, aesKey);
  return combine128To256(high, low);
};

/** Matches Solidity `abi.encodePacked(ciphertextHigh, ciphertextLow)` (64 bytes). */
export const buildSimIt256CtBytes = (ciphertextHigh: bigint, ciphertextLow: bigint): Hex =>
  encodePacked(["uint256", "uint256"], [ciphertextHigh, ciphertextLow]);

const signSimDigest = async (privateKey: Hex, digest: Hex): Promise<`0x${string}`> => {
  const sig = await sign({ hash: digest, privateKey });
  const v = sig.yParity === 0 ? 27 : 28;
  const r = sig.r.slice(2).padStart(64, "0");
  const s = sig.s.slice(2).padStart(64, "0");
  return `0x${r}${s}${v.toString(16).padStart(2, "0")}` as `0x${string}`;
};

export const buildSimItSignature = async (params: {
  privateKey: Hex;
  contractAddress: `0x${string}`;
  functionSelector: `0x${string}`;
  ciphertext: bigint;
}): Promise<`0x${string}`> => {
  const account = privateKeyToAccount(params.privateKey);
  const digest = keccak256(
    encodePacked(
      ["uint8", "string", "address", "bytes4", "uint256"],
      [0x19, "SIM_COTI_IT:", params.contractAddress, params.functionSelector, params.ciphertext]
    )
  );
  const ecdsa = await signSimDigest(params.privateKey, digest);
  const body = hexToBytes(ecdsa);
  const selectorBytes = hexToBytes(params.functionSelector);
  return `0x${[
    ...selectorBytes,
    ...body,
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
};

export const buildSimIt256Signature = async (params: {
  privateKey: Hex;
  contractAddress: `0x${string}`;
  functionSelector: `0x${string}`;
  ctBytes: Hex;
}): Promise<`0x${string}`> => {
  const account = privateKeyToAccount(params.privateKey);
  const digest = keccak256(
    encodePacked(
      ["uint8", "string", "address", "bytes4", "bytes"],
      [0x19, "SIM_COTI_IT256:", params.contractAddress, params.functionSelector, params.ctBytes]
    )
  );
  const ecdsa = await signSimDigest(params.privateKey, digest);
  const body = hexToBytes(ecdsa);
  const selectorBytes = hexToBytes(params.functionSelector);
  return `0x${[
    ...selectorBytes,
    ...body,
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;
};

export const buildOnboardPayload = (aesKey: string): Hex => {
  const key = aesKeyToBigInt(aesKey);
  return `0x${key.toString(16).padStart(64, "0")}` as Hex;
};

export const recoverSimUserKeyFromShares = (share0: Hex, share1: Hex): string => {
  const a = BigInt(share0);
  const b = BigInt(share1);
  return (a ^ b).toString(16).padStart(32, "0");
};
