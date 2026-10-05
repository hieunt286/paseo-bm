import { RELEASE_NOTES, type ReleaseNote } from "./release-notes.generated";

export const RELEASE_TAG_URL = "https://github.com/hieunt286/paseo-bm/releases/tag";

export interface ReleaseNotesView {
  notes: readonly ReleaseNote[];
  selected: ReleaseNote | null;
  selectedVersion: string | null;
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
  const selected = preferred === null ? null : notes.find((note) => note.version === preferred) ?? null;
  const fallbackVersion = preferred ?? "latest";
  return {
    notes,
    selected,
    selectedVersion: preferred,
    sourceUrl: selected?.gitUrl ?? `${RELEASE_TAG_URL}/v${fallbackVersion}`,
    missing: selected === null,
  };
}
