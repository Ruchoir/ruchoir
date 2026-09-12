import { type CSSProperties, type ReactNode, useEffect, useState } from "react";
import { Button, Dialog, Field, Icon, Input, Tag } from "@/components/ds";
import {
  changePassword,
  confirmTotp,
  disableTotp,
  enrollTotp,
  generateRecoveryCodes,
  getMfaState,
  logoutEverywhere,
  registerPasskey,
  removePasskey,
  type MfaState,
} from "@/lib/data/api";
import { apiErrorCode, isApiError } from "@/lib/data/http";
import { isPasskeySupported } from "@/lib/webauthn";
import type { Toast } from "./types";
import { useTranslation } from "@/lib/i18n";

/**
 * Account security, wired to the account rather than to this browser.
 *
 * Everything here used to live in local storage: enabling two-factor authentication set a flag,
 * the recovery codes were computed in the page from a counter, and the passkeys were invented
 * entries. Someone reading the screen came away believing their account was protected.
 *
 * One source now, `GET /auth/mfa`, re-read after every change. Nothing on screen is derived from
 * what happened in this tab: the answer to "am I protected" is the server's.
 */

const row: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: "14px 0",
  borderBottom: "1px solid var(--border-subtle)",
};

function Row({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children?: ReactNode }) {
  return (
    <div style={row}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: "var(--text-strong)" }}>{title}</div>
        {desc ? (
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2, maxWidth: 520 }}>{desc}</div>
        ) : null}
      </div>
      {children}
    </div>
  );
}

/**
 * The codes, shown once and never again.
 *
 * Displayed in a monospaced grid because they are transcribed by hand as often as copied, and a
 * proportional font turns a zero into an O at exactly the wrong moment.
 */
function RecoveryCodes({ codes, onNotify }: { codes: string[]; onNotify?: (t: Toast) => void }) {
  const { t } = useTranslation();
  return (
    <>
      <p style={{ fontSize: 13, color: "var(--text-body)", lineHeight: "var(--leading-normal)" }}>
        {t("security.recoveryKeep")}
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))",
          gap: 8,
          margin: "14px 0",
          padding: 12,
          borderRadius: "var(--radius-md)",
          background: "var(--surface-sunken)",
          fontFamily: "var(--font-mono)",
          fontSize: 13,
          color: "var(--text-strong)",
        }}
      >
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <Button
        size="sm"
        iconLeft="copy"
        onClick={() => {
          void navigator.clipboard?.writeText(codes.join("\n"));
          onNotify?.({ tone: "success", title: t("security.codesCopied") });
        }}
      >
        {t("admin.copy")}
      </Button>
    </>
  );
}

type OpenDialog = "totp" | "disable" | "recovery" | "password" | null;

