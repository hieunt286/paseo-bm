/**
 * The flag `/bm-worker-new` puts on the first line of the message it sends.
 *
 * It lives in `shared/` because both halves need it and neither may import the
 * other: the client writes the flag, the server's collector takes it back off.
 *
 * It is a flag on the USER's words, not a notice of the plugin's own, so it is
 * deliberately absent from `isPluginNotice`. Listing it there would make the
 * collector record the whole message as `origin: "agent"` and the Dashboard
 * would lose the request text itself (delta 20260917f §4.1).
 */

export const NEW_REQUEST_MARKER = "BM-NEW-REQUEST";

/** The user's words, with the flag line removed if it carried one. */
export function stripNewRequestMarker(text: string): string {
  if (!text.startsWith(NEW_REQUEST_MARKER)) return text;
  const newline = text.indexOf("\n");
  return newline === -1 ? "" : text.slice(newline + 1).replace(/^\s+/, "");
}
