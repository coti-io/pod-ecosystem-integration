process.env.COTI_BACKEND = "sim";
process.env.PAYROLL_E2E_TESTS = "1";
await import("../payroll/payroll-e2e.test.js");
