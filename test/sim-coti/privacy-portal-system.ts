process.env.COTI_BACKEND = "sim";
process.env.PP_SYSTEM_TESTS = "1";
await import("../privacy/privacy-portal-system.js");
