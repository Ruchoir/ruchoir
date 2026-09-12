"use client";

import { Checkbox, Field, Radio } from "@/components/ds";
import type { ChannelType } from "@/lib/data";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";

/** The space roles, strongest first, as dictionary keys. The order the member list uses. */
const ROLES: [string, TranslationKey][] = [
  ["owner", key("role.owner")],
  ["admin", key("role.admin")],
  ["member", key("role.member")],
  ["guest", key("role.guest")],
];

export type ChannelAccessProps = {
  /** `public` (anyone may join) or `private` (added by someone). `archived` is a state, not access. */
  type: ChannelType;
  onTypeChange: (type: ChannelType) => void;
  /** The roles the channel admits, or `undefined` while it admits all of them. */
  allowedRoles: string[] | undefined;
  onRolesChange: (roles: string[] | undefined) => void;
  /** The caller's own space role: always admitted, and never unticked. */
  myRole: string;
  /** Archived channels are read-only, so their access is not up for discussion. */
  disabled?: boolean;
};

/**
 * Who may be in a channel, and how they get in.
 *
 * **Two questions, deliberately in this order**, because they are not the same one and the product
 * owner did not read them as different when they were two abstract settings side by side
 * ("visibility" and "access by role"). Whoever is configuring a channel should not have to build a
 * two-by-two table in their head, so the questions are concrete and the result is written out
 * underneath in a sentence.
 *
 * The asymmetry the sentence has to carry: a reservation *takes access back* (lose the role, lose
 * the channel, membership row or not), while visibility never does (turning a channel private
 * removes nobody who is already in it).
 */
export function ChannelAccess({
  type,
  onTypeChange,
  allowedRoles,
  onRolesChange,
  myRole,
  disabled = false,
}: ChannelAccessProps) {
  const { t } = useTranslation();
  const reserved = allowedRoles !== undefined;
  const has = (role: string) => allowedRoles?.includes(role) ?? false;

  const toggle = (role: string) => {
    if (role === myRole) return;
    const next = has(role) ? (allowedRoles ?? []).filter((r) => r !== role) : [...(allowedRoles ?? []), role];
    onRolesChange(next);
  };

  const summary: TranslationKey = reserved
    ? type === "private"
      ? key("channel.summaryRolesInvite")
      : key("channel.summaryRolesJoinable")
    : type === "private"
      ? key("channel.summaryOpenInvite")
      : key("channel.summaryOpenJoinable");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Field label={t("channel.whoCanBeHere")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Radio
            name="ca-scope"
            checked={!reserved}
            disabled={disabled}
            onChange={() => onRolesChange(undefined)}
            label={t("channel.everyoneInSpace")}
          />
          <Radio
            name="ca-scope"
            checked={reserved}
            disabled={disabled}
            // Seeded with the caller's own role, which the API requires and the tick below locks: a
            // room you have shut yourself out of is not a room you meant to make.
            onChange={() => onRolesChange([myRole])}
            label={t("channel.onlySomeRoles")}
          />
          {reserved ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 24 }}>
              {ROLES.map(([role, label]) => {
                const mine = role === myRole;
                return (
                  <Checkbox
                    key={role}
                    checked={has(role)}
                    // The caller's own role is ticked and cannot be unticked, but it is *not* drawn
                    // as disabled: greyed out reads "unavailable", and this one is the opposite, it
                    // is the one that is necessarily true. It says so instead.
                    disabled={disabled}
                    aria-disabled={mine || undefined}
                    onChange={() => toggle(role)}
                    label={
                      mine ? (
                        <>
                          {t(label)}
                          <span style={{ color: "var(--text-muted)" }}> {t("channel.yourOwnRole")}</span>
                        </>
                      ) : (
                        t(label)
                      )
                    }
                  />
                );
              })}
            </div>
          ) : null}
        </div>
      </Field>

      <Field label={t("channel.howToGetIn")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Radio
            name="ca-type"
            checked={type === "public"}
            disabled={disabled}
            onChange={() => onTypeChange("public")}
            label={t("channel.anyoneCanJoin")}
          />
          <Radio
            name="ca-type"
            checked={type === "private"}
            disabled={disabled}
            onChange={() => onTypeChange("private")}
            label={t("channel.byInvitationOnly")}
          />
        </div>
      </Field>

      {/* What the two answers add up to, said once, in words. The point of the whole component. */}
      <p
        style={{
          margin: 0,
          padding: "10px 12px",
          background: "var(--surface-sunken)",
          border: "1px solid var(--border-subtle)",
          borderRadius: "var(--radius-md)",
          fontSize: 12,
          lineHeight: 1.5,
          color: "var(--text-body)",
        }}
      >
        {t(summary)}
        {reserved ? <> {t("channel.roleLossWarning")}</> : null}
      </p>
    </div>
  );
}
