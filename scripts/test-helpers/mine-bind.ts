import {
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  keccak256,
  size,
  slice,
  toHex,
  type Address,
  type Hex,
} from "viem";
import { sign } from "viem/accounts";
import { HARDHAT_VERIFIER_PK, mineArgs, type HashBatchInbox } from "./verifier.js";

const IT_BOOL = 10n;
const IT_STRING = 17n;
const IT_UINT256 = 16n;
const IT_STRING_TYPE = 17n;
const SCALAR_IT = new Set([10n, 11n, 12n, 13n, 14n, 15n]);

export type MethodCall = {
  selector: Hex;
  data: Hex;
  datatypes: readonly Hex[];
  datalens: readonly Hex[];
};

export type BindableMined = {
  methodCall: MethodCall;
  sourceContract: Address;
};

const itKind = (dtype: Hex | bigint): bigint => BigInt(dtype) & 0xffn;

export const needsUserBind = (methodCall: MethodCall): boolean => {
  if ((methodCall.selector ?? "0x00000000").toLowerCase() === "0x00000000") return false;
  return methodCall.datatypes.some((d) => {
    const n = itKind(d);
    return n >= IT_BOOL && n <= IT_STRING;
  });
};

const word = (value: bigint): Hex => toHex(value, { size: 32 });

const packScalarIt = (arg: Hex): Hex => {
  const [ciphertext] = decodeAbiParameters(
    [{ type: "uint256" }, { type: "bytes" }] as const,
    arg
  );
  return word(ciphertext);
};

const packItUint256 = (arg: Hex): Hex => {
  try {
    const [high, low] = decodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "bytes" }] as const,
      arg
    );
    return concat([word(high), word(low)]);
  } catch {
    const [nested] = decodeAbiParameters(
      [
        {
          type: "tuple",
          components: [{ type: "uint256" }, { type: "uint256" }],
        },
        { type: "bytes" },
      ] as const,
      arg
    );
    return concat([word(nested[0]), word(nested[1])]);
  }
};

const packItString = (arg: Hex): Hex => {
  const tryLayouts: Parameters<typeof decodeAbiParameters>[0][] = [
    [
      { type: "tuple", components: [{ type: "uint256[]", name: "value" }] },
      { type: "bytes[]" },
    ],
    [{ type: "uint256[]" }, { type: "bytes[]" }],
  ];
  for (const layout of tryLayouts) {
    try {
      const decoded = decodeAbiParameters(layout, arg);
      const cells = decoded[0] as unknown;
      const values = Array.isArray(cells)
        ? cells
        : Array.isArray((cells as { value?: bigint[] })?.value)
          ? (cells as { value: bigint[] }).value
          : [];
      return concat(values.map((c) => word(BigInt(c as bigint))));
    } catch {
      /* next layout */
    }
  }
  throw new Error("unable to pack itString ciphertexts");
};

/** Concatenate it* ciphertext words in argument order (no bound user). */
export const packItCiphertexts = (methodCall: MethodCall): Hex => {
  const data = methodCall.data ?? "0x";
  const datatypes = methodCall.datatypes ?? [];
  const datalens = methodCall.datalens ?? [];
  if (datatypes.length !== datalens.length) {
    throw new Error("datatypes/datalens length mismatch");
  }
  const parts: Hex[] = [];
  let cursor = 0;
  const total = size(data);
  for (let i = 0; i < datatypes.length; i++) {
    const argLen = Number(BigInt(datalens[i]));
    if (cursor + argLen > total) {
      throw new Error("methodCall data shorter than datalens");
    }
    const arg = argLen === 0 ? ("0x" as Hex) : slice(data, cursor, cursor + argLen);
    cursor += argLen;
    const dtype = itKind(datatypes[i]);
    if (dtype < IT_BOOL || dtype > IT_STRING) continue;
    if (SCALAR_IT.has(dtype)) parts.push(packScalarIt(arg));
    else if (dtype === IT_UINT256) parts.push(packItUint256(arg));
    else if (dtype === IT_STRING_TYPE) parts.push(packItString(arg));
    else throw new Error(`unsupported it* datatype ${dtype}`);
  }
  return parts.length === 0 ? ("0x" as Hex) : concat(parts);
};

export const injectMineBindTrailer = async (
  methodCall: MethodCall,
  boundUser: Address,
  privateKey: Hex = HARDHAT_VERIFIER_PK
): Promise<MethodCall> => {
  if (!needsUserBind(methodCall)) return methodCall;
  const packed = packItCiphertexts(methodCall);
  if (packed === "0x") return methodCall;
  const digest = keccak256(concat([packed, boundUser]));
  const raw = await sign({ hash: digest, privateKey });
  const trailer = encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [boundUser, raw.r, raw.s]
  );
  return { ...methodCall, data: concat([methodCall.data, trailer]) };
};

export const bindMinedRequests = async <T extends BindableMined>(
  mined: readonly T[],
  privateKey: Hex = HARDHAT_VERIFIER_PK
): Promise<T[]> => {
  const out: T[] = [];
  for (const item of mined) {
    const methodCall = await injectMineBindTrailer(item.methodCall, item.sourceContract, privateKey);
    out.push({ ...item, methodCall });
  }
  return out;
};

/** Bind it* trailers (hh0 miner / tx.origin) then sign hashBatch. */
export const signedMineArgs = async (
  inbox: HashBatchInbox,
  sourceChainId: bigint,
  mined: readonly BindableMined[],
  privateKey: Hex = HARDHAT_VERIFIER_PK
): Promise<[bigint, readonly unknown[], Hex]> => {
  const bound = await bindMinedRequests(mined, privateKey);
  return mineArgs(inbox, sourceChainId, bound, privateKey);
};
