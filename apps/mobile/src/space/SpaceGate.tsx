import { acceptInvitation } from "@ruchoir/client";
import { useEffect, useState } from "react";

import { useTranslation } from "../i18n";
import { RootNavigator } from "../navigation/RootNavigator";
import { BootScreen } from "../screens/boot/BootScreen";
import { JoinSpaceScreen } from "../screens/space/JoinSpaceScreen";
import { useSession } from "../session/SessionProvider";
import { useToast } from "../ui/Toast";
import { useSpace } from "./SpaceProvider";

/**
 * What a signed-in person enters: the tabs, or "join or create a space" when the account is in none.
 * An invitation pasted at sign-up is accepted first, so the app opens in the space that invited them.
 */
export function SpaceGate() {
  const { t } = useTranslation();
  const toast = useToast();
  const session = useSession();
  const { status, select, spaces } = useSpace();
  const { reload } = spaces;
  // Taken once: the session hands the pending invitation to a single taker.
  const [invitation] = useState(() => session.takePendingInvitation());
  const [settled, setSettled] = useState(invitation === null);

  useEffect(() => {
    if (!invitation) return;
    let current = true;
    acceptInvitation(invitation).then(
      (space) => {
        if (!current) return;
        select(space.id);
        reload();
        setSettled(true);
      },
      () => {
        if (!current) return;
        toast(t("joinSpace.joinFailed"));
        setSettled(true);
      },
    );
    return () => {
      current = false;
    };
  }, [invitation, select, reload, toast, t]);

  if (!settled) return <BootScreen />;
  if (status === "none") return <JoinSpaceScreen gate />;
  return <RootNavigator />;
}
