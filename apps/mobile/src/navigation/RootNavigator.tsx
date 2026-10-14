import { DarkTheme, DefaultTheme, NavigationContainer, type Theme } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { AttachSheet } from "../compose/AttachSheet";
import { AccountSheet } from "../screens/account/AccountSheet";
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
import { TrashScreen } from "../screens/files/TrashScreen";
import { UploadsSheet } from "../screens/files/UploadsSheet";
import { VersionsSheet } from "../screens/files/VersionsSheet";
import { SpaceSheet } from "../screens/space/SpaceSheet";
import { fonts } from "../theme/fonts";
import { useTheme } from "../theme/useTheme";
import { Tabs } from "./Tabs";
import type { RootParams } from "./types";

const Stack = createNativeStackNavigator<RootParams>();

/** The signed-in app: the tabs, the screens pushed over them, and the sheets. */
export function RootNavigator() {
  const { c, dark } = useTheme();
  const base = dark ? DarkTheme : DefaultTheme;
  const theme: Theme = {
    ...base,
    colors: { ...base.colors, primary: c.ink, background: c.bg, card: c.surface, text: c.ink, border: c.line, notification: c.alarm },
    fonts: {
      regular: { fontFamily: fonts.sans, fontWeight: "400" },
      medium: { fontFamily: fonts.sansMedium, fontWeight: "500" },
      bold: { fontFamily: fonts.sansSemibold, fontWeight: "600" },
      heavy: { fontFamily: fonts.sansBold, fontWeight: "700" },
    },
  };
  const sheet = { presentation: "formSheet", sheetAllowedDetents: "fitToContents", sheetGrabberVisible: true, headerShown: false } as const;

  return (
    <NavigationContainer theme={theme}>
      <Stack.Navigator screenOptions={{ headerShown: false }}>
        <Stack.Screen name="tabs" component={Tabs} />
        <Stack.Screen name="conversation" component={ConversationScreen} />
        <Stack.Screen name="thread" component={ThreadScreen} />
        <Stack.Screen name="conversationDetails" component={ConversationDetails} />
        <Stack.Screen name="folder" component={FolderScreen} />
        <Stack.Screen name="trash" component={TrashScreen} />
        <Stack.Screen name="fileViewer" component={FileViewerScreen} options={{ presentation: "fullScreenModal" }} />
        <Stack.Screen name="eventSummary" component={EventSummarySheet} options={{ ...sheet, sheetAllowedDetents: [0.75, 1] }} />
        <Stack.Screen name="eventForm" component={EventFormScreen} options={{ presentation: "fullScreenModal" }} />
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
        <Stack.Screen name="spaceSheet" component={SpaceSheet} options={{ ...sheet, sheetAllowedDetents: [0.5, 1] }} />
        <Stack.Screen name="accountSheet" component={AccountSheet} options={sheet} />
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
