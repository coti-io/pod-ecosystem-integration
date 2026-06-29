import { network } from "hardhat";
import fs from "node:fs/promises";
import path from "node:path";
import { asAddress } from "../deploy-utils.js";
import { connectPrivacyPortalNetwork, DEFAULT_COTI_NETWORK, DEFAULT_SOURCE_NETWORK } from "./deploy-utils.js";

type TokenConfig = {
  erc20: string;
  name: string;
  symbol: string;
  decimals?: number;
  privacyPortal?: string;
  pToken?: string;
};

type NetworkConfig = {
  privacyPortal: {
    factory?: string;
    portalImplementation?: string;
    podTokenImplementation?: string;
    cotiMother?: string;
    cotiNetwork?: string;
  };
  tokens?: TokenConfig[];
};

type PrivacyPortalConfig = {
  networks: Record<string, NetworkConfig>;
};

const configPath = path.resolve(process.cwd(), process.env.PRIVACY_PORTAL_CONFIG || "PrivacyPortalConfig.json");

const requireAddress = (value: string | undefined, key: string) => asAddress(value ?? "", key);

const main = async () => {
  const config = JSON.parse(await fs.readFile(configPath, "utf8")) as PrivacyPortalConfig;
  const sourceNetwork = process.env.SOURCE_NETWORK || DEFAULT_SOURCE_NETWORK;
  const sourceConfig = config.networks[sourceNetwork];
  if (!sourceConfig) throw new Error(`Missing source config ${sourceNetwork}`);
  const cotiNetwork = process.env.COTI_NETWORK || sourceConfig.privacyPortal.cotiNetwork || DEFAULT_COTI_NETWORK;
  const cotiConfig = config.networks[cotiNetwork];
  if (!cotiConfig) throw new Error(`Missing COTI config ${cotiNetwork}`);

  const source = await connectPrivacyPortalNetwork(sourceNetwork);
  const coti = await connectPrivacyPortalNetwork(cotiNetwork);

  const sourceFactoryAddress = requireAddress(sourceConfig.privacyPortal.factory, "source factory");
  const portalImplementation = requireAddress(sourceConfig.privacyPortal.portalImplementation, "portal implementation");
  const podTokenImplementation = requireAddress(sourceConfig.privacyPortal.podTokenImplementation, "pod token implementation");
  const cotiMotherAddress = requireAddress(cotiConfig.privacyPortal.cotiMother, "coti mother");

  const sourceFactory = await source.viem.getContractAt("PrivacyPortalFactory", sourceFactoryAddress, {
    client: { public: source.publicClient, wallet: source.walletClient },
  });
  const cotiMother = await coti.viem.getContractAt("PodErc20CotiMother", cotiMotherAddress, {
    client: { public: coti.publicClient, wallet: coti.walletClient },
  });

  const sourceFactoryPortalImpl = await sourceFactory.read.portalImplementation();
  const sourceFactoryTokenImpl = await sourceFactory.read.podTokenImplementation();
  const sourceFactoryMother = await sourceFactory.read.cotiMotherContract();
  if (sourceFactoryPortalImpl.toLowerCase() !== portalImplementation.toLowerCase()) {
    throw new Error(`Source factory portal implementation mismatch: ${sourceFactoryPortalImpl}`);
  }
  if (sourceFactoryTokenImpl.toLowerCase() !== podTokenImplementation.toLowerCase()) {
    throw new Error(`Source factory token implementation mismatch: ${sourceFactoryTokenImpl}`);
  }
  if (sourceFactoryMother.toLowerCase() !== cotiMotherAddress.toLowerCase()) {
    throw new Error(`Source factory COTI mother mismatch: ${sourceFactoryMother}`);
  }

  const factoryAllowed = await cotiMother.read.allowedFactories([BigInt(source.chainId), sourceFactoryAddress]);
  if (!factoryAllowed) {
    throw new Error(`Source factory not allowlisted on COTI mother: ${sourceFactoryAddress}`);
  }

  for (const token of sourceConfig.tokens ?? []) {
    const erc20 = requireAddress(token.erc20, `${token.symbol}.erc20`);
    const portal = requireAddress(token.privacyPortal, `${token.symbol}.privacyPortal`);
    const pToken = requireAddress(token.pToken, `${token.symbol}.pToken`);
    const decimals = token.decimals ?? 18;

    const mappedPortal = await sourceFactory.read.portalForUnderlying([erc20]);
    const mappedPToken = await sourceFactory.read.pTokenForUnderlying([erc20]);
    const mappedPortalForPToken = await sourceFactory.read.portalForPToken([pToken]);
    if (mappedPortal.toLowerCase() !== portal.toLowerCase()) {
      throw new Error(`${token.symbol}: portal mapping mismatch ${mappedPortal}`);
    }
    if (mappedPToken.toLowerCase() !== pToken.toLowerCase()) {
      throw new Error(`${token.symbol}: pToken mapping mismatch ${mappedPToken}`);
    }
    if (mappedPortalForPToken.toLowerCase() !== portal.toLowerCase()) {
      throw new Error(`${token.symbol}: portalForPToken mismatch ${mappedPortalForPToken}`);
    }

    const portalContract = await source.viem.getContractAt("PrivacyPortal", portal, {
      client: { public: source.publicClient, wallet: source.walletClient },
    });
    const pTokenContract = await source.viem.getContractAt("PodErc20MintableInitializable", pToken, {
      client: { public: source.publicClient, wallet: source.walletClient },
    });

    const portalUnderlying = await portalContract.read.underlyingToken();
    const portalPToken = await portalContract.read.pToken();
    const portalDecimals = await portalContract.read.decimals();
    const pTokenDecimals = await pTokenContract.read.decimals();
    const pTokenCotiSide = await pTokenContract.read.cotiSideContract();
    const pTokenMinter = await pTokenContract.read.minter();
    const registered = await cotiMother.read.isRegistered([BigInt(source.chainId), pToken]);

    if (portalUnderlying.toLowerCase() !== erc20.toLowerCase()) throw new Error(`${token.symbol}: portal underlying mismatch`);
    if (portalPToken.toLowerCase() !== pToken.toLowerCase()) throw new Error(`${token.symbol}: portal pToken mismatch`);
    if (portalDecimals !== decimals) throw new Error(`${token.symbol}: portal decimals mismatch`);
    if (pTokenDecimals !== decimals) throw new Error(`${token.symbol}: pToken decimals mismatch`);
    if (pTokenCotiSide.toLowerCase() !== cotiMotherAddress.toLowerCase()) throw new Error(`${token.symbol}: pToken COTI mother mismatch`);
    if (pTokenMinter.toLowerCase() !== portal.toLowerCase()) throw new Error(`${token.symbol}: pToken minter mismatch`);
    if (!registered) throw new Error(`${token.symbol}: pToken not registered on COTI mother`);

    console.log(`[privacyPortal:check] ${token.symbol}: ok`);
  }

  console.log("[privacyPortal:check] all checks passed");
};

main().catch((error) => {
  console.error("[privacyPortal:check] Failed:", error);
  process.exitCode = 1;
});
