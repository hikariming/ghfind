"use client";

import type { ComponentProps } from "react";
import { Group, Panel, Separator as ResizeSeparator } from "react-resizable-panels";
import { cn } from "@/lib/utils";

function ResizablePanelGroup({ className, ...props }: ComponentProps<typeof Group>) {
  return <Group className={cn("flex h-full w-full", className)} {...props} />;
}

function ResizablePanel(props: ComponentProps<typeof Panel>) {
  return <Panel {...props} />;
}

function ResizableHandle({ className, ...props }: ComponentProps<typeof ResizeSeparator>) {
  return (
    <ResizeSeparator
      className={cn("w-px bg-border data-[separator]:bg-border", className)}
      {...props}
    />
  );
}

export { ResizablePanelGroup, ResizablePanel, ResizableHandle };
