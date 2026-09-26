"use client";

import { type CSSProperties, useState } from "react";
import { Button, Checkbox, Dialog, Icon, type IconName } from "@/components/ds";
import { type TranslationKey, key, useTranslation } from "@/lib/i18n";

/**
 * The warning shown before a link takes someone out of Ruchoir.
 *
 * A message is written by someone else, and a link in it goes wherever its author chose: the step
 * people get phished at is the page that opens next and asks for a password. So the destination is
 * the one thing drawn large, in a box of its own, with the full address under it; the advice is four
 * short lines read at a glance rather than a paragraph nobody reads. A host in punycode (`xn--`) is
 * called out, because that is how a look-alike domain written in another alphabet shows itself.
 *
 * It can be turned off, here with the box or in Preferences > Security, since a warning that shows
 * every time for someone who has read it is a warning nobody reads.
 */

const TIPS: { icon: IconName; text: TranslationKey }[] = [
  { icon: "search", text: key("externalLink.tipAddress") },
  { icon: "lock", text: key("externalLink.tipPassword") },
  { icon: "download", text: key("externalLink.tipFiles") },
  { icon: "message-square", text: key("externalLink.tipDoubt") },
];

const st: Record<string, CSSProperties> = {
  top: { display: "flex", gap: 20, alignItems: "center" },
  lead: { margin: 0, fontSize: 14, color: "var(--text-muted)" },
  destination: {
    marginTop: 8,
    padding: "12px 14px",
    borderRadius: "var(--radius-lg)",
    border: "1px solid var(--border-default)",
    background: "var(--surface-sunken)",
    minWidth: 0,
  },
  host: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 18,
    fontWeight: 600,
    color: "var(--text-strong)",
    overflowWrap: "anywhere",
  },
  url: {
    margin: "4px 0 0",
    fontSize: 12,
    fontFamily: "var(--font-mono)",
    color: "var(--text-muted)",
    overflowWrap: "anywhere",
    maxHeight: 54,
    overflowY: "auto",
  },
  section: {
    fontFamily: "var(--font-mono)",
    margin: "20px 0 8px",
    fontSize: 12,
    fontWeight: 500,
    color: "var(--text-muted)",
  },
  tips: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))",
    gap: 8,
    margin: 0,
    padding: 0,
    listStyle: "none",
  },
  tip: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    padding: "8px 10px",
    borderRadius: "var(--radius-md)",
    border: "1px solid var(--border-subtle)",
    fontSize: 13,
    lineHeight: 1.35,
    color: "var(--text-body)",
  },
  tipIcon: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    flex: "none",
    width: 28,
    height: 28,
    borderRadius: "var(--radius-full)",
    background: "var(--surface-sunken)",
    color: "var(--text-accent)",
  },
};

export function ExternalLinkDialog({
  url,
  onCancel,
  onOpen,
}: {
  url: string;
  onCancel: () => void;
  /** Open the link; `stopWarning` when the box asking never to be warned again was ticked. */
  onOpen: (stopWarning: boolean) => void;
}) {
  const { t } = useTranslation();
  const [stopWarning, setStopWarning] = useState(false);
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return url;
    }
  })();
  const lookAlike = host.split(".").some((label) => label.startsWith("xn--"));

  return (
    <Dialog
      title={t("externalLink.title")}
      closeLabel={t("common.close")}
      size="lg"
      onClose={onCancel}
      footer={
        <>
          <span style={{ marginRight: "auto" }}>
            <Checkbox
              label={t("externalLink.dontShowAgain")}
              checked={stopWarning}
              onChange={(e) => setStopWarning(e.target.checked)}
            />
          </span>
          <Button onClick={onCancel}>{t("common.cancel")}</Button>
          <Button variant="primary" autoFocus onClick={() => onOpen(stopWarning)}>
            {t("externalLink.open")}
          </Button>
        </>
      }
    >
      <div style={st.top}>
        {/* Decorative: everything it says is in the text next to it. A static export has no image
            optimiser, and a vector needs none. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/mascot-bee-alert.svg" alt="" width={112} height={103} style={{ flex: "none" }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <p style={st.lead}>{t("externalLink.lead")}</p>
          <div style={st.destination}>
            <div style={st.host}>
              <Icon name="globe" size={16} style={{ flex: "none", color: "var(--text-muted)" }} />
              {host}
            </div>
            <p style={st.url}>{url}</p>
          </div>
        </div>
      </div>

      {lookAlike ? (
        <p
          role="alert"
          style={{
            display: "flex",
            gap: 8,
            alignItems: "flex-start",
            margin: "14px 0 0",
            padding: "10px 12px",
            borderRadius: "var(--radius-md)",
            background: "var(--surface-sunken)",
            fontSize: 13,
            color: "var(--status-danger-fg)",
          }}
        >
          <Icon name="alert-triangle" size={16} style={{ flex: "none", marginTop: 1 }} />
          {t("externalLink.lookAlike")}
        </p>
      ) : null}

      <p style={st.section}>{t("externalLink.beforeOpening")}</p>
      <ul style={st.tips}>
        {TIPS.map((tip) => (
          <li key={tip.icon} style={st.tip}>
            <span style={st.tipIcon}>
              <Icon name={tip.icon} size={14} />
            </span>
            {t(tip.text)}
          </li>
        ))}
      </ul>
    </Dialog>
  );
}
