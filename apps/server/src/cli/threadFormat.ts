/** Plain-text views of threads for `t3 thread`, written to be read by people and agents. */
import type {
  ApprovalRequestId,
  OrchestrationMessage,
  OrchestrationProjectShell,
  OrchestrationThreadActivity,
  OrchestrationThreadShell,
} from "@t3tools/contracts";

export type ThreadCliStatus =
  | "needs-approval"
  | "needs-input"
  | "working"
  | "error"
  | "settled"
  | "idle";

type ThreadStatusInput = Pick<
  OrchestrationThreadShell,
  "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput" | "settledAt"
>;

/** One word describing what the thread needs, most urgent first. */
export function threadCliStatus(thread: ThreadStatusInput): ThreadCliStatus {
  if (thread.hasPendingApprovals) return "needs-approval";
  if (thread.hasPendingUserInput) return "needs-input";
  const sessionStatus = thread.session?.status;
  if (
    sessionStatus === "running" ||
    sessionStatus === "starting" ||
    thread.latestTurn?.state === "running"
  ) {
    return "working";
  }
  if (sessionStatus === "error") return "error";
  return thread.settledAt ? "settled" : "idle";
}

export function isThreadBusy(status: ThreadCliStatus): boolean {
  return status === "working";
}

export interface CliPendingApproval {
  readonly requestId: ApprovalRequestId;
  readonly detail: string | undefined;
  readonly createdAt: string;
}

/** Open approval requests, oldest first. Mirrors the client's pending-request derivation. */
export function pendingApprovalsFromActivities(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload" | "createdAt">>,
): ReadonlyArray<CliPendingApproval> {
  const open = new Map<string, CliPendingApproval>();
  const closed = new Set<string>();
  for (const activity of activities) {
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as Record<string, unknown>)
        : undefined;
    const requestId = typeof payload?.requestId === "string" ? payload.requestId : undefined;
    if (!payload || !requestId) continue;
    if (activity.kind === "approval.requested") {
      if (closed.has(requestId) || payload.requestType === "tool_user_input") continue;
      open.set(requestId, {
        requestId: requestId as ApprovalRequestId,
        detail: typeof payload.detail === "string" && payload.detail ? payload.detail : undefined,
        createdAt: activity.createdAt,
      });
    } else if (activity.kind === "approval.resolved") {
      closed.add(requestId);
      open.delete(requestId);
    }
  }
  return [...open.values()].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

export function formatThreadList(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "title">>,
): string {
  if (threads.length === 0) return "No threads.";
  const projectTitles = new Map(projects.map((project) => [project.id, project.title]));
  return threads
    .map((thread) =>
      [
        thread.id.padEnd(36),
        threadCliStatus(thread).padEnd(14),
        thread.modelSelection.instanceId.padEnd(12),
        oneLine(projectTitles.get(thread.projectId) ?? "?", 24).padEnd(24),
        oneLine(thread.title, 70),
      ].join("  "),
    )
    .join("\n");
}

export function formatMessage(message: Pick<OrchestrationMessage, "role" | "text" | "createdAt">) {
  return `--- ${message.role} · ${message.createdAt}\n${message.text.trim()}`;
}

export function toPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
