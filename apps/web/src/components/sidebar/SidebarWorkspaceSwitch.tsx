import { memo, useEffect, useRef } from "react";

import { cn } from "../../lib/utils";
import { nextSidebarWorkspace, resolveGestureAxis } from "../../sidebarWorkspace.logic";
import {
  useSidebarWorkspaceStore,
  useSwitchSidebarWorkspace,
  useWorkspaceFollowsRoute,
} from "../../sidebarWorkspaceStore";
import workspaceLogoUrl from "./workspace-logo.png";

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

type GesturePhase = "idle" | "deciding" | "horizontal" | "vertical" | "committed";

/**
 * Two-finger trackpad swipes and horizontal touch swipes switch workspace.
 *
 * Each gesture locks to an axis within its first few pixels. Vertical gestures are left
 * to native scrolling untouched; horizontal ones move the thread list with the fingers,
 * then either slide it out and switch or spring it back. Frames are written straight to
 * the element's style, so dragging never re-renders React.
 *
 * Returns a ref for the thread list; the whole sidebar around it listens for the swipe.
 */
export function useSidebarWorkspaceSwipe<T extends HTMLElement>() {
  const workspace = useSidebarWorkspaceStore((state) => state.workspace);
  const switchWorkspace = useSwitchSidebarWorkspace();
  const ref = useRef<T | null>(null);
  // Latest switch without re-attaching listeners whenever threads change.
  const switchRef = useRef<(direction: 1 | -1) => void>(() => {});
  useEffect(() => {
    switchRef.current = (direction) =>
      switchWorkspace(
        nextSidebarWorkspace(useSidebarWorkspaceStore.getState().workspace, direction),
      );
  }, [switchWorkspace]);
  const enterFromRef = useRef<1 | -1 | null>(null);
  // The slide-out holds its end frame until the slide-in replaces it.
  const exitAnimationRef = useRef<Animation | null>(null);
  const previousWorkspace = useRef(workspace);

  useEffect(() => {
    const list = ref.current;
    if (!list) return;
    // Move the whole viewport: the scroll area root clips it, so dragging never adds
    // horizontal overflow or scrolls the list sideways.
    const moving =
      list.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? (list as HTMLElement);
    const surface = list.closest<HTMLElement>('[data-sidebar="sidebar"]') ?? moving;
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

    let phase: GesturePhase = "idle";
    let sumX = 0;
    let sumY = 0;
    let offset = 0;
    let frame = 0;
    let gestureEnd: ReturnType<typeof setTimeout> | undefined;
    let running: Animation | undefined;

    const paint = () => {
      frame = 0;
      moving.style.transform = offset === 0 ? "" : `translate3d(${offset}px, 0, 0)`;
      moving.style.opacity = offset === 0 ? "" : String(1 - Math.min(Math.abs(offset) / 260, 0.45));
    };
    const schedulePaint = () => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };
    const settle = (keyframes: Keyframe[], duration: number, fill: FillMode = "none") => {
      running?.cancel();
      running = moving.animate(keyframes, {
        duration: reducedMotion.matches ? 0 : duration,
        easing: "cubic-bezier(0.2, 0, 0, 1)",
        fill,
      });
      return running;
    };
    const release = () => {
      if (phase === "horizontal" && offset !== 0) {
        const from = offset;
        offset = 0;
        paint();
        void settle(
          [
            {
              transform: `translate3d(${from}px, 0, 0)`,
              opacity: 1 - Math.min(Math.abs(from) / 260, 0.45),
            },
            { transform: "translate3d(0, 0, 0)", opacity: 1 },
          ],
          160,
        );
      }
      phase = "idle";
      sumX = 0;
      sumY = 0;
    };
    const commit = (direction: 1 | -1) => {
      phase = "committed";
      const from = offset;
      offset = 0;
      paint();
      enterFromRef.current = direction;
      const exit = settle(
        [
          {
            transform: `translate3d(${from}px, 0, 0)`,
            opacity: 1 - Math.min(Math.abs(from) / 260, 0.45),
          },
          { transform: `translate3d(${-direction * 72}px, 0, 0)`, opacity: 0 },
        ],
        110,
        "forwards",
      );
      running = undefined; // the slide-in, not the next gesture, releases it
      exitAnimationRef.current = exit;
      void exit.finished
        .catch(() => undefined)
        .then(() => {
          switchRef.current(direction);
          // If nothing switched, never leave the list hidden.
          setTimeout(() => exit.cancel(), 400);
        });
    };

    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey) return; // pinch zoom
      clearTimeout(gestureEnd);
      gestureEnd = setTimeout(release, 140);
      // The rest of a committed swipe's momentum is ignored.
      if (phase === "vertical" || phase === "committed") return;
      sumX += event.deltaX;
      sumY += event.deltaY;
      if (phase === "idle" || phase === "deciding") {
        const axis = resolveGestureAxis(sumX, sumY);
        phase = axis === "pending" ? "deciding" : axis;
        if (phase !== "horizontal") return;
      }
      // Fingers moving left scroll right (positive deltaX): pull the list left, towards the next workspace.
      offset = Math.max(-96, Math.min(96, -sumX * 0.5));
      schedulePaint();
      if (Math.abs(sumX) >= 110) commit(sumX > 0 ? 1 : -1);
    };

    let touchStart: { x: number; y: number } | null = null;
    const onTouchStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      touchStart =
        event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY } : null;
      phase = "idle";
    };
    const onTouchMove = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (!touchStart || !touch || phase === "vertical" || phase === "committed") return;
      sumX = touchStart.x - touch.clientX;
      sumY = touchStart.y - touch.clientY;
      if (phase === "idle" || phase === "deciding") {
        const axis = resolveGestureAxis(sumX, sumY);
        phase = axis === "pending" ? "deciding" : axis;
        if (phase !== "horizontal") return;
      }
      offset = Math.max(-96, Math.min(96, -sumX * 0.6));
      schedulePaint();
    };
    const onTouchEnd = () => {
      touchStart = null;
      if (phase === "horizontal" && Math.abs(sumX) >= 70) commit(sumX > 0 ? 1 : -1);
      else release();
      if (phase === "committed") phase = "idle";
    };

    // Passive, so vertical scrolling never waits on this handler. There is nothing to
    // prevent: the viewport has no horizontal overflow inside its clipping root.
    surface.addEventListener("wheel", onWheel, { passive: true });
    surface.addEventListener("touchstart", onTouchStart, { passive: true });
    surface.addEventListener("touchmove", onTouchMove, { passive: true });
    surface.addEventListener("touchend", onTouchEnd);
    surface.addEventListener("touchcancel", onTouchEnd);
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("touchstart", onTouchStart);
      surface.removeEventListener("touchmove", onTouchMove);
      surface.removeEventListener("touchend", onTouchEnd);
      surface.removeEventListener("touchcancel", onTouchEnd);
      clearTimeout(gestureEnd);
      cancelAnimationFrame(frame);
      running?.cancel();
      moving.style.transform = "";
      moving.style.opacity = "";
    };
  }, []);

  // After any switch (swipe, click or palette), slide the new list in.
  useEffect(() => {
    if (previousWorkspace.current === workspace) return;
    previousWorkspace.current = workspace;
    const list = ref.current;
    const moving = list?.closest<HTMLElement>('[data-slot="scroll-area-viewport"]') ?? list;
    const direction = enterFromRef.current ?? 1;
    enterFromRef.current = null;
    exitAnimationRef.current?.cancel();
    exitAnimationRef.current = null;
    if (!moving || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    moving.animate(
      [
        { transform: `translate3d(${direction * 72}px, 0, 0)`, opacity: 0 },
        { transform: "translate3d(0, 0, 0)", opacity: 1 },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, [workspace]);

  return { ref };
}
