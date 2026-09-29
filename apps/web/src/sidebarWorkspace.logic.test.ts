import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hermesInstanceIds,
  nextSidebarWorkspace,
  threadBelongsToWorkspace,
} from "./sidebarWorkspace.logic";

const thread = (instanceId: string) => ({ modelSelection: { instanceId } });

describe("sidebar workspaces", () => {
  it("puts threads from any Hermes instance in the Hermes workspace and the rest in T3", () => {
    const ids = hermesInstanceIds([
      {
        instanceId: ProviderInstanceId.make("hermes_work"),
        driver: ProviderDriverKind.make("hermes"),
      },
      { instanceId: ProviderInstanceId.make("codex"), driver: ProviderDriverKind.make("codex") },
    ]);

    expect(threadBelongsToWorkspace(thread("hermes"), "hermes", ids)).toBe(true);
    expect(threadBelongsToWorkspace(thread("hermes_work"), "hermes", ids)).toBe(true);
    expect(threadBelongsToWorkspace(thread("hermes_work"), "t3", ids)).toBe(false);
    expect(threadBelongsToWorkspace(thread("codex"), "t3", ids)).toBe(true);
    expect(threadBelongsToWorkspace(thread("codex"), "hermes", ids)).toBe(false);
  });

  it("swipes cycle through workspaces in either direction", () => {
    expect(nextSidebarWorkspace("t3", 1)).toBe("hermes");
    expect(nextSidebarWorkspace("hermes", 1)).toBe("t3");
    expect(nextSidebarWorkspace("t3", -1)).toBe("hermes");
  });
});
