import { useEffect, useRef, useState } from "react";
import { Box, Input, Text } from "@zenbu-labs/pixel";
import type { NodeHandle } from "@zenbu-labs/pixel";
import { Icon } from "./icons";
import type { IconName } from "./icons";
import { displayUrl } from "../url";
import type { Theme } from "./theme";
import type { ChromeActions, ChromeLayout, NewTabSuggestion, NewTabView, PaletteView } from "./types";

export function Backdrop({ layout, onClose }: { layout: ChromeLayout; onClose(): void }) {
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: 0, left: 0 },
        width: layout.width,
        height: layout.height,
      }}
      onClick={onClose}
    />
  );
}


function lastRowRadius(last: boolean, rem: number) {
  if (!last) return undefined;
  const radius = Math.max(2, rem * 0.55 - 1);
  return { topLeft: 0, topRight: 0, bottomLeft: radius, bottomRight: radius };
}

function ModalCard({
  layout,
  theme,
  width,
  onClose,
  children,
}: {
  layout: ChromeLayout;
  theme: Theme;
  width: number;
  onClose(): void;
  children: React.ReactNode;
}) {
  return (
    <>
      <Backdrop layout={layout} onClose={onClose} />
      <Box
        style={{
          position: "absolute",
          inset: { top: layout.toolbarHeight + layout.rem * 1.2, left: (layout.width - width) / 2 },
          width,
          flexDirection: "column",
          background: theme.overlay,
          cornerRadius: layout.rem * 0.55,
          border: { width: 1, color: theme.fieldBorder },
          overflow: "hidden",
        }}
        onClick={() => {}}
      >
        {children}
      </Box>
    </>
  );
}

export function PaletteCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: PaletteView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 26, layout.width - rem * 4);
  const rowH = rem * 2;
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.paletteClose}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          padding: { left: rem * 0.85, right: rem * 0.85 },
          border: { bottom: [1, theme.hairline] },
        }}
      >
        <Input
          ref={input}
          autoFocus
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={(text) => actions.paletteQuery(text)}
        />
      </Box>
      <Box style={{ flexDirection: "column" }}>
        {view.items.length === 0 && (
          <Text
            style={{
              padding: { left: rem * 0.85, top: rem * 0.35, bottom: rem * 0.35 },
              fontSize: rem * 0.92,
              color: theme.muted,
              selectable: false,
            }}
          >
            No matching actions
          </Text>
        )}
        {view.items.map((item, i) => (
          <Box
            key={item.id}
            style={{
              height: rowH,
              alignItems: "center",
              gap: rem * 0.55,
              padding: { left: rem * 0.85, right: rem * 0.85 },
              background: i === view.index ? theme.hover : undefined,
              hoverBackground: theme.hover,
              cornerRadius: lastRowRadius(i === view.items.length - 1, rem),
            }}
            onClick={() => actions.paletteRun(i)}
          >
            <Text
              style={{
                flexGrow: 1,
                flexBasis: 0,
                fontSize: rem * 0.95,
                wrap: false,
                selectable: false,
              }}
            >
              {item.label}
            </Text>
            <Text
              style={{ fontSize: rem * 0.82, color: theme.muted, wrap: false, selectable: false }}
            >
              {item.shortcut}
            </Text>
          </Box>
        ))}
      </Box>
    </ModalCard>
  );
}

export function NewTabCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: NewTabView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const cardW = Math.min(rem * 34, layout.width - rem * 4);
  const input = useRef<NodeHandle | null>(null);
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <ModalCard layout={layout} theme={theme} width={cardW} onClose={actions.newTabCancel}>
      <Box
        style={{
          height: rem * 2.4,
          alignItems: "center",
          gap: rem * 0.5,
          padding: { left: rem * 0.85, right: rem * 0.85 },
          border: view.suggestions.length ? { bottom: [1, theme.hairline] } : undefined,
        }}
      >
        <Icon icon="search" size={rem} color={theme.muted} />
        <Input
          ref={input}
          autoFocus
          style={{ flexGrow: 1, flexBasis: 0, wrap: false, fontSize: rem }}
          caretColor={theme.accent}
          selectionColor={theme.selection}
          onChange={(text) => actions.newTabQuery(text)}
        />
      </Box>
      <SuggestionRows
        view={view}
        width={cardW}
        rem={rem}
        theme={theme}
        onPick={(index) => actions.newTabPick(index)}
      />
    </ModalCard>
  );
}


