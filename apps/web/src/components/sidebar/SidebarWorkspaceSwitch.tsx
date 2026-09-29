import { memo, useCallback, useEffect, useRef } from "react";
import type * as React from "react";

import { cn } from "../../lib/utils";
import { nextSidebarWorkspace } from "../../sidebarWorkspace.logic";
import {
  useSidebarWorkspaceStore,
  useSwitchSidebarWorkspace,
  useWorkspaceFollowsRoute,
} from "../../sidebarWorkspaceStore";
import workspaceLogoUrl from "./workspace-logo.png";

/** Horizontal travel, in pixels, that commits one switch. */
const SWIPE_THRESHOLD_PX = 60;
/** A pause this long between wheel events ends the gesture, including trackpad momentum. */
const GESTURE_GAP_MS = 220;
const SLIDE_DURATION_MS = 180;

const WORKSPACE_LOGO_MASK = {
  maskImage: `url(${workspaceLogoUrl})`,
  maskSize: "contain",
  maskRepeat: "no-repeat",
  maskPosition: "center",
} as const;

/**
 * `T3 Code | logo` next to the sidebar brand. The logo toggles between the T3 and
 * Hermes workspaces and is lit while Hermes is active. The button is exactly the
 * logo's size, so the gaps on either side of the bar match.
 */
export const SidebarWorkspaceSwitch = memo(function SidebarWorkspaceSwitch() {
  const workspace = useSidebarWorkspaceStore((state) => state.workspace);
  const switchWorkspace = useSwitchSidebarWorkspace();
  useWorkspaceFollowsRoute();
  const hermesActive = workspace === "hermes";
  return (
    <div className="relative z-10 ml-2.5 flex shrink-0 items-center gap-2.5">
      <span aria-hidden className="h-4 w-px bg-border" />
      <button
        type="button"
        aria-pressed={hermesActive}
        aria-label={hermesActive ? "Switch to T3 workspace" : "Switch to Hermes workspace"}
        onClick={() => switchWorkspace(hermesActive ? "t3" : "hermes")}
        className={cn(
          "size-[1.125rem] shrink-0 rounded-sm outline-hidden ring-ring ring-offset-2 ring-offset-sidebar transition-colors focus-visible:ring-2",
          hermesActive ? "text-foreground" : "text-muted-foreground/60 hover:text-foreground",
        )}
      >
        {/* A mask, so the logo takes the text color in light and dark themes. */}
        <span aria-hidden className="block size-full bg-current" style={WORKSPACE_LOGO_MASK} />
      </button>
    </div>
  );
});

/**
 * Two-finger horizontal swipes (trackpad) and horizontal touch swipes switch
 * workspace, one switch per gesture. Returns props for the thread list element,
 * which slides in from the swipe direction after each switch.
 */
export function useSidebarWorkspaceSwipe<T extends HTMLElement>() {
  const workspace = useSidebarWorkspaceStore((state) => state.workspace);
  const switchWorkspace = useSwitchSidebarWorkspace();
  const ref = useRef<T | null>(null);
  const wheel = useRef({ accumulated: 0, locked: false, lastEventAt: -Infinity });
  const touchStart = useRef<{ x: number; y: number } | null>(null);
  const lastDirection = useRef<1 | -1>(1);
  const previousWorkspace = useRef(workspace);

  const commit = useCallback(
    (direction: 1 | -1) => {
      lastDirection.current = direction;
      switchWorkspace(nextSidebarWorkspace(workspace, direction));
    },
    [switchWorkspace, workspace],
  );

  useEffect(() => {
    if (previousWorkspace.current === workspace) return;
    previousWorkspace.current = workspace;
    const element = ref.current;
    if (!element || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    element.animate(
      [
        { transform: `translateX(${lastDirection.current * 24}px)`, opacity: 0.35 },
        { transform: "translateX(0)", opacity: 1 },
      ],
      { duration: SLIDE_DURATION_MS, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [workspace]);

  const onWheel = useCallback(
    (event: React.WheelEvent<T>) => {
      if (Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      const gesture = wheel.current;
      if (event.timeStamp - gesture.lastEventAt > GESTURE_GAP_MS) {
        gesture.accumulated = 0;
        gesture.locked = false;
      }
      gesture.lastEventAt = event.timeStamp;
      if (gesture.locked) return;
      gesture.accumulated += event.deltaX;
      if (Math.abs(gesture.accumulated) < SWIPE_THRESHOLD_PX) return;
      gesture.locked = true;
      // Fingers moving left scroll right (positive deltaX) and reveal the next workspace.
      commit(gesture.accumulated > 0 ? 1 : -1);
    },
    [commit],
  );

  const onTouchStart = useCallback((event: React.TouchEvent<T>) => {
    const touch = event.touches[0];
    touchStart.current =
      event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
  }, []);

  const onTouchEnd = useCallback(
    (event: React.TouchEvent<T>) => {
      const start = touchStart.current;
      const touch = event.changedTouches[0];
      touchStart.current = null;
      if (!start || !touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dx) < SWIPE_THRESHOLD_PX || Math.abs(dx) < Math.abs(dy) * 2) return;
      commit(dx < 0 ? 1 : -1);
    },
    [commit],
  );

  return { ref, onWheel, onTouchStart, onTouchEnd };
}
