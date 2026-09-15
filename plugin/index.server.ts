import type { PluginServerContext } from "@getpaseo/plugin/server";

type ServerContribution = (server: PluginServerContext) => () => void;

/**
 * Server entry of the paseo-bm plugin.
 *
 * Skeleton only. WP-108 delivers the structure and the RPC contracts in
 * `shared/contracts.ts`; registering their handlers on `server` is the
 * deliverable of WP-112, so this entry registers nothing yet.
 *
 * This entry must never import from `client/`: that is a compile error.
 */
const contribute: ServerContribution = () => () => {};

export default contribute;
