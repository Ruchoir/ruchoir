"use client";

import { useEffect, useState } from "react";
import { useTranslation } from "@/lib/i18n";

type Health = {
  status: string;
  service: string;
  version: string;
};

type Probe =
  | { state: "loading" }
  | { state: "ok"; health: Health }
  | { state: "error"; message: string };

// i18n-audit-ignore-file -- an operator page, not part of the product's interface: it answers
// "is the API serving the bundle" and is read in English like the rest of the repository.

/**
 * Status page. Exercises the full path end to end: a static asset served by the Rust API
 * calls the API's own health endpoint. Kept while the app shell takes over /.
 */
export default function Status() {
  const { t } = useTranslation();
  const [probe, setProbe] = useState<Probe>({ state: "loading" });

  useEffect(() => {
    let active = true;
    fetch("/api/v1/health")
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<Health>;
      })
      .then((health) => active && setProbe({ state: "ok", health }))
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : "unreachable";
        if (active) setProbe({ state: "error", message });
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-8 px-6">
      <header className="flex items-center gap-3">
        <span className="inline-block h-3 w-3 rounded-full bg-terracotta-500" />
        <h1 className="text-2xl font-semibold tracking-tight">Ruchoir</h1>
      </header>

      <p className="text-neutral-600">
        Sovereign, open-core workspace: real-time team messaging and file sharing.
        This placeholder confirms the Rust API is serving the static web bundle.
      </p>

      <section
        className="rounded-lg border border-neutral-200 bg-neutral-50 p-4 font-mono text-sm"
        aria-live="polite"
      >
        {probe.state === "loading" && <span>{t("status.checking")}</span>}
        {probe.state === "ok" && (
          <span>
            API {probe.health.status} · {probe.health.service} v{probe.health.version}
          </span>
        )}
        {probe.state === "error" && (
          <span className="text-terracotta-700">API unreachable: {probe.message}</span>
        )}
      </section>

      <nav className="flex gap-4 text-sm">
        <a className="underline underline-offset-2" href="/docs/">
          API reference
        </a>
        <a className="underline underline-offset-2" href="/api/openapi.json">
          OpenAPI document
        </a>
      </nav>
    </main>
  );
}
