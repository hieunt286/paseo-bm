/**
 * The block reader lives in `shared/bm-report.ts`, where the chat cards read it
 * too. This module was a copy of it that had to change in step; it now only
 * re-exports it, so the server and the client can never read a block differently.
 */
export * from "../shared/bm-report";
