import {
  allowlistFactoryOnMother,
  connectPrivacyPortalNetwork,
  DEFAULT_COTI_NETWORK,
  DEFAULT_SOURCE_NETWORK,
  deployCotiMother,
  deploySourceFactory,
  envBigInt,
  getCotiMotherFromConfig,
  getInboxFromConfig,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const sourceNetwork = process.env.SOURCE_NETWORK || DEFAULT_SOURCE_NETWORK;
  const cotiNetwork = process.env.COTI_NETWORK || DEFAULT_COTI_NETWORK;
  const owner = optionalEnvAddress("FACTORY_OWNER");

  const source = await connectPrivacyPortalNetwork(sourceNetwork);
  const coti = await connectPrivacyPortalNetwork(cotiNetwork);
  const sourceInbox = await getInboxFromConfig(source, "source");
  const cotiInbox = await getInboxFromConfig(coti, "coti");
  const cotiChainId = envBigInt("COTI_CHAIN_ID", BigInt(coti.chainId));

  let cotiMother = optionalEnvAddress("COTI_MOTHER");
  if (!cotiMother) {
    try {
      cotiMother = await getCotiMotherFromConfig(coti);
    } catch {
      cotiMother = (await deployCotiMother(coti, { inbox: cotiInbox, owner })).mother;
    }
  }

  const sourceFactory = await deploySourceFactory(source, {
    inbox: sourceInbox,
    cotiChainId,
    cotiMother,
    owner,
  });

  await allowlistFactoryOnMother(coti, {
    mother: cotiMother,
    sourceChainId: BigInt(source.chainId),
    factory: sourceFactory.factory,
  });

  console.log("[privacyPortal:deploy-factories] deployed", {
    sourceFactory,
    cotiMother,
  });
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-factories] Failed:", error);
  process.exitCode = 1;
});
