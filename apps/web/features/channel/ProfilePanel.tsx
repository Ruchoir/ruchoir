"use client";

import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { Avatar, Button, Icon, IconButton, Input, Textarea } from "@/components/ds";
import { getCurrentUser } from "@/lib/data";
import type { Profile } from "@/lib/data";
import type { Presence } from "@/components/ds";
import { clearMyAvatar, getUserProfile, setMyAvatar, updateMyProfile } from "@/lib/data/api";
import { ImageCropDialog } from "../app/ImageCropDialog";
import { minimalProfile } from "../app/useProfile";
import { presenceLabel } from "../app/presence";
import type { Toast } from "../app/types";

const styles: Record<string, CSSProperties> = {
  panel: {
    width: "var(--panel-width)",
    flex: "none",
    borderLeft: "1px solid var(--border-subtle)",
    background: "var(--surface-chrome)",
    display: "flex",
    flexDirection: "column",
    minHeight: 0,
  },
  head: {
    height: "var(--topbar-height)",
    flex: "none",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "0 8px 0 16px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  title: { fontSize: 14, fontWeight: 600, color: "var(--text-strong)" },
  scroll: { flex: 1, overflow: "auto" },
  hero: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    textAlign: "center",
    gap: 6,
    padding: "24px 16px 16px",
    borderBottom: "1px solid var(--border-subtle)",
  },
  section: { padding: "14px 16px", borderBottom: "1px solid var(--border-subtle)" },
  label: {
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "var(--tracking-caps)",
    textTransform: "uppercase",
    color: "var(--text-subtle)",
    marginBottom: 8,
  },
  field: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "var(--text-body)", padding: "3px 0" },
  formLabel: { display: "block", fontSize: 12, color: "var(--text-muted)", margin: "10px 0 4px" },
};

