import { createNavigationContainerRef, NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { AttachSheet } from "../compose/AttachSheet";
import { SearchScreen } from "../screens/search/SearchScreen";
import { useDuplicateQuestions } from "../uploads/useDuplicateQuestions";
import { useWidgetLook, useWidgetRefresh } from "../widgets/share";
import { AccountSheet } from "../screens/account/AccountSheet";
import { ChangePasswordScreen } from "../screens/account/ChangePasswordScreen";
import { HelpSheet } from "../screens/account/HelpSheet";
import { LanguageSheet, PreferencesScreen } from "../screens/account/PreferencesScreen";
import { ProfileScreen } from "../screens/account/ProfileScreen";
import { RecoveryCodesScreen } from "../screens/account/RecoveryCodesScreen";
import { SecurityScreen } from "../screens/account/SecurityScreen";
import { StatusSheet } from "../screens/account/StatusSheet";
import { TotpScreen } from "../screens/account/TotpScreen";
import { ZonePicker } from "../screens/account/ZonePicker";
import { ConversationDetails } from "../screens/discussions/ConversationDetails";
import { ConversationScreen } from "../screens/discussions/ConversationScreen";
import { EmojiPickerSheet } from "../screens/discussions/EmojiPickerSheet";
import { InviteScreen } from "../screens/discussions/InviteScreen";
import { MessageActionSheet } from "../screens/discussions/MessageActionSheet";
import { NewConversationScreen } from "../screens/discussions/NewConversationScreen";
import { NewGroupScreen } from "../screens/discussions/NewGroupScreen";
import { NewMessageSheet } from "../screens/discussions/NewMessageSheet";
import { SpaceFilePicker } from "../screens/discussions/SpaceFilePicker";
import { ThreadScreen } from "../screens/discussions/ThreadScreen";
import { EventSummarySheet } from "../screens/agenda/EventSummarySheet";
import { CalendarSheet } from "../screens/agenda/form/CalendarSheet";
import { ChannelSheet } from "../screens/agenda/form/ChannelSheet";
import { CustomRuleScreen } from "../screens/agenda/form/CustomRuleScreen";
import { EventFormScreen } from "../screens/agenda/form/EventFormScreen";
import { InviteesScreen } from "../screens/agenda/form/InviteesScreen";
import { PickerSheet } from "../screens/agenda/form/PickerSheet";
import { RemindersSheet } from "../screens/agenda/form/RemindersSheet";
import { RepeatSheet } from "../screens/agenda/form/RepeatSheet";
import { ScopeSheet } from "../screens/agenda/form/ScopeSheet";
import { TimeZoneSheet } from "../screens/agenda/form/TimeZoneSheet";
import { AddSheet } from "../screens/files/AddSheet";
import { ConflictSheet } from "../screens/files/ConflictSheet";
import { ConversationPicker } from "../screens/files/ConversationPicker";
import { DetailsSheet } from "../screens/files/DetailsSheet";
import { EntryMenu } from "../screens/files/EntryMenu";
import { FileViewerScreen } from "../screens/files/FileViewerScreen";
import { FolderScreen } from "../screens/files/FolderScreen";
import { LinksSheet } from "../screens/files/LinksSheet";
import { MovePicker } from "../screens/files/MovePicker";
import { NameSheet } from "../screens/files/NameSheet";
import { ScanScreen } from "../screens/files/ScanScreen";
import { ShareSheet } from "../screens/files/ShareSheet";
import { UploadsSheet } from "../screens/files/UploadsSheet";
import { VersionsSheet } from "../screens/files/VersionsSheet";
import { JoinSpaceScreen } from "../screens/space/JoinSpaceScreen";
import { DefaultChannelSheet } from "../screens/space/DefaultChannelSheet";
import { DeleteSpaceScreen } from "../screens/space/DeleteSpaceScreen";
import { MemberSheet } from "../screens/space/MemberSheet";
import { SpaceNotifySheet } from "../screens/space/SpaceNotifySheet";
import { SpaceSettingsScreen } from "../screens/space/SpaceSettingsScreen";
import { SpaceSheet } from "../screens/space/SpaceSheet";
import { NotificationsIntroScreen } from "../screens/account/NotificationsIntroScreen";
import { useWide } from "../layout/useWide";
import { usePhonePush } from "../push/usePhonePush";
import { useAppLinks } from "./useAppLinks";
import { TutorialScreen } from "../screens/welcome/TutorialScreen";
import { useNavigationTheme } from "./navigationTheme";
import { Tabs } from "./Tabs";
import type { RootParams } from "./types";

const Stack = createNativeStackNavigator<RootParams>();

/** The root navigation, for what opens a screen from outside one (a tapped notification). */
const rootNavigation = createNavigationContainerRef<RootParams>();

/** "Create or join a space", from the space sheet. */
function JoinSpaceModal() {
  return <JoinSpaceScreen />;
}

/** The signed-in app: the tabs, the screens pushed over them, and the sheets. */
export function RootNavigator() {
  const theme = useNavigationTheme();
  const push = usePhonePush(rootNavigation);
  const links = useAppLinks(rootNavigation);
  useDuplicateQuestions(rootNavigation);
  useWidgetLook();
  useWidgetRefresh();
  const wide = useWide();
  const onReady = () => {
    push.onReady();
    links.onReady();
  };
  const sheet = { presentation: "formSheet", sheetAllowedDetents: "fitToContents", sheetGrabberVisible: true, headerShown: false } as const;

  return (
    <NavigationContainer theme={theme} ref={rootNavigation} onReady={onReady}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="tabs" component={Tabs} />
        {/* On a tablet it only hands over to the Discussions tab: nothing slides in. */}
        <Stack.Screen name="conversation" component={ConversationScreen} options={{ animation: wide ? "none" : "default" }} />
        <Stack.Screen name="thread" component={ThreadScreen} />
        <Stack.Screen name="conversationDetails" component={ConversationDetails} />
        <Stack.Screen name="folder" component={FolderScreen} />
        <Stack.Screen name="fileViewer" component={FileViewerScreen} options={{ presentation: "fullScreenModal" }} />
        <Stack.Screen name="search" component={SearchScreen} options={{ presentation: wide ? "modal" : "fullScreenModal" }} />
        <Stack.Screen name="eventSummary" component={EventSummarySheet} options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
        {/* The form takes the whole phone; on a tablet it is a sheet in the middle, the agenda around it. */}
        <Stack.Screen name="eventForm" component={EventFormScreen} options={{ presentation: wide ? "modal" : "fullScreenModal" }} />
        <Stack.Screen name="eventCalendar" component={CalendarSheet} options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
        <Stack.Screen name="eventPicker" component={PickerSheet} options={sheet} />
        <Stack.Screen name="eventRepeat" component={RepeatSheet} options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
        <Stack.Screen name="eventRule" component={CustomRuleScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="eventInvitees" component={InviteesScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="eventChannel" component={ChannelSheet} options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
        <Stack.Screen name="eventZone" component={TimeZoneSheet} options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
        <Stack.Screen name="eventScope" component={ScopeSheet} options={sheet} />
        <Stack.Screen name="eventReminders" component={RemindersSheet} options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
        <Stack.Screen name="filesAdd" component={AddSheet} options={sheet} />
        <Stack.Screen name="uploads" component={UploadsSheet} options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
        <Stack.Screen name="uploadConflict" component={ConflictSheet} options={sheet} />
        <Stack.Screen name="scan" component={ScanScreen} options={{ presentation: "fullScreenModal" }} />
        <Stack.Screen name="fileMenu" component={EntryMenu} options={sheet} />
        <Stack.Screen name="fileName" component={NameSheet} options={sheet} />
        <Stack.Screen name="fileDetails" component={DetailsSheet} options={sheet} />
        <Stack.Screen name="fileMove" component={MovePicker} options={{ presentation: "modal" }} />
        <Stack.Screen name="fileVersions" component={VersionsSheet} options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
        <Stack.Screen name="fileShare" component={ShareSheet} options={sheet} />
        <Stack.Screen name="fileSendTo" component={ConversationPicker} options={{ presentation: "modal" }} />
        <Stack.Screen name="fileLinks" component={LinksSheet} options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
        {/* As tall as its rows, like the other short sheets: at half the screen and then full, it
            jumped and blinked as it opened and closed. */}
        <Stack.Screen name="spaceSheet" component={SpaceSheet} options={sheet} />
        <Stack.Screen name="joinSpace" component={JoinSpaceModal} options={{ presentation: "modal" }} />
        <Stack.Screen name="spaceSettings" component={SpaceSettingsScreen} />
        <Stack.Screen name="notificationsIntro" component={NotificationsIntroScreen} options={{ presentation: "fullScreenModal" }} />
        <Stack.Screen name="spaceMember" component={MemberSheet} options={sheet} />
        <Stack.Screen name="spaceDelete" component={DeleteSpaceScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="spaceNotify" component={SpaceNotifySheet} options={sheet} />
        <Stack.Screen name="spaceDefaultChannel" component={DefaultChannelSheet} options={{ ...sheet, sheetAllowedDetents: [0.6, 1] }} />
        <Stack.Screen name="tutorial" component={TutorialScreen} options={{ presentation: "fullScreenModal" }} />
        <Stack.Screen name="accountSheet" component={AccountSheet} options={sheet} />
        <Stack.Screen name="statusSheet" component={StatusSheet} options={sheet} />
        <Stack.Screen name="profile" component={ProfileScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="zonePicker" component={ZonePicker} options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
        <Stack.Screen name="preferences" component={PreferencesScreen} />
        <Stack.Screen name="languageSheet" component={LanguageSheet} options={sheet} />
        <Stack.Screen name="security" component={SecurityScreen} />
        <Stack.Screen name="changePassword" component={ChangePasswordScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="totp" component={TotpScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="recoveryCodes" component={RecoveryCodesScreen} options={{ presentation: "modal", gestureEnabled: false }} />
        <Stack.Screen name="help" component={HelpSheet} options={sheet} />
        <Stack.Screen name="messageActions" component={MessageActionSheet} options={sheet} />
        <Stack.Screen name="emojiPicker" component={EmojiPickerSheet} options={{ ...sheet, sheetAllowedDetents: [0.7, 1] }} />
        <Stack.Screen name="attachSheet" component={AttachSheet} options={sheet} />
        <Stack.Screen name="spaceFilePicker" component={SpaceFilePicker} options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
        <Stack.Screen name="newMessage" component={NewMessageSheet} options={sheet} />
        <Stack.Screen name="newConversation" component={NewConversationScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="newGroup" component={NewGroupScreen} options={{ presentation: "modal" }} />
        <Stack.Screen name="invite" component={InviteScreen} options={{ presentation: "modal" }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
