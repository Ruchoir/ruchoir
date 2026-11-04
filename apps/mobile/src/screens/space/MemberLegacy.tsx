/**
 * A member's one legacy role (owner, admin, member, guest), as an instance older than the roles
 * and a community space still hold it: the roles the caller may give (`grantableRoles`, the web's
 * rule), handing the space over for its owner, and removing the person. The last two ask first.
 */
import { isApiError, type Member, type Workspace } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { Check, UserMinus } from "lucide-react-native";
import { useState } from "react";
import { Alert, StyleSheet, View } from "react-native";

import { useApi } from "../../api/useApi";
import { key, useTranslation } from "../../i18n";
import { grantableRoles } from "../../logic/spaceRoles";
import { useSpace } from "../../space/SpaceProvider";
import { styleCache } from "../../theme/themedStyles";
import { useTheme, useThemedStyles } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { feel } from "../../ui/haptics";
import { Text } from "../../ui/Text";
import { useToast } from "../../ui/Toast";

/** The space roles, as the app words them. */
const ROLE_LABEL: Record<string, ReturnType<typeof key>> = {
  owner: key("details.roleOwner"),
  admin: key("details.roleAdmin"),
  member: key("invite.member"),
  guest: key("spaceAdmin.roleGuest"),
};

const ROLE_HINT: Record<string, ReturnType<typeof key> | undefined> = {
  member: key("invite.memberHint"),
  guest: key("invite.guestHint"),
};

/** Asks before removing someone from the space; leaves the screen once they are gone. */
export function useRemoveMember(space: Workspace, member: Member, failed: (err: unknown, fallback: ReturnType<typeof key>) => void) {
  const { removeMember } = useApi();
  const { t } = useTranslation();
  const toast = useToast();
  const navigation = useNavigation();
  return () =>
    Alert.alert(t("spaceAdmin.removeTitle", { name: member.name }), t("spaceAdmin.removeBody", { name: member.name, space: space.name }), [
      { text: t("compose.cancel"), style: "cancel" },
      {
        text: t("spaceAdmin.remove"),
        style: "destructive",
        onPress: () =>
          void removeMember(space.id, member.userId).then(
            () => {
              toast(t("spaceAdmin.removed"));
              navigation.goBack();
            },
            (err) => failed(err, key("spaceAdmin.removeFailed")),
          ),
      },
    ]);
}

/** A failure as a toast: a refusal for lack of rights says so, anything else says what it could not do. */
export function useFailed() {
  const { t } = useTranslation();
  const toast = useToast();
  return (err: unknown, fallback: ReturnType<typeof key>) => toast(isApiError(err, 403) ? t("spaceAdmin.noRights") : t(fallback), "failure");
}

/** The role rows (and, with `withRemove`, the removal) of the legacy sheet. */
export function LegacyRoles({ space, member, withRemove = true }: { space: Workspace; member: Member; withRemove?: boolean }) {
  const { setMemberRole } = useApi();
  const { t } = useTranslation();
  const { c } = useTheme();
  const styles = useThemedStyles(makeStyles);
  const toast = useToast();
  const navigation = useNavigation();
  const { spaces } = useSpace();
  const [busy, setBusy] = useState(false);
  const failed = useFailed();
  const remove = useRemoveMember(space, member, failed);
  // Strongest first, as a list reads: handing over, then admin, member, external guest.
  const roles = grantableRoles(space.role, member.role).slice().reverse();

  const apply = async (role: string) => {
    setBusy(true);
    try {
      await setMemberRole(space.id, member.userId, role);
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
    Alert.alert(t("spaceAdmin.transferTitle"), t("spaceAdmin.transferBody", { name: member.name, space: space.name }), [
      { text: t("compose.cancel"), style: "cancel" },
      { text: t("spaceAdmin.transferConfirm"), style: "destructive", onPress: () => void apply("owner") },
    ]);
  };

  if (roles.length === 0) return null;
  return (
    <View style={styles.box}>
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
      {withRemove ? (
        <>
          <View style={styles.gap} />
          <ActionRow icon={UserMinus} title={t("spaceAdmin.remove")} danger onPress={remove} />
        </>
      ) : null}
    </View>
  );
}

const makeStyles = styleCache((shape) =>
  StyleSheet.create({
    box: { paddingHorizontal: 16 },
    section: { marginTop: 14, marginBottom: 2 },
    gap: { height: 8 },
    radio: { width: 22, height: 22, borderRadius: 11, borderWidth: shape.hairline, alignItems: "center", justifyContent: "center" },
  }),
);