function Field({ icon, children }: { icon: string; children: ReactNode }) {
  return (
    <div style={styles.field}>
      <Icon name={icon} size={15} style={{ color: "var(--text-muted)" }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{children}</span>
    </div>
  );
}

export type ProfilePanelProps = {
  name: string;
  /** User id of the member, when known: enables fetching the real profile from the API. */
  userId?: string;
  /** Live presence for the member, overlaid on the fetched profile (which carries none). */
  presence?: Presence;
  startEditing?: boolean;
  onClose: () => void;
  onMessage: () => void;
  /**
   * The signed-in user's own avatar changed. Message rows and the member list read the roster, not
   * this panel, so without this the new picture only appears after a reload.
   */
  onAvatarChanged?: (url?: string) => void;
  onNotify: (toast: Toast) => void;
};

/** Full user profile in the right sidebar. Editable when it is the current user's own profile. */
export function ProfilePanel({
  name,
  userId,
  presence,
  startEditing,
  onClose,
  onMessage,
  onAvatarChanged,
  onNotify,
}: ProfilePanelProps) {
  // Fetch the real profile when we have the member's id; fall back to the mock profile (by name)
  // while it loads or when the id is unknown (e.g. a member with no endpoint-backed identity).
  const [fetched, setFetched] = useState<Profile | null>(null);
  useEffect(() => {
    // Reset when the shown member changes, then load their real profile if we have the id.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFetched(null);
    if (!userId) return;
    let active = true;
    getUserProfile(userId)
      .then((profile) => active && setFetched(profile))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userId]);
  const p = fetched ?? minimalProfile(name);
  const shownPresence = presence ?? p.presence;
  const isOwn = name === getCurrentUser().name;
  const [editing, setEditing] = useState(!!startEditing && isOwn);
  const [role, setRole] = useState(p.role);
  const [pronouns, setPronouns] = useState(p.pronouns ?? "");
  const [bio, setBio] = useState(p.bio ?? "");
  /**
   * A local change to the avatar since the profile was fetched: a URL just uploaded, `null` for one
   * just removed, `undefined` for no change.
   *
   * Three states rather than two, because "removed" and "never had one" both show the generated
   * avatar but only one of them should override what the fetched profile says. What is displayed is
   * always a URL the server returned, never a local object URL that would vanish on reload.
   */
  const [photoOverride, setPhotoOverride] = useState<string | null | undefined>(undefined);
  const [photoBusy, setPhotoBusy] = useState(false);
  /** The picked file, held until it has been cropped. */
  const [cropping, setCropping] = useState<File | null>(null);
  const photo = photoOverride === null ? undefined : (photoOverride ?? p.avatarUrl);
  const photoRef = useRef<HTMLInputElement>(null);

  const onPhotoPicked = (fileList: FileList | null) => {
    const file = fileList?.[0];
    if (!file) return;
    if (photoRef.current) photoRef.current.value = "";
    // Framing first: an avatar is only ever shown as a square, so the square is chosen rather than
    // taken from the middle of whatever was picked.
    setCropping(file);
  };

  const uploadCropped = async (file: File) => {
    setCropping(null);
    setPhotoBusy(true);
    try {
      const url = await setMyAvatar(file);
      setPhotoOverride(url);
      onAvatarChanged?.(url);
      onNotify({ tone: "success", title: "Photo mise à jour" });
    } catch {
      onNotify({ tone: "danger", title: "Photo non enregistrée", description: "Choisissez une image plus légère." });
    } finally {
      setPhotoBusy(false);
    }
  };

  const removePhoto = async () => {
    setPhotoBusy(true);
    try {
      await clearMyAvatar();
      setPhotoOverride(null);
      onAvatarChanged?.(undefined);
    } catch {
      onNotify({ tone: "danger", title: "Photo non retirée" });
    } finally {
      setPhotoBusy(false);
    }
  };

  const save = () => {
    setEditing(false);
    // The role field maps to the profile "title"; the API updates the current session's own profile.
    updateMyProfile({ title: role, pronouns, bio })
      .then((profile) => {
        setFetched(profile);
        onNotify({ tone: "success", title: "Profil mis à jour" });
      })
      .catch(() => onNotify({ tone: "danger", title: "Mise à jour du profil impossible" }));
  };

  return (
    <div style={styles.panel}>
      <div style={styles.head}>
        <span style={styles.title}>{isOwn ? "Mon profil" : "Profil"}</span>
        <IconButton icon="x" label="Fermer le profil" size="sm" onClick={onClose} />
      </div>
      <div style={styles.scroll}>
        <div style={styles.hero}>
          <Avatar name={p.name} src={photo} size={88} kind={p.bot ? "bot" : "person"} />
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text-strong)", marginTop: 4 }}>{p.name}</div>
          <div style={{ fontSize: 13, color: "var(--text-muted)" }}>
            {p.role}
            {p.pronouns ? ` · ${p.pronouns}` : ""}
          </div>
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>
            <span style={{ width: 9, height: 9, borderRadius: "var(--radius-full)", background: `var(--presence-${shownPresence})` }} />
            {presenceLabel(shownPresence)}
          </div>
          <div style={{ marginTop: 10, width: "100%" }}>
            {isOwn ? (
              editing ? null : (
                <Button variant="secondary" size="md" iconLeft="square-pen" onClick={() => setEditing(true)} fullWidth>
                  Modifier le profil
                </Button>
              )
            ) : (
              <Button variant="primary" size="md" iconLeft="message-square" onClick={onMessage} fullWidth>
                Envoyer un message
              </Button>
            )}
          </div>
        </div>

        {isOwn && editing ? (
          <div style={styles.section}>
            <div style={styles.label}>Modifier</div>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 4 }}>
              <Avatar name={p.name} src={photo} size={56} kind={p.bot ? "bot" : "person"} />
              <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                <Button
                  variant="secondary"
                  size="sm"
                  iconLeft="image"
                  disabled={photoBusy}
                  onClick={() => photoRef.current?.click()}
                >
                  {photoBusy ? "Envoi…" : "Changer la photo"}
                </Button>
                {photo ? (
                  <Button variant="link" size="sm" disabled={photoBusy} onClick={() => void removePhoto()}>
                    Retirer la photo
                  </Button>
                ) : null}
              </div>
              <input ref={photoRef} type="file" accept="image/*" style={{ display: "none" }} onChange={(e) => onPhotoPicked(e.target.files)} />
            </div>
            <label style={styles.formLabel}>Rôle</label>
            <Input value={role} onChange={(e) => setRole(e.target.value)} />
            <label style={styles.formLabel}>Pronoms</label>
            <Input value={pronouns} onChange={(e) => setPronouns(e.target.value)} placeholder="ex. elle, il, iel" />
            <label style={styles.formLabel}>À propos</label>
            <Textarea rows={3} value={bio} onChange={(e) => setBio(e.target.value)} />
            <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
              <Button variant="primary" size="sm" onClick={save}>
                Enregistrer
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(false)}>
                Annuler
              </Button>
            </div>
          </div>
        ) : (
          <>
            {p.bio ? (
              <div style={styles.section}>
                <div style={styles.label}>À propos</div>
                <p style={{ fontSize: 13, color: "var(--text-body)", lineHeight: "var(--leading-snug)" }}>{p.bio}</p>
              </div>
            ) : null}

            <div style={styles.section}>
              <div style={styles.label}>Coordonnées</div>
              {p.email ? <Field icon="at-sign">{p.email}</Field> : null}
              <Field icon="clock">{p.localTime} heure locale</Field>
              <Field icon="globe">{p.timezone}</Field>
            </div>
          </>
        )}
      </div>

      {cropping ? (
        <ImageCropDialog
          file={cropping}
          title="Cadrer la photo"
          onCancel={() => setCropping(null)}
          onConfirm={(cropped) => void uploadCropped(cropped)}
        />
      ) : null}
    </div>
  );
}
