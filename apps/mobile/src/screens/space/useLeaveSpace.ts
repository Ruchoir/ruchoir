/**
 * "Leave the space", from the space sheet and the settings' danger zone: a confirmation, then the
 * space list read again and the app back on its tabs, on the next space (or "join a space" when
 * none is left). The last owner is told why the server refuses (409), as on the web.
 */
import { isApiError, leaveSpace, type Workspace } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useCallback } from "react";
import { Alert } from "react-native";

import { useTranslation } from "../../i18n";
import type { RootParams } from "../../navigation/types";
import { useSpace } from "../../space/SpaceProvider";
import { useToast } from "../../ui/Toast";

export function useLeaveSpace(): (space: Workspace) => void {
  const { t } = useTranslation();
  const toast = useToast();
  const { spaces } = useSpace();
  const { reload } = spaces;
  const navigation = useNavigation<NativeStackNavigationProp<RootParams>>();

  return useCallback(
    (space: Workspace) =>
      Alert.alert(t("spaceAdmin.leaveTitle", { name: space.name }), t("spaceAdmin.leaveBody"), [
        { text: t("compose.cancel"), style: "cancel" },
        {
          text: t("spaceAdmin.leaveConfirm"),
          style: "destructive",
          onPress: () =>
            void leaveSpace(space.id).then(
              () => {
                toast(t("spaceAdmin.left"));
                reload();
                // From the settings, back to the tabs; from the space sheet, already there.
                if (navigation.canGoBack()) navigation.popToTop();
              },
              (err) => {
                if (isApiError(err, 409)) Alert.alert(t("spaceAdmin.leave"), t("spaceAdmin.leaveLastOwner"));
                else toast(t("spaceAdmin.leaveFailed"), "failure");
              },
            ),
        },
      ]),
    [t, toast, reload, navigation],
  );
}
