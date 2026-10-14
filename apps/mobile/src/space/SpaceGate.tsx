import { acceptInvitation, getUserProfile } from "@ruchoir/client";
import { useEffect, useState } from "react";

import { useTranslation } from "../i18n";
import { RootNavigator } from "../navigation/RootNavigator";
import { useRealtimeEvent } from "../realtime/RealtimeProvider";
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
  const me = session.state.kind === "signedIn" ? session.state.user.id : null;
  const { updateUser } = session;

  // My photo is not in the session's answer: read it once from my profile, then keep it current from
  // the live changes, mine on another device included.
  useEffect(() => {
    if (!me) return;
    let current = true;
    getUserProfile(me).then(
      (profile) => current && updateUser({ avatarUrl: profile.avatarUrl }),
      () => {},
    );
    return () => {
      current = false;
    };
  }, [me, updateUser]);
  useRealtimeEvent((event) => {
    if (event.type === "member" && event.member.userId === me) updateUser({ name: event.member.name, avatarUrl: event.member.avatarUrl });
  });

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
