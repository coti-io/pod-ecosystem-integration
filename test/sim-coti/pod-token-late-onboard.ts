process.env.COTI_BACKEND = "sim";
process.env.POD_TOKEN_LATE_ONBOARD_TESTS = "1";
process.env.COTI_REUSE_CONTRACTS = "false";
await import("../tokens/pod-token-late-onboard.js");
