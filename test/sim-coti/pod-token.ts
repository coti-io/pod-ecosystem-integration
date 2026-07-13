process.env.COTI_BACKEND = "sim";
process.env.POD_TOKEN_SYSTEM_TESTS = "1";
await import("../tokens/pod-token.js");
