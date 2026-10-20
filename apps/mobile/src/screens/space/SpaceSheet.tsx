import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { Workspace } from "@ruchoir/client";
import { Bell, Check, LogIn, LogOut, Plus, Server, Settings, UserPlus, WifiOff } from "lucide-react-native";
import { ActivityIndicator, StyleSheet, View } from "react-native";

import { useAccounts, type Account } from "../../accounts/AccountsProvider";
import { groupSpaces, hostOf, type SpaceSection } from "../../accounts/summary";
import { ApiProvider } from "../../api/useApi";
import { useTranslation } from "../../i18n";
import { canAdminister } from "../../logic/spaceRoles";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { radius } from "../../theme/tokens";
import { useTheme } from "../../theme/useTheme";
import { ActionRow } from "../../ui/ActionRow";
import { Avatar } from "../../ui/Avatar";
import { Sheet } from "../../ui/Sheet";
import { LoadState } from "../../ui/States";
import { Text } from "../../ui/Text";
import { useLeaveSpace } from "./useLeaveSpace";

/**
 * "Switch space" (mockup 10): every space with its unread count, of every instance the phone is
 * signed in to, under a heading per instance when there is more than one (ADR 0007); what the current
 * one offers, as the web's space menu does (inviting and its settings for its owner and admins, its
 * notifications and leaving it for everyone); then adding an instance, and creating or joining a
 * space on the one on screen.
 */
export function SpaceSheet() {
  const { t } = useTranslation();
  const { c } = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();
  const { spaces, current, select } = useSpace();
  const accounts = useAccounts();
  const leave = useLeaveSpace();
  const sections = groupSpaces(accounts.accounts, accounts.summaries);
  const activeId = accounts.active?.id;
  const several = sections.length > 1;
  // The sheet goes away first, then the screen comes up in its place.
  const open = (screen: "invite" | "spaceSettings" | "spaceNotify") => {
    navigation.goBack();
    navigation.navigate(screen);
  };

  return (
    <Sheet>
      <Text variant="heading" style={styles.title}>
        {t("spaces.title")}
      </Text>
      {several ? (
        sections.map((section) => {
          const account = accounts.accounts.find((x) => x.id === section.id);
          return account ? (
            <InstanceSection
              key={section.id}
              section={section}
              account={account}
              currentId={section.id === activeId ? current?.id : undefined}
              onPick={(space) => {
                navigation.goBack();
                if (section.id === activeId) select(space.id);
                else accounts.switchTo(section.id, space.id);
              }}
              onSignIn={() => accounts.renew(section.id)}
              onRetry={accounts.retryOffline}
            />
          ) : null;
        })
      ) : (
        <>
          {!spaces.data ? <LoadState error={spaces.error} onRetry={spaces.reload} /> : null}
          {spaces.data?.map((space) => (
            <SpaceRow
              key={space.id}
              space={space}
              selected={space.id === current?.id}
              onPress={() => {
                select(space.id);
                navigation.goBack();
              }}
            />
          ))}
        </>
      )}
      {current ? (
        <>
          {/* In the sheet's own typeface: the monospaced label read as another font. */}
          <Text variant="smallStrong" tone="muted" style={styles.section}>
            {current.name}
          </Text>
          {canAdminister(current.role) ? (
            <>
              <ActionRow icon={UserPlus} tint={c.pink} title={t("spaceAdmin.invite")} onPress={() => open("invite")} />
              <ActionRow icon={Settings} tint={c.sky} title={t("spaceAdmin.settings")} onPress={() => open("spaceSettings")} />
            </>
          ) : null}
          <ActionRow icon={Bell} tint={c.sun} title={t("spaceAdmin.notifications")} onPress={() => open("spaceNotify")} />
          <ActionRow
            icon={LogOut}
           
            title={t("spaceAdmin.leave")}
            danger
            onPress={() => {
              navigation.goBack();
              leave(current);
            }}
          />
          <View style={styles.gap} />
        </>
      ) : null}
      <ActionRow icon={Server} title={t("spaces.addInstance")} subtitle={t("spaces.addInstanceHint")} onPress={accounts.startAdd} />
      <ActionRow
        icon={Plus}
       
        title={t("joinSpace.modalTitle")}
        subtitle={t("joinSpace.rowHint")}
        onPress={() => {
          navigation.goBack();
          navigation.navigate("joinSpace");
        }}
      />
    </Sheet>
  );
}

/** A space to pick: its icon (a check when it is the one on screen), its name, its unread count. */
function SpaceRow({ space, selected, onPress }: { space: Workspace; selected: boolean; onPress: () => void }) {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <ActionRow
      selected={selected}
      onPress={onPress}
      leading={
        selected ? (
          <View style={[styles.check, { backgroundColor: c.sky }]}>
            <Check size={20} color={c.onPastel} />
          </View>
        ) : (
          <Avatar name={space.name} src={space.iconUrl} kind="workspace" size={40} />
        )
      }
      title={space.name}
      subtitle={selected ? t("spaces.current") : space.unread > 0 ? t("spaces.unread", { count: space.unread }) : undefined}
    />
  );
}

/**
 * One instance's spaces, under its host. Drawn with that instance's client, so the spaces' icons are
 * fetched from it with its own token. A signed-out instance offers to sign in again; one that could
 * not be reached, to try again.
 */
function InstanceSection({
  section,
  account,
  currentId,
  onPick,
  onSignIn,
  onRetry,
}: {
  section: SpaceSection;
  account: Account;
  currentId: string | undefined;
  onPick: (space: Workspace) => void;
  onSignIn: () => void;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  const { c } = useTheme();
  return (
    <ApiProvider client={account.client}>
      <Text variant="smallStrong" tone="muted" style={styles.section} numberOfLines={1}>
        {hostOf(section.origin)}
      </Text>
      {section.state === "signedOut" ? (
        <ActionRow icon={LogIn} title={t("spaces.signInAgain")} subtitle={t("spaces.signedOut")} onPress={onSignIn} />
      ) : section.state === "offline" ? (
        <ActionRow icon={WifiOff} title={t("widgets.unreachable")} subtitle={t("spaces.tryAgain")} onPress={onRetry} />
      ) : section.spaces === null ? (
        <ActivityIndicator color={c.ink} style={styles.loading} />
      ) : (
        section.spaces.map((space) => <SpaceRow key={space.id} space={space} selected={space.id === currentId} onPress={() => onPick(space)} />)
      )}
    </ApiProvider>
  );
}

const styles = StyleSheet.create({
  title: { marginBottom: 6 },
  section: { marginTop: 14, marginBottom: 2 },
  gap: { height: 8 },
  loading: { paddingVertical: 12 },
  check: { width: 40, height: 40, borderRadius: radius.m, alignItems: "center", justifyContent: "center" },
});
