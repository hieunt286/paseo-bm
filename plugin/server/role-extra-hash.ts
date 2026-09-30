/**
 * The hash of one role's Additional instructions, as `orchestrator.apply-suggestion`
 * compares it (Orchestrator design §7): lowercase hex sha256 of the text's
 * UTF-8 bytes.
 *
 * Computed on the server only. The client runs on react-native-web, where
 * `node:crypto` does not exist, so it never hashes: it takes `hash` from the
 * read that showed it the text (`roles.instructions`) or from the previous
 * `orchestrator.apply-suggestion`, and sends it back unchanged as `expectedHash`.
 */
import { createHash } from "node:crypto";

export function extraHashOf(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
