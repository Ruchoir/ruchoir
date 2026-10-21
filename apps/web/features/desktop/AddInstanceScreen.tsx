"use client";

import { type FormEvent, useState } from "react";
import { Button, Field, Input } from "@/components/ds";
import { AuthShell } from "@/features/auth/AuthShell";
import { authStyles } from "@/features/auth/authStyles";
import { useTranslation } from "@/lib/i18n";
import { instanceAdd } from "@/lib/desktop/bridge";

/** The codes `instance_add` answers with, each with its own sentence. */
const KNOWN_ERRORS = ["empty", "not_https", "has_path", "has_credentials", "invalid", "unreachable", "not_ruchoir", "outdated", "already_added"] as const;

/**
 * The first screen of the desktop app: the address of a Ruchoir instance. The app checks it answers
 * as an instance able to give an app its own session before keeping it.
 */
export function AddInstanceScreen({ onAdded, onCancel }: { onAdded?: () => void; onCancel?: () => void }) {
  const { t } = useTranslation();
  const [address, setAddress] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      await instanceAdd(address);
      onAdded?.();
    } catch (code) {
      const known = KNOWN_ERRORS.find((k) => k === code);
      setError(known ? t(`desktop.add.errors.${known}`) : t("desktop.add.errors.other"));
    } finally {
      setPending(false);
    }
  };

  return (
    <AuthShell>
      <h1 style={authStyles.title}>{t("desktop.add.title")}</h1>
      <p style={authStyles.subtitle}>{t("desktop.add.subtitle")}</p>
      <form style={authStyles.fields} onSubmit={submit}>
        <Field label={t("desktop.add.address")} htmlFor="dk-address">
          <Input
            id="dk-address"
            size="lg"
            icon="globe"
            autoFocus
            autoComplete="url"
            inputMode="url"
            placeholder={t("desktop.add.placeholder")}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
          />
        </Field>
        {error ? (
          <p style={authStyles.error} role="alert">
            {error}
          </p>
        ) : null}
        <Button variant="primary" size="lg" fullWidth type="submit" disabled={pending || !address.trim()}>
          {pending ? t("common.verifying") : t("onboarding.continue")}
        </Button>
        {onCancel ? (
          <Button variant="ghost" size="lg" fullWidth type="button" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
        ) : null}
      </form>
    </AuthShell>
  );
}
