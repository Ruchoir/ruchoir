"use client";

import { type CSSProperties, useMemo, useRef, useState } from "react";
import { Icon, Input, Popover } from "@/components/ds";
import { highlightCode, listLanguages } from "./highlight";
import { useTranslation } from "@/lib/i18n";

export type CodeBlockProps = {
  code: string;
  /** Language declared after the opening fence, if any. */
  declaredLang?: string;
  /** Whether the current user may correct the language (their own messages). */
  editable?: boolean;
};

const pickerPanel: CSSProperties = {
  width: 240,
  background: "var(--surface-canvas)",
  border: "1px solid var(--border-subtle)",
  borderRadius: "var(--radius-md)",
  boxShadow: "var(--shadow-popover)",
  overflow: "hidden",
};

/** A fenced code block: header (language + copy) and highlighted body. Language is editable. */
export function CodeBlock({ code, declaredLang, editable }: CodeBlockProps) {
  const { t } = useTranslation();
  const [chosen, setChosen] = useState<string | undefined>(declaredLang);
  const [copied, setCopied] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [query, setQuery] = useState("");
  const langRef = useRef<HTMLButtonElement>(null);

  const { html, language } = useMemo(() => highlightCode(code, chosen), [code, chosen]);
  const displayLang = (chosen && chosen !== "auto" ? chosen : language) ?? "texte";

  const languages = useMemo(() => listLanguages(), []);
  const hits = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? languages.filter((l) => l.includes(q)).slice(0, 60) : languages;
  }, [query, languages]);

  const copy = () => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  const pick = (lang: string) => {
    setChosen(lang);
    setPickerOpen(false);
    setQuery("");
  };

  return (
    <div className="wc-codeblock">
      <div className="wc-codebar">
        {editable ? (
          <button
            ref={langRef}
            type="button"
            className="wc-codelang wc-codelang--edit"
            onClick={() => setPickerOpen((o) => !o)}
            aria-expanded={pickerOpen}
            title={t("code.changeLanguage")}
          >
            {displayLang}
            <Icon name="chevron-down" size={12} />
          </button>
        ) : (
          <span className="wc-codelang">{displayLang}</span>
        )}
        <button type="button" className="wc-codecopy" onClick={copy} aria-label={t("code.copy")}>
          <Icon name={copied ? "check" : "copy"} size={13} />
          {copied ? t("common.copied") : t("admin.copy")}
        </button>
      </div>
      <pre>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>

      {editable ? (
        <Popover anchorRef={langRef} open={pickerOpen} onClose={() => setPickerOpen(false)} placement="bottom" align="start">
          <div style={pickerPanel}>
            <div style={{ padding: 8, borderBottom: "1px solid var(--border-subtle)" }}>
              <Input size="sm" icon="search" placeholder={t("code.languagePlaceholder")} value={query} onChange={(e) => setQuery(e.target.value)} autoFocus />
            </div>
            <div style={{ maxHeight: 240, overflowY: "auto", padding: 4 }} role="listbox">
              <button type="button" onClick={() => pick("auto")} style={langItem(chosen === "auto" || !chosen)}>
                {t("code.autoDetect")}
              </button>
              {hits.map((l) => (
                <button key={l} type="button" onClick={() => pick(l)} style={langItem(chosen === l)}>
                  {l}
                </button>
              ))}
            </div>
          </div>
        </Popover>
      ) : null}
    </div>
  );
}

function langItem(active: boolean): CSSProperties {
  return {
    display: "block",
    width: "100%",
    padding: "5px 8px",
    border: 0,
    borderRadius: "var(--radius-sm)",
    background: active ? "var(--surface-selected)" : "transparent",
    color: active ? "var(--text-accent)" : "var(--text-body)",
    fontFamily: "var(--font-mono)",
    fontSize: 12,
    textAlign: "left",
    cursor: "pointer",
  };
}
