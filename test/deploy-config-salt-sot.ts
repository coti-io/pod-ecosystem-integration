import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readDeployConfigSync } from "../scripts/deploy-config.js";
import { requireSaltLabel } from "../scripts/deploy-utils.js";

describe("deployConfig salt SoT", () => {
  it("requires inboxSalt.label from deployConfig (no code default)", () => {
    const cfg = readDeployConfigSync() as { inboxSalt?: { label?: string } };
    const label = requireSaltLabel({
      fromConfig: cfg.inboxSalt?.label,
      envKey: "INBOX_SALT_LABEL_MUST_NOT_EXIST_FOR_THIS_TEST",
      configPath: "deployConfig.inboxSalt.label",
    });
    assert.ok(label.length > 0);
    assert.throws(
      () =>
        requireSaltLabel({
          fromConfig: undefined,
          envKey: "INBOX_SALT_LABEL_MUST_NOT_EXIST_FOR_THIS_TEST",
          configPath: "deployConfig.inboxSalt.label",
        }),
      /deployConfig.inboxSalt.label/
    );
  });
});
