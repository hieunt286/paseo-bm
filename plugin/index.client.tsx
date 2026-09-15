import type { PluginClientContext } from "@getpaseo/plugin/client";

type ClientContribution = (client: PluginClientContext) => () => void;

/**
 * Client entry of the paseo-bm plugin.
 *
 * Skeleton only. The sidebar item, Command Center item and workspace panel
 * described in docs/design/paseo-bm.md §2.4 are the deliverable of WP-113, so
 * this entry registers nothing yet.
 *
 * This entry must never import from `server/`: that is a compile error.
 */
const contribute: ClientContribution = () => () => {};

export default contribute;
