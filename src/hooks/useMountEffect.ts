"use client";

import { useEffect } from "react";

/** Explicit escape hatch for one mount/unmount synchronization boundary. */
export function useMountEffect(effect: () => void | (() => void)): void {
  useEffect(effect, []); // eslint-disable-line react-hooks/exhaustive-deps
}
