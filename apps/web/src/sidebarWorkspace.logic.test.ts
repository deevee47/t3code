import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  hermesInstanceIds,
  nextSidebarWorkspace,
  resolveWorkspaceLandingThread,
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

describe("resolveWorkspaceLandingThread", () => {
  const ids = new Set(["hermes"]);
  const shell = (
    id: string,
    instanceId: string,
    updatedAt: string,
    archivedAt: string | null = null,
  ) => ({
    id,
    environmentId: "env",
    modelSelection: { instanceId },
    updatedAt,
    archivedAt,
  });
  const threads = [
    shell("t3-old", "codex", "2026-09-01"),
    shell("t3-new", "claudeAgent", "2026-09-03"),
    shell("h-old", "hermes", "2026-09-02"),
    shell("h-new", "hermes", "2026-09-04"),
    shell("h-archived", "hermes", "2026-09-05", "2026-09-05"),
  ];

  it("returns to the thread last open in that workspace", () => {
    const landing = resolveWorkspaceLandingThread({
      threads,
      workspace: "hermes",
      hermesIds: ids,
      remembered: { environmentId: "env", threadId: "h-old" },
    });
    expect(landing?.id).toBe("h-old");
  });

  it("falls back to the newest open thread of the workspace", () => {
    expect(
      resolveWorkspaceLandingThread({
        threads,
        workspace: "hermes",
        hermesIds: ids,
        remembered: { environmentId: "env", threadId: "t3-new" },
      })?.id,
    ).toBe("h-new");
    expect(
      resolveWorkspaceLandingThread({
        threads,
        workspace: "t3",
        hermesIds: ids,
        remembered: undefined,
      })?.id,
    ).toBe("t3-new");
  });

  it("shows the new-thread view when the workspace has no threads", () => {
    expect(
      resolveWorkspaceLandingThread({
        threads: threads.filter((thread) => thread.modelSelection.instanceId !== "hermes"),
        workspace: "hermes",
        hermesIds: ids,
        remembered: undefined,
      }),
    ).toBeNull();
  });
});