export function AccountSecuritySection({
  onNotify,
  onSignedOut,
}: {
  onNotify?: (t: Toast) => void;
  /** Called when every session has ended, so the app returns to the sign-in screen. */
  onSignedOut?: () => void;
}) {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<MfaState | null>(null);
  const [open, setOpen] = useState<OpenDialog>(null);
  const [busy, setBusy] = useState(false);

  // Enrolment, held only while its dialog is open: the secret behind the QR is useless once
  // confirmed, and keeping it around would be keeping a second copy of a secret for no reason.
  const [enrolment, setEnrolment] = useState<{ otpauthUrl: string; qrSvg: string } | null>(null);
  const [code, setCode] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    getMfaState()
      .then((next) => active && setState(next))
      .catch(() => {
        // Left as unknown rather than guessed at: the rows say "…" until the account answers.
      });
    return () => {
      active = false;
    };
  }, [reload]);
  const refresh = () => setReload((n) => n + 1);

  const close = () => {
    setOpen(null);
    setEnrolment(null);
    setCode("");
    setCodes(null);
    setPassword("");
    setNewPassword("");
    setError(null);
    setBusy(false);
  };

  const startTotp = () => {
    setOpen("totp");
    setBusy(true);
    enrollTotp()
      .then((next) => {
        setEnrolment(next);
        setBusy(false);
      })
      .catch(() => {
        close();
        onNotify?.({ tone: "danger", title: t("security.setupFailed"), description: t("common.tryAgain") });
      });
  };

  const finishTotp = () => {
    setBusy(true);
    setError(null);
    confirmTotp(code.trim())
      .then(() => generateRecoveryCodes())
      .then((fresh) => {
        // Straight to the codes: enabling a second factor without one is how people lock
        // themselves out, and the only moment they can be shown is now.
        setEnrolment(null);
        setCodes(fresh);
        setOpen("recovery");
        setBusy(false);
        refresh();
        onNotify?.({ tone: "success", title: t("security.mfaEnabled") });
      })
      .catch(() => {
        setBusy(false);
        setError(t("security.wrongTotpCode"));
      });
  };

  const confirmDisable = () => {
    setBusy(true);
    setError(null);
    disableTotp(password)
      .then(() => {
        close();
        refresh();
        onNotify?.({ tone: "info", title: t("security.mfaDisabled") });
      })
      .catch((err) => {
        setBusy(false);
        setError(isApiError(err, 401) ? t("security.wrongPassword") : t("common.tryAgain"));
      });
  };

  const showNewCodes = () => {
    setBusy(true);
    generateRecoveryCodes()
      .then((fresh) => {
        setCodes(fresh);
        setOpen("recovery");
        setBusy(false);
        refresh();
      })
      .catch(() => {
        setBusy(false);
        onNotify?.({ tone: "danger", title: t("security.generateFailed") });
      });
  };

  const addPasskey = () => {
    setBusy(true);
    registerPasskey()
      .then(() => {
        setBusy(false);
        refresh();
        onNotify?.({ tone: "success", title: t("security.passkeyAdded") });
      })
      .catch((err) => {
        setBusy(false);
        // A dismissed prompt is a decision, not a failure, and the browser reports it the same way.
        const cancelled = err instanceof Error && err.name === "NotAllowedError";
        if (cancelled) return;
        onNotify?.({ tone: "danger", title: t("security.passkeyFailed"), description: t("common.tryAgain") });
      });
  };

  const dropPasskey = (id: string) => {
    removePasskey(id)
      .then(() => {
        refresh();
        onNotify?.({ tone: "info", title: t("security.passkeyRemoved") });
      })
      .catch(() => onNotify?.({ tone: "danger", title: t("toast.deleteFailed") }));
  };

  const submitPassword = () => {
    setBusy(true);
    setError(null);
    changePassword(password, newPassword)
      .then(() => onSignedOut?.())
      .catch((err) => {
        setBusy(false);
        if (isApiError(err, 401)) {
          setError(t("security.wrongCurrentPassword"));
          return;
        }
        const code = apiErrorCode(err);
        setError(
          code === "breached_password"
            ? t("error.passwordBreached")
            : t("security.weakPassword"),
        );
      });
  };

  const signOutEverywhere = () => {
    setBusy(true);
    logoutEverywhere()
      .then(() => onSignedOut?.())
      .catch(() => {
        setBusy(false);
        onNotify?.({ tone: "danger", title: t("security.signOutFailed"), description: t("common.tryAgain") });
      });
  };

  const unknown = state === null;
  const codesLeft = state?.recoveryCodesRemaining ?? 0;

  return (
    <>
      <Row title={t("login.password")} desc={t("security.passwordRowDesc")}>
        <Button size="sm" onClick={() => setOpen("password")}>
          {t("message.edit")}
        </Button>
      </Row>

      <Row
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {t("security.twoFactor")}
            {unknown ? null : state.totpEnabled ? (
              <Tag tone="success" icon="shield-check">
                {t("security.enabled")}
              </Tag>
            ) : (
              <Tag tone="neutral">{t("security.disabled")}</Tag>
            )}
          </span>
        }
        desc={
          unknown
            ? t("security.unknown")
            : state.totpEnabled
              ? t("security.totpOn")
              : t("security.totpOff")
        }
      >
        {unknown ? null : state.totpEnabled ? (
          <Button size="sm" onClick={() => setOpen("disable")}>
            {t("security.turnOff")}
          </Button>
        ) : (
          <Button size="sm" variant="primary" onClick={startTotp}>
            {t("security.configure")}
          </Button>
        )}
      </Row>

      {state?.totpEnabled ? (
        <Row
          title={t("common.recoveryCode")}
          desc={
            codesLeft > 0
              ? t("security.codesLeft", { count: codesLeft })
              : t("security.noCode")
          }
        >
          <Button size="sm" variant={codesLeft > 0 ? "secondary" : "primary"} disabled={busy} onClick={showNewCodes}>
            {codesLeft > 0 ? t("security.regenerate") : t("security.generate")}
          </Button>
        </Row>
      ) : null}

      <Row
        title={
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
            {t("security.passkeys")}
            {unknown ? null : <Tag tone="info">{state.passkeys.length}</Tag>}
          </span>
        }
        desc={
          isPasskeySupported()
            ? t("security.passkeysOn")
            : t("security.passkeysOff")
        }
      >
        <Button size="sm" iconLeft="plus" disabled={busy || !isPasskeySupported()} onClick={addPasskey}>
          {t("security.add")}
        </Button>
      </Row>

      {state && state.passkeys.length > 0 ? (
        <div style={{ padding: "12px 0 4px", display: "flex", flexDirection: "column", gap: 6 }}>
          {state.passkeys.map((key) => (
            <div
              key={key.id}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                padding: "8px 10px",
                borderRadius: "var(--radius-sm)",
                background: "var(--surface-sunken)",
                fontSize: 13,
              }}
            >
              <Icon name="key-round" size={14} style={{ color: "var(--text-muted)" }} />
              <span style={{ flex: 1, minWidth: 0, color: "var(--text-strong)" }}>
                {key.label ?? t("mfa.passkeyLabel")}
              </span>
              <span style={{ fontSize: 12, color: "var(--text-subtle)" }}>
                {key.lastUsedAt
                  ? t("security.usedOn", { date: new Date(key.lastUsedAt).toLocaleDateString(i18n.language) })
                  : t("security.addedOn", { date: new Date(key.createdAt).toLocaleDateString(i18n.language) })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => dropPasskey(key.id)}>
                {t("common.remove")}
              </Button>
            </div>
          ))}
        </div>
      ) : null}

      <Row
        title={t("security.sessions")}
        desc={t("security.sessionsDesc")}
      >
        <Button size="sm" variant="danger" disabled={busy} onClick={signOutEverywhere}>
          {t("security.signOutEverywhere")}
        </Button>
      </Row>

      <Dialog
        open={open === "totp"}
        title={t("security.setupTotp")}
          closeLabel={t("common.close")}
        subtitle={t("security.scanCode")}
        size="sm"
        onClose={close}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" disabled={busy || code.trim().length < 6} onClick={finishTotp}>
              {busy ? t("common.verifying") : t("notifPrompt.allow")}
            </Button>
          </>
        }
      >
        {enrolment ? (
          <>
            {/* The SVG is built by the server from the same URI shown below it, so the two cannot
                disagree, and no QR library is loaded in the browser. */}
            <div
              style={{ display: "flex", justifyContent: "center", padding: 8 }}
              dangerouslySetInnerHTML={{ __html: enrolment.qrSvg }}
            />
            <p style={{ fontSize: 12, color: "var(--text-muted)", wordBreak: "break-all", margin: "8px 0 16px" }}>
              {t("security.cannotScan", { url: enrolment.otpauthUrl })}
            </p>
          </>
        ) : (
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>{t("crop.preparing")}</p>
        )}
        <Field label={t("security.sixDigits")} htmlFor="totp-code" error={error ?? undefined}>
          <Input
            id="totp-code"
            autoFocus
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && code.trim().length >= 6) finishTotp();
            }}
          />
        </Field>
      </Dialog>

      <Dialog
        open={open === "disable"}
        title={t("security.disableTitle")}
          closeLabel={t("common.close")}
        size="sm"
        onClose={close}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="danger" disabled={busy || !password} onClick={confirmDisable}>
              {t("security.disable")}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: "var(--text-body)", marginBottom: 14 }}>
          {t("security.passwordOnlyWarning")}
        </p>
        <Field label={t("security.yourPassword")} htmlFor="disable-pw" error={error ?? undefined}>
          <Input
            id="disable-pw"
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
      </Dialog>

      <Dialog
        open={open === "recovery"}
        title={t("common.recoveryCode")}
        closeLabel={t("common.close")}
        size="sm"
        onClose={close}
        footer={
          <Button variant="primary" onClick={close}>
            {t("security.notedThem")}
          </Button>
        }
      >
        {codes ? <RecoveryCodes codes={codes} onNotify={onNotify} /> : null}
      </Dialog>

      <Dialog
        open={open === "password"}
        title={t("security.changePassword")}
          closeLabel={t("common.close")}
        size="sm"
        onClose={close}
        footer={
          <>
            <Button onClick={close}>{t("common.cancel")}</Button>
            <Button variant="primary" disabled={busy || !password || !newPassword} onClick={submitPassword}>
              {busy ? t("reset.submitting") : t("message.edit")}
            </Button>
          </>
        }
      >
        <p style={{ fontSize: 13, color: "var(--text-body)", marginBottom: 14 }}>
          {t("security.allSessionsClosed")}
        </p>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Field label={t("security.currentPassword")} htmlFor="pw-old">
            <Input
              id="pw-old"
              type="password"
              autoFocus
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </Field>
          <Field label={t("reset.newPassword")} htmlFor="pw-new" error={error ?? undefined}>
            <Input
              id="pw-new"
              type="password"
              autoComplete="new-password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </Field>
        </div>
      </Dialog>
    </>
  );
}
