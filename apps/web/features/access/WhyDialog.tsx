"use client";

import { useEffect, useState } from "react";
import { Avatar, Button, Dialog, Icon, Select } from "@/components/ds";
import { getAvatar } from "@/lib/data";
import type { Member } from "@/lib/data/api";
import { explainAccess } from "@/lib/data/api";
import type { AccessKind, Role, WhyView } from "@/lib/data/types";
import { key, useTranslation } from "@/lib/i18n";
import { PERMISSION_TEXT } from "../settings/permissionText";
import { tk } from "./EntryRow";
import { formatList } from "@/lib/i18n/format";
import { cardOf, groupSteps, locksQuiet, labelOf, reasonKey, roleSentence, stepSentence } from "./whyLogic.ts";

/**
 * "Pourquoi ?" (frame 9): pick a person, read what the engine did step by step in the order it
 * applied it, then the decision for each permission of the resource. Read only; open to whoever may
 * open the access dialog. The explanation is the API's: the sentences only word it.
 */
export function WhyDialog({
  spaceId,
  kind,
  resourceId,
  resourceName,
  members,
  roles,
  viewerId,
  onClose,
}: {
  spaceId: string;
  kind: AccessKind;
  resourceId: string;
  resourceName: string;
  members: Member[];
  roles: Role[];
  viewerId: string | undefined;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [userId, setUserId] = useState<string | undefined>(viewerId);
  /** The answer for one person; an answer for another one is stale and ignored. */
  const [answer, setAnswer] = useState<{ userId: string | undefined; why?: WhyView; failed?: boolean } | null>(null);

  useEffect(() => {
    let active = true;
    explainAccess(spaceId, kind, resourceId, userId)
      .then((view) => active && setAnswer({ userId, why: view }))
      .catch(() => active && setAnswer({ userId, failed: true }));
    return () => {
      active = false;
    };
  }, [spaceId, kind, resourceId, userId]);
  const current = answer && answer.userId === userId ? answer : null;
  const why = current?.why ?? null;
  const failed = current?.failed === true;

  const people = members.filter((m) => !m.bot);
  const picked = people.find((m) => m.userId === userId);
  const personName = why?.person.name ?? picked?.name ?? "";
  const permissionName = (permission: string) => {
    const text = PERMISSION_TEXT[permission];
    return text ? t(text.title) : permission;
  };
  /** A target or role as the UI names it: "Tout l'espace", "Administrateur" for the system ones. */
  const named = (ref: Parameters<typeof labelOf>[0], hidden: string) => {
    const label = labelOf(ref, roles);
    return label.key ? t(tk(label.key)) : (label.name ?? hidden);
  };
  const fill = (group: ReturnType<typeof groupSteps>[number]) => {
    const sentence = stepSentence(group);
    const role = group.role ? { ...group.role, name: named({ kind: "role", id: group.role.id, name: group.role.name, hidden: false }, group.role.name) } : undefined;
    return {
      key: sentence.key,
      role: role ? roleSentence(role) : undefined,
      values: {
        ...sentence.values,
        ...(role ? { role: role.name } : {}),
        where: sentence.values.where || t("why.hiddenPlace"),
        target: named(group.target, t("why.hiddenTarget")),
        person: personName,
        permission: formatList(group.permissions.map(permissionName)),
      },
    };
  };

  return (
    <Dialog
      open
      size="lg"
      title={personName ? t("why.title", { person: personName, resource: resourceName }) : t("why.titleBare", { resource: resourceName })}
      subtitle={t("why.subtitle")}
      onClose={onClose}
      closeLabel={t("common.close")}
      footer={
        <Button variant="primary" onClick={onClose}>
          {t("common.close")}
        </Button>
      }
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <label style={{ display: "flex", alignItems: "center", gap: 10, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>
          {t("roles.colPerson")}
          {picked ? <Avatar name={picked.name} src={picked.avatarUrl ?? getAvatar(picked.name)} size={28} /> : null}
          <Select size="sm" aria-label={t("why.pick")} value={userId ?? ""} onChange={(e) => setUserId(e.target.value || undefined)} style={{ minWidth: 260 }}>
            {userId === undefined ? <option value="">{t("why.pick")}</option> : null}
            {people.map((m) => (
              <option key={m.userId} value={m.userId}>
                {[m.userId === viewerId ? t("why.you", { name: m.name }) : m.name, m.title].filter(Boolean).join(" · ")}
              </option>
            ))}
          </Select>
        </label>

        {failed ? (
          <p role="alert" style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--status-danger-fg)" }}>
            {t("why.failed")}
          </p>
        ) : null}
        {!why && !failed ? <p style={{ margin: 0, fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{t("why.loading")}</p> : null}

        {why ? (
          <>
            <ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
              {why.steps.length > 0 && locksQuiet(why.steps) ? (
                <li style={{ display: "flex", gap: 12, padding: "10px 14px", borderTop: "1px solid var(--border-subtle)", alignItems: "flex-start", order: 99 }}>
                  <span aria-hidden style={{ width: 24, height: 24, flex: "none", borderRadius: "var(--radius-full)", background: "var(--surface-sunken)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-body)" }}>
                    {groupSteps(why.steps).length + 1}
                  </span>
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", lineHeight: 1.5 }}>{t("why.locksNone")}</span>
                </li>
              ) : null}
              {why.steps.length === 0 ? (
                <li style={{ padding: "12px 14px", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{t("why.noSteps")}</li>
              ) : null}
              {groupSteps(why.steps).map((step, i) => {
                const sentence = fill(step);
                const role = sentence.role;
                return (
                  <li key={step.n} style={{ display: "flex", gap: 12, padding: "10px 14px", borderTop: i === 0 ? 0 : "1px solid var(--border-subtle)", alignItems: "flex-start" }}>
                    <span
                      aria-hidden
                      style={{ width: 24, height: 24, flex: "none", borderRadius: "var(--radius-full)", background: "var(--surface-sunken)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-body)" }}
                    >
                      {i + 1}
                    </span>
                    <span style={{ fontSize: "var(--text-sm)", color: step.effect === "removed" ? "var(--status-danger-fg)" : "var(--text-body)", lineHeight: 1.5 }}>
                      {t(tk(sentence.key), sentence.values)}
                      {role ? (
                        <span style={{ display: "block", fontSize: "var(--text-xs)", color: "var(--text-muted)" }}>{t(tk(role.key), { ...role.values, person: personName })}</span>
                      ) : null}
                    </span>
                  </li>
                );
              })}
            </ol>

            <div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", marginBottom: 8 }}>{t("why.resultFor", { name: personName })}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                {why.result.map((r) => {
                  const card = cardOf(r, why.steps);
                  return (
                    <div
                      key={card.permission}
                      style={{
                        padding: "10px 12px",
                        borderRadius: "var(--radius-lg)",
                        border: `1px solid ${card.granted ? "var(--status-success-border)" : "var(--border-subtle)"}`,
                        background: card.granted ? "var(--status-success-bg)" : "var(--surface-sunken)",
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>
                        <Icon name={card.granted ? "check" : "x"} size={16} aria-hidden />
                        {permissionName(card.permission)}
                      </div>
                      <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: 2 }}>
                        {card.reason?.levelKey
                          ? card.reason.hiddenPlace
                            ? t("why.reason.ruleOnHidden", { level: t(tk(card.reason.levelKey)) })
                            : t("why.reason.ruleOn", { where: card.reason.where ?? "", level: t(tk(card.reason.levelKey)) })
                          : card.reason
                            ? t(tk(reasonKey(card.reason.kind)))
                            : card.granted
                              ? t(key("why.reason.other"))
                              : t("why.reason.none")}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
