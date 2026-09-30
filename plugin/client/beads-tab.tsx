/**
 * The "Beads" tab of a workspace (delta 20260918e §4.1, REQ-060 a–c): the
 * workspace panel Paseo lists in the "+" menu of the tab bar — the dropdown on
 * desktop and the "New tab" screen on mobile.
 *
 * It is the workspace's project page of Work (autonomy design §A.12,
 * experience concept §3): Requests · Beads · Agents, opened on Beads. A
 * workspace panel cannot open the Beads Manager surface, so the page is drawn
 * here, without a back button or a title: the tab already lives in its
 * workspace. Its data stays in the React Query cache under Work's keys, so the
 * surface and the tab share one read.
 *
 * Client rules: React Native primitives only, colours from `theme.colors`, no
 * Node import, no `server/` import.
 */
import type { PluginWorkspacePanelProps } from "@getpaseo/plugin/client";
import { BEADS_TAB_INITIAL } from "./surface-view";
import { ProjectPage } from "./work";

export function BeadsTabPanel(props: PluginWorkspacePanelProps) {
  return <ProjectPage {...props} label={null} initialTab={BEADS_TAB_INITIAL} />;
}
