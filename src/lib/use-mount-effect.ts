import { useEffect } from "react";

/** Set up and tear down one browser integration for the lifetime of a component. */
export function useMountEffect(effect: () => void | (() => void)): void {
  useEffect(effect, []); // eslint-disable-line react-hooks/exhaustive-deps
}
