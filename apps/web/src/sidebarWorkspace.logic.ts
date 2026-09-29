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