export function UrlSuggestionsCard({
  view,
  actions,
  layout,
  theme,
}: {
  view: NewTabView;
  actions: ChromeActions;
  layout: ChromeLayout;
  theme: Theme;
}) {
  const rem = layout.rem;
  const width = Math.min(rem * 36, layout.width - rem);
  return (
    <Box
      style={{
        position: "absolute",
        inset: { top: layout.toolbarHeight, left: rem * 0.5 },
        width,
        flexDirection: "column",
        background: theme.overlay,
        cornerRadius: rem * 0.55,
        border: { width: 1, color: theme.fieldBorder },
        overflow: "hidden",
      }}
      onClick={() => {}}
    >
      <SuggestionRows view={view} width={width} rem={rem} theme={theme} onPick={(index) => actions.urlPick(index)} />
    </Box>
  );
}

function suggestionIcon(suggestion: NewTabSuggestion): IconName {
  if (suggestion.kind === "app") return "terminal";
  if (suggestion.kind === "page") return "clock";
  return "search";
}

function suggestionKey(suggestion: NewTabSuggestion, index: number): string {
  if (suggestion.kind === "app") return `app:${suggestion.id}`;
  if (suggestion.kind === "page") return `page:${suggestion.url}`;
  return `${index}:${suggestion.text}`;
}

function SuggestionRows({
  view,
  width,
  rem,
  theme,
  onPick,
}: {
  view: NewTabView;
  width: number;
  rem: number;
  theme: Theme;
  onPick(index: number): void;
}) {
  if (view.suggestions.length === 0) return null;
  const rowH = rem * 2;
  const maxChars = Math.floor((width - rem * 3.15) / (rem * 0.95 * 0.6));
  const clip = (text: string, chars: number) =>
    text.length > chars ? `${text.slice(0, Math.max(0, chars - 1)).trimEnd()}…` : text;
  return (
    <Box style={{ flexDirection: "column" }}>
      {view.suggestions.map((suggestion, i) => {
        const selected = i === view.index;
        const page = suggestion.kind === "page" ? suggestion : null;
        const text =
          suggestion.kind === "app"
            ? suggestion.name
            : suggestion.kind === "page"
              ? suggestion.title || displayUrl(suggestion.url)
              : suggestion.text;
        const shown = clip(text, page?.title ? Math.floor(maxChars * 0.55) : maxChars);
        const address = page?.title ? clip(displayUrl(page.url), maxChars - shown.length - 2) : "";
        return (
          <Box
            key={suggestionKey(suggestion, i)}
            style={{
              height: rowH,
              alignItems: "center",
              gap: rem * 0.6,
              padding: { left: rem * 0.85, right: rem * 0.85 },
              background: selected ? theme.hover : undefined,
              hoverBackground: theme.hover,
              cornerRadius: lastRowRadius(i === view.suggestions.length - 1, rem),
            }}
            onClick={() => onPick(i)}
          >
            <Icon icon={suggestionIcon(suggestion)} size={rem * 0.8} color={theme.disabled} />
            <Text
              style={{
                flexShrink: 1,
                fontSize: rem * 0.95,
                color: selected ? theme.fg : theme.muted,
                wrap: false,
                selectable: false,
                overflow: "hidden",
              }}
            >
              {shown}
            </Text>
            {address && (
              <Text
                style={{
                  flexGrow: 1,
                  flexBasis: 0,
                  flexShrink: 1,
                  fontSize: rem * 0.8,
                  color: theme.disabled,
                  wrap: false,
                  selectable: false,
                  overflow: "hidden",
                }}
              >
                {address}
              </Text>
            )}
          </Box>
        );
      })}
    </Box>
  );
}
