/**
 * Draws the blocks from `markdown.ts` with React Native primitives.
 * Colours come from the theme; sizes from the Dashboard styles.
 */
import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { Text, View } from "react-native";
import { parseMarkdown, type Inline, type MarkdownBlock } from "./markdown";

type Theme = PluginSurfaceProps["theme"];

const MONO = "Menlo";

function Spans({ spans, theme, size, weight }: { spans: Inline[]; theme: Theme; size: number; weight?: "600" | "700" }) {
  return (
    <Text style={{ color: theme.colors.foreground, fontSize: size, lineHeight: size * 1.45, fontWeight: weight }} selectable>
      {spans.map((span, index) => (
        <Text
          key={index}
          style={
            span.code
              ? { fontFamily: MONO, fontSize: size - 1, backgroundColor: theme.colors.surface2, color: theme.colors.foreground }
              : { fontWeight: span.bold ? "700" : weight, fontStyle: span.italic ? "italic" : "normal" }
          }
        >
          {span.text}
        </Text>
      ))}
    </Text>
  );
}

function Block({ block, theme, size }: { block: MarkdownBlock; theme: Theme; size: number }) {
  switch (block.kind) {
    case "heading":
      return (
        <View style={{ marginTop: block.level <= 2 ? 10 : 6 }}>
          <Spans spans={block.spans} theme={theme} size={size + Math.max(0, 6 - block.level * 1.5)} weight="700" />
        </View>
      );
    case "paragraph":
      return <Spans spans={block.spans} theme={theme} size={size} />;
    case "bullet":
    case "numbered": {
      const marker =
        block.kind === "numbered" ? `${block.number}.` : block.checked === undefined ? "•" : block.checked ? "☑" : "☐";
      return (
        <View style={{ flexDirection: "row", gap: 6, paddingLeft: block.depth * 14 }}>
          <Text style={{ color: theme.colors.foregroundMuted, fontSize: size, lineHeight: size * 1.45, minWidth: 14 }}>
            {marker}
          </Text>
          <View style={{ flex: 1 }}>
            <Spans spans={block.spans} theme={theme} size={size} />
          </View>
        </View>
      );
    }
    case "quote":
      return (
        <View style={{ borderLeftWidth: 3, borderLeftColor: theme.colors.border, paddingLeft: 8 }}>
          <Spans spans={block.spans} theme={theme} size={size} />
        </View>
      );
    case "code":
      return (
        <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 6, padding: 8 }}>
          <Text style={{ fontFamily: MONO, fontSize: size - 1, color: theme.colors.foreground }} selectable>
            {block.text}
          </Text>
        </View>
      );
    case "table":
      return (
        <View style={{ borderWidth: 1, borderColor: theme.colors.border, borderRadius: 6 }}>
          {[block.header, ...block.rows].map((row, rowIndex) => (
            <View
              key={rowIndex}
              style={{
                flexDirection: "row",
                borderTopWidth: rowIndex === 0 ? 0 : 1,
                borderTopColor: theme.colors.border,
                backgroundColor: rowIndex === 0 ? theme.colors.surface2 : "transparent",
              }}
            >
              {row.map((cell, cellIndex) => (
                <View key={cellIndex} style={{ flex: 1, padding: 6 }}>
                  <Text
                    style={{ color: theme.colors.foreground, fontSize: size - 1, fontWeight: rowIndex === 0 ? "600" : "400" }}
                    selectable
                  >
                    {cell}
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    case "rule":
      return <View style={{ height: 1, backgroundColor: theme.colors.border, marginVertical: 4 }} />;
  }
}

export function MarkdownView({ source, theme, compact }: { source: string; theme: Theme; compact: boolean }) {
  const size = compact ? 12 : 14;
  return (
    <View style={{ gap: 6 }}>
      {parseMarkdown(source).map((block, index) => (
        <Block key={index} block={block} theme={theme} size={size} />
      ))}
    </View>
  );
}
