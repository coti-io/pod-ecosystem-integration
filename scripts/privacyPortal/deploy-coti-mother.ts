import {
  connectPrivacyPortalNetwork,
  deployCotiMother,
  getInboxFromConfig,
  optionalEnvAddress,
} from "./deploy-utils.js";

const main = async () => {
  const ctx = await connectPrivacyPortalNetwork(process.env.COTI_NETWORK);
  const inbox = await getInboxFromConfig(ctx, "coti");
  const owner = optionalEnvAddress("FACTORY_OWNER");

  const deployed = await deployCotiMother(ctx, { inbox, owner });
  console.log("[privacyPortal:deploy-coti-mother] deployed", deployed);
};

main().catch((error) => {
  console.error("[privacyPortal:deploy-coti-mother] Failed:", error);
  process.exitCode = 1;
});
