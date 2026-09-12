"use client";

import { Checkbox, Field, Switch } from "@/components/ds";
import { key, type TranslationKey, useTranslation } from "@/lib/i18n";

/** The space roles, strongest first, as dictionary keys. The order the member list uses. */
const ROLES: [string, TranslationKey][] = [
  ["owner", key("role.owner")],
  ["admin", key("role.admin")],
  ["member", key("role.member")],
  ["guest", key("role.guest")],
];

export type ChannelRoleAccessProps = {
  /** The roles the channel admits, or `undefined` while it admits everyone. */
  value: string[] | undefined;
  onChange: (roles: string[] | undefined) => void;
  /** The caller's own role, which is always admitted and cannot be unticked. */
  myRole: string;
};

/**
 * Reserve a channel to some roles, or leave it open to all of them.
 *
 * Separate from the public/private choice, and stacked on top of it: visibility answers "who may
 * walk in", this answers "who may be in it at all". A private channel reserved to administrators is
 * both, and means what the two words say together.
 *
 * The caller's own role is ticked and locked, because the API refuses a list that excludes it: a
 * room you have shut yourself out of is not a room you meant to make, and that is better said before
 * the request than after it.
 */
export function ChannelRoleAccess({ value, onChange, myRole }: ChannelRoleAccessProps) {
  const { t } = useTranslation();
  const reserved = value !== undefined;
  const has = (role: string) => value?.includes(role) ?? false;

  const toggle = (role: string) => {
    if (role === myRole) return;
    const next = has(role) ? (value ?? []).filter((r) => r !== role) : [...(value ?? []), role];
    onChange(next);
  };

  return (
    <Field label={t("channel.roleAccess")} hint={reserved ? t("channel.roleAccessHint") : undefined}>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Switch
          checked={reserved}
          onChange={() => onChange(reserved ? undefined : [myRole])}
          label={t("channel.reserveToRoles")}
          reverse
        />
        {reserved ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 2 }}>
            {ROLES.map(([role, label]) => (
              <Checkbox
                key={role}
                checked={has(role)}
                disabled={role === myRole}
                onChange={() => toggle(role)}
                label={t(label)}
              />
            ))}
          </div>
        ) : null}
      </div>
    </Field>
  );
}
