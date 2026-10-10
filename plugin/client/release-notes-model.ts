import { RELEASE_NOTES, type ReleaseNote } from "./release-notes.generated";

export const RELEASE_TAG_URL = "https://github.com/hieunt286/paseo-bm/releases/tag";

export interface ReleaseNotesView {
  notes: readonly ReleaseNote[];
  selected: ReleaseNote | null;
  /** The selected note's version; a prerelease folded into a stable resolves to that stable. */
  selectedVersion: string | null;
  /** "Includes 0.3.0-alpha.0, …" for a stable that folds prereleases; null otherwise. */
  includes: string | null;
  /** "In the full note: What changed · Rollback"; null when the note has no sections. */
  sections: string | null;
  sourceUrl: string;
  missing: boolean;
}

export function releaseNotesView(
  installedVersion: string | null,
  latestVersion: string | null,
  requestedVersion: string | null,
  notes: readonly ReleaseNote[] = RELEASE_NOTES,
): ReleaseNotesView {
  const preferred = requestedVersion ?? latestVersion ?? installedVersion ?? notes[0]?.version ?? null;
  const selected = preferred === null
    ? null
    : notes.find((note) => note.version === preferred) ?? notes.find((note) => note.prereleases.includes(preferred)) ?? null;
  const selectedVersion = selected?.version ?? preferred;
  const fallbackVersion = preferred ?? "latest";
  return {
    notes,
    selected,
    selectedVersion,
    includes: selected === null || selected.prereleases.length === 0 ? null : `Includes ${selected.prereleases.join(", ")}`,
    sections: selected === null || selected.sections.length === 0 ? null : `In the full note: ${selected.sections.join(" · ")}`,
    sourceUrl: selected?.gitUrl ?? `${RELEASE_TAG_URL}/v${fallbackVersion}`,
    missing: selected === null,
  };
}
