import { describe, expect, it } from "vite-plus/test";

import { pendingApprovalsFromActivities, threadCliStatus } from "./threadFormat.ts";

const idle = {
  session: null,
  latestTurn: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  settledAt: null,
};

describe("threadCliStatus", () => {
  it("reports the most urgent state first", () => {
    expect(threadCliStatus({ ...idle, hasPendingApprovals: true, hasPendingUserInput: true })).toBe(
      "needs-approval",
    );
    expect(threadCliStatus({ ...idle, hasPendingUserInput: true })).toBe("needs-input");
    expect(
      threadCliStatus({ ...idle, session: { status: "running" } as never, settledAt: "x" }),
    ).toBe("working");
    expect(threadCliStatus({ ...idle, settledAt: "2026-09-29T00:00:00.000Z" })).toBe("settled");
    expect(threadCliStatus(idle)).toBe("idle");
  });
});

describe("pendingApprovalsFromActivities", () => {
  it("keeps requests that were not resolved, oldest first", () => {
    const approvals = pendingApprovalsFromActivities([
      { kind: "approval.requested", payload: { requestId: "b", detail: "rm" }, createdAt: "2" },
      { kind: "approval.requested", payload: { requestId: "a" }, createdAt: "1" },
      { kind: "approval.resolved", payload: { requestId: "c" }, createdAt: "0" },
      { kind: "approval.requested", payload: { requestId: "c" }, createdAt: "3" },
      { kind: "approval.requested", payload: { requestId: "d" }, createdAt: "4" },
      { kind: "approval.resolved", payload: { requestId: "d" }, createdAt: "5" },
    ]);
    expect(approvals.map((approval) => [approval.requestId, approval.detail])).toEqual([
      ["a", undefined],
      ["b", "rm"],
    ]);
  });
});
