/**
 * Sidebar workspaces: "t3" lists every non-Hermes thread, "hermes" lists Hermes
 * threads only. Switching also moves the new-thread default to that workspace's
 * provider and restores the previous default on the way back.
 */
import { HERMES_DEFAULT_MODEL, type ProviderInstanceId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useComposerDraftStore as composerDraftStore } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";
import {
  DEFAULT_HERMES_INSTANCE,
  HERMES_DRIVER_KIND,
  hermesInstanceIds,
  type SidebarWorkspace,
  threadBelongsToWorkspace,
} from "./sidebarWorkspace.logic";
import { useThreadShells } from "./state/entities";
import { primaryServerProvidersAtom } from "./state/server";

interface SidebarWorkspaceState {
  readonly workspace: SidebarWorkspace;
  /** The T3 workspace's new-thread provider, restored when leaving Hermes. */
  readonly t3StickyProvider: ProviderInstanceId | null;
  readonly setWorkspace: (
    workspace: SidebarWorkspace,
    hermesInstanceId: ProviderInstanceId,
  ) => void;
}

function moveNewThreadDefault(
  workspace: SidebarWorkspace,
  hermesInstanceId: ProviderInstanceId,
  t3StickyProvider: ProviderInstanceId | null,
) {
  const drafts = composerDraftStore.getState();
  if (workspace === "hermes") {
    drafts.setStickyModelSelection(
      drafts.stickyModelSelectionByProvider[hermesInstanceId] ?? {
        instanceId: hermesInstanceId,
        model: HERMES_DEFAULT_MODEL,
      },
    );
    return;
  }
  if (t3StickyProvider === null) return;
  const selection = drafts.stickyModelSelectionByProvider[t3StickyProvider];
  if (selection) drafts.setStickyModelSelection(selection);
  else composerDraftStore.setState({ stickyActiveProvider: t3StickyProvider });
}

export const useSidebarWorkspaceStore = create<SidebarWorkspaceState>()(
  persist(
    (set, get) => ({
      workspace: "t3",
      t3StickyProvider: null,
      setWorkspace: (workspace, hermesInstanceId) => {
        const current = get();
        if (current.workspace === workspace) return;
        const t3StickyProvider =
          workspace === "hermes"
            ? composerDraftStore.getState().stickyActiveProvider
            : current.t3StickyProvider;
        moveNewThreadDefault(workspace, hermesInstanceId, t3StickyProvider);
        set({ workspace, t3StickyProvider });
      },
    }),
    {
      name: "t3code:sidebar-workspace:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({
        workspace: state.workspace,
        t3StickyProvider: state.t3StickyProvider,
      }),
    },
  ),
);

/** Hermes instance ids known to the primary server. */
export function useHermesInstanceIds(): ReadonlySet<string> {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(() => hermesInstanceIds(providers), [providers]);
}

/** Switches workspace, routing Hermes defaults to the first Hermes instance. */
export function useSwitchSidebarWorkspace(): (workspace: SidebarWorkspace) => void {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const setWorkspace = useSidebarWorkspaceStore((state) => state.setWorkspace);
  return useMemo(() => {
    const hermesInstanceId =
      providers.find((provider) => provider.driver === HERMES_DRIVER_KIND && provider.enabled)
        ?.instanceId ?? DEFAULT_HERMES_INSTANCE;
    return (workspace: SidebarWorkspace) => setWorkspace(workspace, hermesInstanceId);
  }, [providers, setWorkspace]);
}

/** Thread shells for the active sidebar workspace. */
export function useWorkspaceThreadShells(): ReadonlyArray<EnvironmentThreadShell> {
  const threads = useThreadShells();
  const workspace = useSidebarWorkspaceStore((state) => state.workspace);
  const hermesIds = useHermesInstanceIds();
  return useMemo(
    () => threads.filter((thread) => threadBelongsToWorkspace(thread, workspace, hermesIds)),
    [threads, workspace, hermesIds],
  );
}
