import { Trash2Icon } from "lucide-react";
import { memo } from "react";
import type * as React from "react";

import { cn } from "../../lib/utils";
import { toastManager } from "../ui/toast";
import { SidebarMenuButton, SidebarMenuItem } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Footer trash icon. It hides while a drag shows the full tray in its place. */
export const SidebarTrashIcon = memo(function SidebarTrashIcon(props: { dragging: boolean }) {
  return (
    <SidebarMenuItem className={cn("shrink-0 transition-opacity", props.dragging && "opacity-0")}>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              aria-label="Trash"
              size="icon"
              onClick={() =>
                toastManager.add({
                  type: "info",
                  title: "Drag a thread here to delete it",
                  description: "Dropping a thread on the trash deletes it permanently.",
                })
              }
            >
              <Trash2Icon />
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">Trash: drop a thread here to delete it</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
});

/**
 * The drop tray that grows out of the footer while a thread is dragged. It overlays
 * the footer instead of taking layout space, so the list never shifts mid-drag.
 */
export const SidebarTrashTray = memo(function SidebarTrashTray({
  dragging,
  hovered,
  ref,
}: {
  readonly dragging: boolean;
  readonly hovered: boolean;
  readonly ref: React.Ref<HTMLDivElement>;
}) {
  return (
    <div
      ref={ref}
      aria-hidden={!dragging}
      className={cn(
        "pointer-events-none absolute inset-x-[var(--sidebar-content-inset)] bottom-1 z-20 flex h-24 origin-[40%_100%] flex-col overflow-hidden items-center justify-center gap-1.5 rounded-xl border text-xs font-medium",
        "transition-[opacity,transform,background-color,border-color,box-shadow,color] duration-200 ease-[cubic-bezier(0.2,0,0,1)]",
        dragging ? "scale-100 opacity-100" : "scale-[0.15] opacity-0",
        hovered
          ? "border-destructive/70 bg-sidebar text-destructive shadow-[0_14px_36px_-10px_rgb(0_0_0/0.7),0_0_0_4px_color-mix(in_oklab,var(--destructive)_18%,transparent)]"
          : "border-sidebar-border bg-sidebar shadow-[0_14px_36px_-12px_rgb(0_0_0/0.65),0_2px_6px_rgb(0_0_0/0.25)] text-sidebar-muted-foreground",
      )}
    >
      {/* Tint over a solid base, so the footer never shows through the tray. */}
      <span
        aria-hidden
        className={cn(
          "absolute inset-0 bg-destructive/15 transition-opacity duration-200",
          hovered ? "opacity-100" : "opacity-0",
        )}
      />
      <Trash2Icon
        aria-hidden
        className={cn(
          "relative size-6 transition-transform duration-200",
          hovered && "-rotate-6 scale-110",
        )}
      />
      <span className="relative">
        {hovered ? "Release to delete permanently" : "Drop here to delete"}
      </span>
    </div>
  );
});
