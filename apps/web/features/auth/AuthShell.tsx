"use client";

import { type ReactNode } from "react";
import { useTranslation } from "@/lib/i18n";
import { AuthPreview } from "./AuthPreview";

function Brand({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  return (
    <div className={`wc-auth__brand${compact ? " wc-auth__brand--compact" : ""}`}>
      <div className="wc-auth__brand-row">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/brand/ruchoir-mark.png" alt="" className="wc-auth__mark" />
        <span className="wc-auth__wordmark">
          Ruchoir<span style={{ color: "var(--brand)" }}>.</span>
        </span>
      </div>
      <div className="wc-auth__tagline">{t("brand.tagline")}</div>
    </div>
  );
}

/**
 * Shared layout of every authentication screen. On a wide screen it is two halves: a showcase on
 * the left (the brand, a drawn preview of the app, where the data lives) and the form on the right,
 * on the plain surface. Below 900px the showcase folds into a compact brand header over the form
 * (rules in components.css, under `.wc-auth`).
 */
export function AuthShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="wc-auth">
      <aside className="wc-auth__aside">
        <Brand />
        <AuthPreview />
        <div className="wc-auth__hosting">{t("login.hosting")}</div>
      </aside>
      <div className="wc-auth__side">
        <Brand compact />
        <main className="wc-auth__form">{children}</main>
        {footer ? <div className="wc-auth__footer">{footer}</div> : null}
        <div className="wc-auth__hosting wc-auth__hosting--compact">{t("login.hosting")}</div>
      </div>
    </div>
  );
}
