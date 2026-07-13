process.env.COTI_BACKEND = "sim";
process.env.COTI_REUSE_CONTRACTS = "false";
await import("../system/inbox-raise.js");
