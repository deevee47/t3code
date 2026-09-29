import { HERMES_DEFAULT_MODEL } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/schema";
import { describe, expect, it } from "vite-plus/test";

import { buildHermesModelsFromSessionModelState } from "../Layers/HermesProvider.ts";
import {
  hermesModeIdForRuntimeMode,
  resolveHermesAcpModelId,
  selectHermesPermissionOptionId,
} from "./HermesAcpSupport.ts";

// The options Hermes sends for a command that may be approved permanently.
const permissionRequest = {
  sessionId: "s",
  toolCall: { toolCallId: "t" },
  options: [
    { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
    { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
    { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
    { optionId: "deny", kind: "reject_once", name: "Deny" },
  ],
} as EffectAcpSchema.RequestPermissionRequest;

describe("HermesAcpSupport", () => {
  it("maps T3 approval decisions to Hermes option ids", () => {
    expect(selectHermesPermissionOptionId(permissionRequest, "accept")).toBe("allow_once");
    expect(selectHermesPermissionOptionId(permissionRequest, "acceptForSession")).toBe(
      "allow_session",
    );
    expect(selectHermesPermissionOptionId(permissionRequest, "acceptAlways")).toBe("allow_always");
    expect(selectHermesPermissionOptionId(permissionRequest, "decline")).toBe("deny");
  });

  it("falls back to allow once when Hermes only offers a one-time approval", () => {
    const onceOnly = {
      ...permissionRequest,
      options: [permissionRequest.options[0]!, permissionRequest.options[3]!],
    };
    expect(selectHermesPermissionOptionId(onceOnly, "acceptForSession")).toBe("allow_once");
  });

  it("maps runtime modes to Hermes approval modes", () => {
    expect(hermesModeIdForRuntimeMode("approval-required")).toBe("default");
    expect(hermesModeIdForRuntimeMode("auto-accept-edits")).toBe("accept_edits");
    expect(hermesModeIdForRuntimeMode("full-access")).toBe("dont_ask");
  });

  it("never sends the Hermes default slug as a model id", () => {
    expect(resolveHermesAcpModelId(HERMES_DEFAULT_MODEL)).toBeUndefined();
    expect(resolveHermesAcpModelId("anthropic:claude-opus-5-5")).toBe("anthropic:claude-opus-5-5");
  });

  it("lists the Hermes default first, named after the session's current model", () => {
    const models = buildHermesModelsFromSessionModelState({
      currentModelId: "custom:deepseek",
      availableModels: [
        { modelId: "custom:deepseek", name: "DeepSeek" },
        { modelId: "anthropic:claude-opus-5-5", name: "Anthropic · claude-opus-5-5" },
      ],
    });
    expect(models.map((model) => [model.slug, model.name, model.isDefault ?? false])).toEqual([
      [HERMES_DEFAULT_MODEL, "Hermes default (DeepSeek)", true],
      ["custom:deepseek", "DeepSeek", false],
      ["anthropic:claude-opus-5-5", "Anthropic · claude-opus-5-5", false],
    ]);
  });
});
