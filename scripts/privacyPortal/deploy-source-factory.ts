import {
  connectPrivacyPortalNetwork,
  deploySourceFactory,
  envAddress,
  envBigInt,
  getInboxFromConfig,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const ctx = await connectPrivacyPortalNetwork(process.env.SOURCE_NETWORK);
  const inbox = await getInboxFromConfig(ctx, "source");
  const cotiChainId = envBigInt("COTI_CHAIN_ID", BigInt(process.env.COTI_TESTNET_CHAIN_ID || "7082400"));
  const cotiMother = envAddress("COTI_MOTHER");
  const owner = optionalEnvAddress("FACTORY_OWNER");

  const deployed = await deploySourceFactory(ctx, { inbox, cotiChainId, cotiMother, owner });
  console.log("[privacyPortal:deploy-source-factory] deployed", deployed);
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-source-factory] Failed:", error);
  process.exitCode = 1;
});
