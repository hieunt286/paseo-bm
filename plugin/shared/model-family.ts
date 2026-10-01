/**
 * The model family a role runs on (autonomy design §C.5, §C.6; REQ-133): the
 * vendor of its model. Claude Code is Anthropic and Codex is OpenAI; any other
 * base provider takes the vendor prefix of its model id (`openai/gpt-5` →
 * `openai`), else the base provider id itself.
 *
 * One rule for both places that ask: `ensureRoles` (`server/setup-roles.ts`),
 * which creates a new Reviewer on a family other than the Worker's, and
 * Settings → Agents (`client/settings-roles-model.ts`), which says when the
 * two are the same.
 *
 * Pure: no import at all.
 */

/** The base providers whose family does not depend on the model. */
const PROVIDER_FAMILIES: ReadonlyMap<string, string> = new Map([
  ["claude", "anthropic"],
  ["codex", "openai"],
]);

/**
 * The family of `model` on `baseProvider`, lower case, or `null` when it
 * cannot be told: no base provider, a `bm-*` role alias instead of one, or a
 * provider other than Claude Code and Codex with no model to read.
 */
export function modelFamily(baseProvider: string | null | undefined, model: string | null | undefined): string | null {
  const provider = typeof baseProvider === "string" ? baseProvider.trim().toLowerCase() : "";
  if (provider === "" || provider.startsWith("bm-")) return null;
  const known = PROVIDER_FAMILIES.get(provider);
  if (known !== undefined) return known;
  const id = typeof model === "string" ? model.trim() : "";
  if (id === "") return null;
  const slash = id.indexOf("/");
  const prefix = slash > 0 ? id.slice(0, slash).trim().toLowerCase() : "";
  return prefix === "" ? provider : prefix;
}
