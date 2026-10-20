/**
 * A member of the current space, opened from its settings' member list: the roles the caller may
 * give them (`grantableRoles`, the web's rule), handing the space over for its owner, and removing
 * them from the space. Both of the last ask first, in the web's words.
 */
import { isApiError } from "@ruchoir/client";
import { useNavigation, useRoute, type RouteProp } from "@react-navigation/native";
import { Check, UserMinus } from "lucide-react-native";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { useSpaceMembers } from "../../data/members";
import { key, useTranslation } from "../../i18n";
import { grantableRoles } from "../../logic/spaceRoles";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { hairline } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { feel } from "../../ui/haptics";
import { Sheet } from "../../ui/Sheet";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/** The space roles, as the app words them. */
export const ROLE_LABEL: Record<string, ReturnType<typeof key>> = {
  owner: key("details.roleOwner"),
  admin: key("details.roleAdmin"),
  member: key("invite.member"),
  guest: key("spaceAdmin.roleGuest"),
};

const ROLE_HINT: Record<string, ReturnType<typeof key> | undefined> = {
  member: key("invite.memberHint"),
  guest: key("invite.guestHint"),
};

export function MemberSheet() {
  const { removeMember, setMemberRole } = useApi();
  const { params } = useRoute<RouteProp<RootParams, "spaceMember">>();
  const { t } = useTranslation();
  const { c } = useTheme();
  const toast = useToast();
  const navigation = useNavigation();
  const { current, spaces } = useSpace();
  const people = useSpaceMembers(current?.id);
  const member = people.list.find((m) => m.userId === params.userId);
  const [busy, setBusy] = useState(false);
  if (!current) return null;
  if (!member) {
    return (
      <Sheet>
        <LoadState error={null} onRetry={() => {}} />
      </Sheet>
    );
  }
  // Strongest first, as a list reads: handing over, then admin, member, external guest.
  const roles = grantableRoles(current.role, member.role).slice().reverse();
  const failed = (err: unknown, fallback: ReturnType<typeof key>) =>
    toast(isApiError(err, 403) ? t("spaceAdmin.noRights") : t(fallback), "failure");

  const apply = async (role: string) => {
    setBusy(true);
    try {
      await setMemberRole(current.id, member.userId, role);
      if (role === "owner") {
        // The giver stepped down to admin in the same write: the space list carries my role.
        spaces.reload();
        toast(t("spaceAdmin.handedOver", { name: member.name }), "success");
      } else {
        toast(t("spaceAdmin.roleChanged"));
      }
      navigation.goBack();
    } catch (err) {
      failed(err, key("spaceAdmin.roleFailed"));
    } finally {
      setBusy(false);
    }
  };

  const give = (role: string) => {
    if (busy || role === member.role) return;
    if (role !== "owner") {
      feel("choice");
      void apply(role);
      return;
    }
    Alert.alert(t("spaceAdmin.transferTitle"), t("spaceAdmin.transferBody", { name: member.name, space: current.name }), [
      { text: t("compose.cancel"), style: "cancel" },
      { text: t("spaceAdmin.transferConfirm"), style: "destructive", onPress: () => void apply("owner") },
    ]);
  };

  const remove = () =>
    Alert.alert(
      t("spaceAdmin.removeTitle", { name: member.name }),
      t("spaceAdmin.removeBody", { name: member.name, space: current.name }),
      [
        { text: t("compose.cancel"), style: "cancel" },
        {
          text: t("spaceAdmin.remove"),
          style: "destructive",
          onPress: () =>
            void removeMember(current.id, member.userId).then(
              () => {
                toast(t("spaceAdmin.removed"));
                navigation.goBack();
              },
              (err) => failed(err, key("spaceAdmin.removeFailed")),
            ),
        },
      ],
    );

  return (
    <Sheet>
      <View style={styles.who}>
        <Avatar name={member.name} src={member.avatarUrl} size={48} />
        <View style={styles.text}>
          <Text variant="heading" numberOfLines={1}>
            {member.name}
          </Text>
          <Text tone="muted" numberOfLines={1}>
            {[t(ROLE_LABEL[member.role] ?? ROLE_LABEL.member), member.title].filter(Boolean).join(" · ")}
          </Text>
        </View>
      </View>
      {roles.length > 0 ? (
        <>
          <Text variant="label" tone="muted" style={styles.section}>
            {t("spaceAdmin.role")}
          </Text>
          {roles.map((role) => {
            const on = role === member.role;
            const hint = ROLE_HINT[role];
            return (
              <ActionRow
                key={role}
                title={role === "owner" ? t("spaceAdmin.transferConfirm") : t(ROLE_LABEL[role])}
                subtitle={hint ? t(hint) : undefined}
                selected={on}
                onPress={() => give(role)}
                trailing={
                  role === "owner" ? undefined : (
                    <View style={[styles.radio, on ? { backgroundColor: c.ink, borderColor: c.ink } : { borderColor: c.controlLine }]}>
                      {on ? <Check size={14} color={c.onInk} /> : null}
                    </View>
                  )
                }
              />
            );
          })}
          <View style={styles.gap} />
          <ActionRow icon={UserMinus} title={t("spaceAdmin.remove")} danger onPress={remove} />
        </>
      ) : null}
    </Sheet>
  );
}

const styles = StyleSheet.create({
  who: { flexDirection: "row", alignItems: "center", gap: 12, marginBottom: 4 },
  text: { flex: 1, minWidth: 0 },
  section: { marginTop: 14, marginBottom: 2 },
  gap: { height: 8 },
  radio: { width: 22, height: 22, borderRadius: 11, borderWidth: hairline, alignItems: "center", justifyContent: "center" },
});
