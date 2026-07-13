import { toFunctionSelector, type Address, type Hex } from "viem";
import {
  buildEncryptedInput256,
  type TestContext,
} from "../../../test/system/mpc-test-utils.js";
import type { PublicClient } from "viem";
import type { PayrollTokenAdapter } from "./pod-token-adapter.js";
import type { PayrollPortalContext } from "./portal-setup.js";

export type PodPayrollBackend = {
  podCtx: TestContext;
  portalCtx: PayrollPortalContext;
  publicClient: PublicClient;
  cotiPayroll: { address: Address };
  payrollVault: { address: Address };
  claimStore: { address: Address; write: { setPayload: (...args: unknown[]) => Promise<Hex> } };
  adminWallet: { account: { address: Address } };
  callbackFeeWei: bigint;
  pTokenTransferFeeWei: bigint;
  pTokenCallbackFeeWei: bigint;
  cotiPrivateKey: Hex;
  tokenAdapter: PayrollTokenAdapter;
};

const REGISTER_LEAF_SELECTOR = toFunctionSelector(
  "registerLeaf(uint256,uint256,address,bytes32,((uint256,uint256),bytes))"
) as Hex;

export async function buildPodItAmount(
  backend: PodPayrollBackend,
  amount: bigint,
  purpose: "register" | "claim"
): Promise<{
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  signature: Hex;
}> {
  if (purpose === "register") {
    return buildEncryptedInput256(backend.podCtx, amount, {
      validatingContract: backend.cotiPayroll.address,
      functionSelector: REGISTER_LEAF_SELECTOR,
    });
  }
  return buildEncryptedInput256(backend.podCtx, amount);
}

export class PodPayrollBackendImpl implements PodPayrollBackend {
  constructor(
    readonly podCtx: TestContext,
    readonly portalCtx: PayrollPortalContext,
    readonly publicClient: PublicClient,
    readonly cotiPayroll: { address: Address },
    readonly payrollVault: { address: Address },
    readonly claimStore: PodPayrollBackend["claimStore"],
    readonly adminWallet: { account: { address: Address } },
    readonly callbackFeeWei: bigint,
    readonly pTokenTransferFeeWei: bigint,
    readonly pTokenCallbackFeeWei: bigint,
    readonly cotiPrivateKey: Hex,
    readonly tokenAdapter: PayrollTokenAdapter
  ) {}

  async buildItAmount(amount: bigint, purpose: "register" | "claim" = "claim") {
    return buildPodItAmount(this, amount, purpose);
  }
}
