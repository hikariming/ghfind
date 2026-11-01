/**
 * Astro island entry points live one per file in this directory: Astro loads
 * an island by importing its module, so a shared module would make every page
 * download every island's code. Each wraps an existing React component from
 * the Next app (`src/components`) in `IslandRoot`, so it runs unchanged through
 * the next-intl / navigation shims.
 */
import type { IslandIntl } from "./IslandRoot";

/** Props every island takes: its own props plus the serialized route/messages. */
export type WithIntl<P = object> = P & { intl: IslandIntl };

/** A shared view's props minus the translator the island supplies itself. */
export type WithoutT<C extends (props: never) => unknown> = Omit<Parameters<C>[0], "t">;
