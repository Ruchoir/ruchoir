"use client";

import { useEffect, useState } from "react";
import { Avatar, Button, Dialog, Icon, Select } from "@/components/ds";
import { getAvatar } from "@/lib/data";
import type { Member } from "@/lib/data/api";
import { explainAccess } from "@/lib/data/api";
import type { AccessKind, Role, WhyView } from "@/lib/data/types";
import { key, useTranslation } from "@/lib/i18n";
import { PERMISSION_TEXT } from "../settings/permissionText";
import { RoleChip } from "../settings/roleChips";
import { tk } from "./EntryRow";
import { currentLocale } from "@/lib/i18n/current";
import { formatList } from "@/lib/i18n/format";
import { levelLabelKey } from "./accessLogic.ts";
import { type ChainLevel, joinSentences, levelWordKey, cardsOf, groupSteps, labelOf, outline, reasonKey, roleSentence, stepSentence } from "./whyLogic.ts";


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
  chain,
  isFolder = false,
  viewerId,
  onClose,
}: {
  spaceId: string;
  kind: AccessKind;
  resourceId: string;
  resourceName: string;
  members: Member[];
  roles: Role[];
  /** The levels the access passes through: the folders from the top, then the item. */
  chain: ChainLevel[];
  /** The item explained is a folder (both are `file` on the wire). */
  isFolder?: boolean;
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
        count: sentence.count,
      },
    };
  };

  const sep = t("why.sep");
  /** "Label : body" with the label in bold. */
  const labelled = (label: string, body: string) => (
    <>
      <strong>{label}{sep}</strong>
      {body}
    </>
  );
  /** A ready sentence that opens with its own label ("Plafond des invités : ..."): the label in bold. */
  const boldLead = (text: string) => {
    const at = text.indexOf(":");
    return at < 0 ? text : <><strong>{text.slice(0, at + 1)}</strong>{text.slice(at + 1)}</>;
  };
  const list = (permissions: string[]) => formatList(permissions.map(permissionName));
  const paragraph = (para: ReturnType<typeof outline>[number]) => {
    switch (para.type) {
      case "base":
        return labelled(t("why.label.base"), t(para.group.effect === "removed" ? key("why.para.base.removed") : key("why.para.base.granted"), { permission: list(para.group.permissions), person: personName }));
      case "roles": {
        // Each role as a chip (with the group icon when a group carries it) and how it is held.
        const parts = para.roles.map((role) => {
          const groups = role.viaGroups.map((g) => g.name);
          const how = groups.length === 0 ? t("why.para.viaDirect") : t(role.direct ? key("why.para.viaBoth") : key("why.para.viaGroup"), { groups: groups.join(", ") });
          const full = roles.find((r) => r.id === role.id);
          const chip = full ? <RoleChip role={full} via={groups} /> : <strong>{named({ kind: "role", id: role.id, name: role.name, hidden: false }, role.name)}</strong>;
          return (
            <span key={role.id}>
              {chip} {how}
            </span>
          );
        });
        return (
          <>
            <strong>{t("why.label.roles")}{sep}</strong>
            {parts.map((part, n) => (
              <span key={n}>{n > 0 ? ", " : ""}{part}</span>
            ))}
            .
          </>
        );
      }
      case "space": {
        const name = named({ kind: "role", id: para.role.id, name: para.role.name, hidden: false }, para.role.name);
        return labelled(t("why.label.space"), t(para.effect === "removed" ? key("why.para.space.removed") : key("why.para.space.granted"), { role: name, permission: list(para.permissions) }));
      }
      case "level": {
        const wordKey = levelWordKey(para, kind, isFolder);
        const word = wordKey ? t(tk(wordKey)) : "";
        const label = para.hidden ? t("why.label.hiddenPlace") : `${word} ${kind === "channel" && para.item ? "#" : ""}${para.name ?? ""}`;
        if (para.rules.length === 0) return labelled(label, t("why.para.level.none", { person: personName }));
        const body = para.rules
          .map((g) => {
            const target = named(g.target, t("why.hiddenTarget"));
            const permission = list(g.permissions);
            if (g.effect === "removed") return t("why.para.rule.removed", { permission, target, person: personName });
            if (!g.ruleLevel) return t("why.para.rule.grantedNoLevel", { permission, target, person: personName });
            const levelKind = g.level?.kind === "channel" || g.level?.kind === "calendar" ? g.level.kind : "file";
            return t("why.para.rule.granted", { level: t(tk(levelLabelKey(levelKind, g.ruleLevel))), target, person: personName, permission, count: g.permissions.length });
          });
        return labelled(label, joinSentences(body, currentLocale()));
      }
      case "locks":
        return para.groups.map((g, n) => <span key={n}>{n > 0 ? " " : ""}{boldLead(t(tk(fill(g).key), fill(g).values))}</span>);
      case "quiet":
        return boldLead(t("why.locksNone"));
      case "other":
        return boldLead(t(tk(fill(para.group).key), fill(para.group).values));
    }
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
            <ol style={{ listStyle: "none", margin: 0, padding: 0, border: "1px solid var(--border-subtle)", borderRadius: "var(--radius-lg)", overflow: "hidden" }}>
              {why.steps.length === 0 ? (
                <li style={{ padding: "12px 14px", fontSize: "var(--text-sm)", color: "var(--text-muted)" }}>{t("why.noSteps")}</li>
              ) : null}
              {(why.steps.length === 0 ? [] : outline(why.steps, chain, why.person.roles)).map((para, i) => (
                <li key={i} style={{ display: "flex", gap: 12, padding: "10px 14px", borderTop: i === 0 ? 0 : "1px solid var(--border-subtle)", alignItems: "flex-start" }}>
                  <span
                    aria-hidden
                    style={{ width: 24, height: 24, flex: "none", borderRadius: "var(--radius-full)", background: "var(--surface-sunken)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "var(--text-xs)", fontWeight: 600, color: "var(--text-body)" }}
                  >
                    {i + 1}
                  </span>
                  <span style={{ fontSize: "var(--text-sm)", color: "var(--text-body)", lineHeight: 1.5 }}>{paragraph(para)}</span>
                </li>
              ))}
            </ol>

            <div>
              <div style={{ fontSize: "var(--text-sm)", color: "var(--text-muted)", marginBottom: 8 }}>{t("why.resultFor", { name: personName })}</div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
                {cardsOf(kind, why.result, why.steps).map((card) => (
                  <div
                    key={card.id}
                    style={{
                      padding: "10px 12px",
                      borderRadius: "var(--radius-lg)",
                      border: `1px solid ${card.granted ? "var(--status-success-border)" : "var(--border-subtle)"}`,
                      background: card.granted ? "var(--status-success-bg)" : "var(--surface-sunken)",
                    }}
                  >
                    <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "var(--text-sm)", fontWeight: 600, color: "var(--text-strong)" }}>
                      <Icon name={card.granted ? "check" : "x"} size={16} aria-hidden />
                      {t(tk(card.labelKey))}
                    </div>
                    <div style={{ fontSize: "var(--text-xs)", color: "var(--text-muted)", marginTop: 2 }}>
                      {card.reason?.levelKey
                        ? card.reason.hiddenPlace
                          ? t("why.reason.ruleOnHidden", { level: t(tk(card.reason.levelKey)) })
                          : t("why.reason.ruleOn", { where: card.reason.where ?? "", level: t(tk(card.reason.levelKey)) })
                        : card.reason
                          ? t(tk(reasonKey(card.reason.kind)))
                          : card.granted
                            ? t("why.reason.other")
                            : card.hint === "askManage"
                              ? t("why.reason.askManage")
                              : t("why.reason.none")}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </>
        ) : null}
      </div>
    </Dialog>
  );
}
