/**
 * What the screens say about a failed RPC: the server's own message and its
 * registry code (`E_…`), without the daemon's wrapping. Moved from
 * `launch-manager.ts` and `chat-card-decision.ts` (code review 2026-09-30
 * §3.6); every screen reads a failure through these.
 *
 * Pure: no React, no React Native, no `server/` import.
 */

const ERROR_CODE_PATTERN = /^\s*(E_[A-Z0-9_]+)\b/;

/** The daemon's wrapping of a failed plugin RPC, around the server's own message. */
const RPC_FAILED_PREFIX = /^\s*Request failed:\s*/;
const RPC_ERROR_SUFFIX = /\s+requestType=\S+(?:\s+code=\S+)?\s*$/;

/**
 * The server's own message of a failed RPC. In the app a plugin RPC error
 * reaches the client as `@getpaseo/client`'s `DaemonRpcError`, whose message is
 * `Request failed: <message> requestType=<type> code=<code>`; the wrapping is
 * the daemon's, not ours, and says nothing to the user.
 */
function serverMessageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(RPC_FAILED_PREFIX, "").replace(RPC_ERROR_SUFFIX, "").trim();
}

/**
 * Registry code at the start of the server's message (`E_PROVIDER_UNAVAILABLE: ...`),
 * or null when the server sent none.
 */
export function errorCodeOf(error: unknown): string | null {
  return ERROR_CODE_PATTERN.exec(serverMessageOf(error))?.[1] ?? null;
}

/** The server's message, code included; `withoutCode` drops the code where it is shown apart. */
export function errorMessageOf(error: unknown): string {
  return serverMessageOf(error) || "Unknown error";
}

/**
 * `message` without its leading registry code, for a line that already names
 * the code; `""` when the message is the code alone.
 */
export function withoutCode(message: string): string {
  return message.replace(/^\s*E_[A-Z0-9_]+\s*:?\s*/, "").trim();
}

/** `(<code>). <rest>`, or `(<code>).` when the server sent the code alone. */
export function codedTail(code: string, message: string): string {
  const rest = withoutCode(message);
  return rest === "" ? `(${code}).` : `(${code}). ${rest}`;
}

/** Codes and messages of a failed RPC, in front: `(<code>): <message>`. */
export function codedReason(error: unknown): string {
  const code = errorCodeOf(error);
  const message = errorMessageOf(error);
  if (code === null) return `: ${message}`;
  const rest = withoutCode(message);
  return rest === "" ? ` (${code})` : ` (${code}): ${rest}`;
}
