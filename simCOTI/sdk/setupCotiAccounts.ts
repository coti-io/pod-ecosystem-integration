import fs from "node:fs";
import { JsonRpcProvider } from "ethers";
import { Wallet as CotiWallet } from "@coti-io/coti-ethers";
import { isSimCotiBackend, resolveCotiBackend } from "../test/coti-network.js";
import { SimWallet, deriveSimAesKey, SIM_COTI_CHAIN_ID } from "../sdk/index.js";

export type CotiAccountsSetup = {
  accounts: Array<CotiWallet | SimWallet>;
  backend: ReturnType<typeof resolveCotiBackend>;
};

/**
 * Shared account setup for coti-contracts MPC tests — live testnet or simCoti.
 */
export async function setupCotiAccounts(params?: {
  privateKeys?: string[];
  provider?: JsonRpcProvider;
}): Promise<CotiAccountsSetup> {
  const backend = resolveCotiBackend();
  let pks = params?.privateKeys ?? (process.env.SIGNING_KEYS ? process.env.SIGNING_KEYS.split(",") : []);

  if (pks.length === 0) {
    const pk = process.env.PRIVATE_KEY?.trim();
    if (!pk) {
      throw new Error("Missing PRIVATE_KEY or SIGNING_KEYS for COTI tests");
    }
    pks = [pk];
  }

  const provider =
    params?.provider ??
    (backend === "sim"
      ? ({ send: async () => null } as unknown as JsonRpcProvider)
      : new JsonRpcProvider(process.env.COTI_TESTNET_RPC_URL ?? "https://testnet.coti.io/rpc"));

  if (backend === "sim") {
    const accounts = await Promise.all(
      pks.map(async (pk) => {
        const wallet = new SimWallet(pk, provider, { chainId: SIM_COTI_CHAIN_ID });
        const key = deriveSimAesKey(wallet.getPrivateKey(), SIM_COTI_CHAIN_ID);
        wallet.setAesKey(key);
        if (params?.provider) {
          await wallet.generateOrRecoverAes();
        }
        return wallet;
      })
    );
    return { accounts, backend };
  }

  const wallets = pks.map((pk) => new CotiWallet(pk, provider));
  let userKeys = process.env.USER_KEYS ? process.env.USER_KEYS.split(",") : [];

  const toAccount = async (wallet: CotiWallet, userKey?: string) => {
    if (userKey) {
      wallet.setAesKey(userKey);
      return wallet;
    }
    await wallet.generateOrRecoverAes();
    return wallet;
  };

  let accounts: CotiWallet[] = [];
  if (userKeys.length !== wallets.length) {
    accounts = await Promise.all(wallets.map(async (w) => await toAccount(w)));
    const keys = accounts.map((a) => a.getUserOnboardInfo()?.aesKey).join(",");
    fs.appendFileSync("./.env", `\nUSER_KEYS=${keys}`, "utf8");
  } else {
    accounts = await Promise.all(wallets.map(async (w, i) => await toAccount(w, userKeys[i])));
  }

  return { accounts, backend };
}

export { isSimCotiBackend, resolveCotiBackend, resolveCotiNetworkName } from "../test/coti-network.js";
