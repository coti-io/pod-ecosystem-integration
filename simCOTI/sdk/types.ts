export type CtUint256 = {
  ciphertextHigh: bigint;
  ciphertextLow: bigint;
};

export type ItUint64 = {
  ciphertext: bigint;
  signature: `0x${string}`;
};

export type ItUint128 = ItUint64;

export type ItUint256 = {
  ciphertext: CtUint256;
  signature: `0x${string}`;
};

export type SimUserOnboardInfo = {
  aesKey: string;
};

export const SIM_COTI_CHAIN_ID = 7082401;
export const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064" as const;
export const SIM_SIGNATURE_LENGTH = 69;
