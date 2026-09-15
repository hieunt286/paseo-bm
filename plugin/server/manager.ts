/**
 * Manager lifecycle on the daemon side: find the live Manager of a workspace by
 * its `bm.role=manager` label through the Paseo SDK, create one when there is
 * none, and read the agent list the panel draws.
 *
 * Empty in WP-108 by design — the behaviour is the deliverable of WP-112.
 */
export {};
