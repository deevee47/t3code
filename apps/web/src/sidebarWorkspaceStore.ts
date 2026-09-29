/**
 * Sidebar workspaces: "t3" lists every non-Hermes thread, "hermes" lists Hermes
 * threads only. Switching also moves the new-thread default to that workspace's
 * provider and restores the previous default on the way back.
 */
import { HERMES_DEFAULT_MODEL, type ProviderInstanceId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { useAtomValue } from "@effect/atom-react";
import { useLocation, useParams, useRouter } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { useComposerDraftStore as composerDraftStore } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";
import {
  DEFAULT_HERMES_INSTANCE,
  HERMES_DRIVER_KIND,
  hermesInstanceIds,
  type RememberedThread,
  resolveWorkspaceLandingThread,
  type SidebarWorkspace,
  threadBelongsToWorkspace,
  workspaceOfThread,
} from "./sidebarWorkspace.logic";
import { useThreadShells } from "./state/entities";
import { primaryServerProvidersAtom } from "./state/server";

interface SidebarWorkspaceState {
  readonly workspace: SidebarWorkspace;
  /** The T3 workspace's new-thread provider, restored when leaving Hermes. */
  readonly t3StickyProvider: ProviderInstanceId | null;
  /** The thread last open in each workspace, reopened when switching back. */
  readonly lastThreadByWorkspace: Partial<Record<SidebarWorkspace, RememberedThread>>;
  readonly setWorkspace: (
    workspace: SidebarWorkspace,
    hermesInstanceId: ProviderInstanceId,
  ) => void;
  readonly rememberThread: (workspace: SidebarWorkspace, thread: RememberedThread) => void;
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
      lastThreadByWorkspace: {},
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
      rememberThread: (workspace, thread) => {
        const current = get().lastThreadByWorkspace[workspace];
        if (
          current?.threadId === thread.threadId &&
          current.environmentId === thread.environmentId
        ) {
          return;
        }
        set((state) => ({
          lastThreadByWorkspace: { ...state.lastThreadByWorkspace, [workspace]: thread },
        }));
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
        lastThreadByWorkspace: state.lastThreadByWorkspace,
      }),
    },
  ),
);

/** Hermes instance ids known to the primary server. */
export function useHermesInstanceIds(): ReadonlySet<string> {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(() => hermesInstanceIds(providers), [providers]);
}

function useHermesDefaultInstanceId(): ProviderInstanceId {
  const providers = useAtomValue(primaryServerProvidersAtom);
  return useMemo(
    () =>
      providers.find((provider) => provider.driver === HERMES_DRIVER_KIND && provider.enabled)
        ?.instanceId ?? DEFAULT_HERMES_INSTANCE,
    [providers],
  );
}

function useRouteThread(): RememberedThread | null {
  const params = useParams({ strict: false }) as Partial<
    Record<"environmentId" | "threadId", string>
  >;
  return useMemo(
    () =>
      params.environmentId && params.threadId
        ? { environmentId: params.environmentId, threadId: params.threadId }
        : null,
    [params.environmentId, params.threadId],
  );
}

/**
 * Switches workspace and, on chat pages, opens that workspace's thread so the main
 * content matches the sidebar. Other pages, such as settings, stay where they are.
 */
export function useSwitchSidebarWorkspace(): (workspace: SidebarWorkspace) => void {
  const router = useRouter();
  const threads = useThreadShells();
  const hermesIds = useHermesInstanceIds();
  const hermesInstanceId = useHermesDefaultInstanceId();
  const setWorkspace = useSidebarWorkspaceStore((state) => state.setWorkspace);
  const routeThread = useRouteThread();
  const pathname = useLocation({ select: (location) => location.pathname });
  const onChatPage = routeThread !== null || pathname === "/" || pathname.startsWith("/draft/");
  return useCallback(
    (workspace: SidebarWorkspace) => {
      setWorkspace(workspace, hermesInstanceId);
      if (!onChatPage) return;
      const open = routeThread
        ? threads.find(
            (thread) =>
              thread.id === routeThread.threadId &&
              thread.environmentId === routeThread.environmentId,
          )
        : undefined;
      if (open && workspaceOfThread(open, hermesIds) === workspace) return;
      const landing = resolveWorkspaceLandingThread({
        threads,
        workspace,
        hermesIds,
        remembered: useSidebarWorkspaceStore.getState().lastThreadByWorkspace[workspace],
      });
      void (landing
        ? router.navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId: landing.environmentId, threadId: landing.id },
          })
        : router.navigate({ to: "/" }));
    },
    [hermesIds, hermesInstanceId, onChatPage, routeThread, router, setWorkspace, threads],
  );
}

/**
 * Keeps the sidebar on the workspace of the open thread, and remembers it as that
 * workspace's last thread. Runs when the route or the thread's provider changes, so a
 * switch that is still navigating is not undone.
 */
export function useWorkspaceFollowsRoute(): void {
  const threads = useThreadShells();
  const hermesIds = useHermesInstanceIds();
  const hermesInstanceId = useHermesDefaultInstanceId();
  const routeThread = useRouteThread();
  const open = routeThread
    ? threads.find(
        (thread) =>
          thread.id === routeThread.threadId && thread.environmentId === routeThread.environmentId,
      )
    : undefined;
  const owner = open ? workspaceOfThread(open, hermesIds) : null;
  useEffect(() => {
    if (!routeThread || !owner) return;
    const store = useSidebarWorkspaceStore.getState();
    store.rememberThread(owner, routeThread);
    if (store.workspace !== owner) store.setWorkspace(owner, hermesInstanceId);
  }, [hermesInstanceId, owner, routeThread]);
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
