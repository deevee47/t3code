/** Pure helpers for the T3 / Hermes sidebar workspaces. */
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

export type SidebarWorkspace = "t3" | "hermes";

export const SIDEBAR_WORKSPACES: ReadonlyArray<SidebarWorkspace> = ["t3", "hermes"];
export const HERMES_DRIVER_KIND = ProviderDriverKind.make("hermes");
export const DEFAULT_HERMES_INSTANCE = ProviderInstanceId.make("hermes");

/** Instance ids backed by the Hermes driver. The default id counts before providers load. */
export function hermesInstanceIds(
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "driver">>,
): ReadonlySet<string> {
  const ids = new Set<string>([DEFAULT_HERMES_INSTANCE]);
  for (const provider of providers) {
    if (provider.driver === HERMES_DRIVER_KIND) ids.add(provider.instanceId);
  }
  return ids;
}

export function threadBelongsToWorkspace(
  thread: { readonly modelSelection: { readonly instanceId: string } },
  workspace: SidebarWorkspace,
  hermesIds: ReadonlySet<string>,
): boolean {
  return hermesIds.has(thread.modelSelection.instanceId) === (workspace === "hermes");
}

export function nextSidebarWorkspace(
  workspace: SidebarWorkspace,
  direction: 1 | -1,
): SidebarWorkspace {
  const index = SIDEBAR_WORKSPACES.indexOf(workspace);
  const count = SIDEBAR_WORKSPACES.length;
  return SIDEBAR_WORKSPACES[(index + direction + count) % count]!;
}

export function workspaceOfThread(
  thread: { readonly modelSelection: { readonly instanceId: string } },
  hermesIds: ReadonlySet<string>,
): SidebarWorkspace {
  return hermesIds.has(thread.modelSelection.instanceId) ? "hermes" : "t3";
}

export interface RememberedThread {
  readonly environmentId: string;
  readonly threadId: string;
}

interface LandingCandidate {
  readonly id: string;
  readonly environmentId: string;
  readonly modelSelection: { readonly instanceId: string };
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/**
 * The thread to show after switching to `workspace`: the one last open there if it
 * still exists, else its most recently updated thread, else none (the new-thread view).
 */
export function resolveWorkspaceLandingThread<T extends LandingCandidate>(input: {
  readonly threads: ReadonlyArray<T>;
  readonly workspace: SidebarWorkspace;
  readonly hermesIds: ReadonlySet<string>;
  readonly remembered: RememberedThread | undefined;
}): T | null {
  const candidates = input.threads.filter(
    (thread) =>
      thread.archivedAt === null && workspaceOfThread(thread, input.hermesIds) === input.workspace,
  );
  const remembered = input.remembered;
  const previous = remembered
    ? candidates.find(
        (thread) =>
          thread.id === remembered.threadId && thread.environmentId === remembered.environmentId,
      )
    : undefined;
  if (previous) return previous;
  let newest: T | null = null;
  for (const thread of candidates) {
    if (newest === null || thread.updatedAt > newest.updatedAt) newest = thread;
  }
  return newest;
}

/** Travel, in pixels, before a gesture locks to an axis. */
const AXIS_LOCK_DISTANCE_PX = 10;

/**
 * Locks a swipe to one axis from its accumulated travel. Sideways wins only when clearly
 * dominant, so a vertical scroll that drifts never switches workspace.
 */
export function resolveGestureAxis(
  sumX: number,
  sumY: number,
): "pending" | "horizontal" | "vertical" {
  if (Math.abs(sumX) + Math.abs(sumY) < AXIS_LOCK_DISTANCE_PX) return "pending";
  return Math.abs(sumX) > Math.abs(sumY) * 1.6 ? "horizontal" : "vertical";
}
