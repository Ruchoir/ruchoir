"use client";

import { type CSSProperties, useState } from "react";
import { EmptyState, Input } from "@/components/ds";
import { EMOJI_CATEGORIES, QUICK_REACTIONS, searchEmojis } from "@/lib/emoji";
import { Emoji } from "../app/Emoji";
import { useTranslation } from "@/lib/i18n";

const panel: CSSProperties = {
  width: 320,
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-lg)",
  boxShadow: "var(--shadow-popover)",
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

const quickRow: CSSProperties = {
  display: "flex",
  gap: 4,
  padding: "8px 8px 6px",
  borderBottom: "1px solid var(--border-subtle)",
};

const tabsRow: CSSProperties = {
  display: "flex",
  gap: 2,
  padding: "6px 8px",
  borderBottom: "1px solid var(--border-subtle)",
  overflowX: "auto",
};

const grid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(8, 1fr)",
  gap: 2,
  padding: 8,
  height: 220,
  overflowY: "auto",
  alignContent: "start",
};

const emojiBtn: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  width: 34,
  height: 34,
  border: 0,
  borderRadius: "var(--radius-sm)",
  background: "transparent",
  fontSize: 20,
  lineHeight: 1,
  cursor: "pointer",
};

function hoverIn(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = "var(--surface-hover)";
}
function hoverOut(e: React.MouseEvent<HTMLButtonElement>) {
  e.currentTarget.style.background = "transparent";
}

export function EmojiPicker({
  onPick,
  animated = false,
}: {
  onPick: (emoji: string) => void;
  /** Animate the pickable glyphs (quick row + grid). Set when the picker chooses a reaction. */
  animated?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState(EMOJI_CATEGORIES[0].id);

  const results = query.trim() ? searchEmojis(query) : null;
  const active = EMOJI_CATEGORIES.find((c) => c.id === cat) ?? EMOJI_CATEGORIES[0];
  const shown = results ?? active.emojis;

  return (
    <div style={panel} role="dialog" aria-label={t("emoji.title")}>
      <div style={quickRow}>
        {QUICK_REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            style={{ ...emojiBtn, width: 36, height: 36, fontSize: 22 }}
            onMouseEnter={hoverIn}
            onMouseLeave={hoverOut}
            onClick={() => onPick(e)}
            aria-label={t("message.reactWith", { emoji: e })}
          >
            <Emoji emoji={e} size={22} animated={animated} />
          </button>
        ))}
      </div>

      <div style={{ padding: 8 }}>
        <Input
          size="sm"
          icon="search"
          placeholder={t("emoji.search")}
          value={query}
          onChange={(ev) => setQuery(ev.target.value)}
          autoFocus
        />
      </div>

      {!results ? (
        <div style={tabsRow}>
          {EMOJI_CATEGORIES.map((c) => (
            <button
              key={c.id}
              type="button"
              title={t(c.label)}
              aria-label={t(c.label)}
              aria-pressed={c.id === cat}
              onClick={() => setCat(c.id)}
              style={{
                ...emojiBtn,
                width: 30,
                height: 30,
                fontSize: 17,
                background: c.id === cat ? "var(--surface-active)" : "transparent",
              }}
            >
              <Emoji emoji={c.icon} size={17} />
            </button>
          ))}
        </div>
      ) : null}

      <div style={grid}>
        {shown.length === 0 ? (
          <div style={{ gridColumn: "1 / -1" }}>
            <EmptyState size="compact" icon="smile" title={t("emoji.empty")} description={t("switcher.noMatch", { query })} />
          </div>
        ) : (
          shown.map((em) => (
            <button
              key={em}
              type="button"
              style={emojiBtn}
              onMouseEnter={hoverIn}
              onMouseLeave={hoverOut}
              onClick={() => onPick(em)}
              // The character itself: a screen reader announces an emoji with its own name, in the
              // language it is reading in, which no keyword of ours can do in six languages.
              aria-label={em}
            >
              <Emoji emoji={em} size={20} animated={animated} />
            </button>
          ))
        )}
      </div>
    </div>
  );
}
