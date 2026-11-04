/**
 * What the sharing screens read: the access of one channel, file, folder or calendar, the names its
 * lines carry (people, groups, roles), and the way out when the thing is deleted meanwhile. Every
 * screen of the flow reads it for itself; the one that writes says so with a local `permissions` event.
 */
import { isApiError, type AccessKind, type AccessView, type Group, type Member, type Role } from "@ruchoir/client";
import { useNavigation } from "@react-navigation/native";
import { useEffect, useRef } from "react";

import { useApi } from "../../api/useApi";
import { useLoad } from "../../data/useLoad";
import { useReloadOn } from "../../data/useReloadOn";
import { useTranslation } from "../../i18n";
import { affects } from "../../realtime/events";
import { useSpace } from "../../space/SpaceProvider";
import { useToast } from "../../ui/Toast";

type Answer = { view: AccessView } | { gone: true };

/** The access of a resource, read again when the rules or the thing itself change. `toastWhenGone`: the screen that closes says why. */
export function useAccess(kind: AccessKind, resourceId: string, opts: { toastWhenGone: boolean }) {
  const { getAccess } = useApi();
  const { current } = useSpace();
  const navigation = useNavigation();
  const toast = useToast();
  const { t } = useTranslation();
  const spaceId = current?.id;
  const loaded = useLoad(spaceId ? `access:${spaceId}:${kind}:${resourceId}` : null, async (): Promise<Answer> => {
    try {
      return { view: await getAccess(spaceId!, kind, resourceId) };
    } catch (err) {
      // Deleted, or no longer reachable by this person: nothing to show any more.
      if (isApiError(err, 404)) return { gone: true };
      throw err;
    }
  });
  useReloadOn((e) => !!spaceId && affects.access(e, kind, spaceId, resourceId), loaded.reload, 300);

  const gone = loaded.data !== undefined && "gone" in loaded.data;
  const leaving = useRef(false);
  useEffect(() => {
    if (!gone || leaving.current) return;
    leaving.current = true;
    if (opts.toastWhenGone) toast(t("access.gone"));
    if (navigation.canGoBack()) navigation.goBack();
  }, [gone, navigation, toast, t, opts.toastWhenGone]);

  const view = loaded.data && "view" in loaded.data ? loaded.data.view : undefined;
  return { spaceId, view, gone, error: loaded.error, reload: loaded.reload };
}

/** The people, groups and roles a line can be named after. A failed read leaves the lines unnamed rather than the screen empty. */
export function useAccessNames(spaceId: string | undefined): { members: Member[]; groups: Group[]; roles: Role[] } {
  const { getSpaceMembers, listGroups, listRoles } = useApi();
  const members = useLoad(spaceId ? `members:${spaceId}` : null, (signal) => getSpaceMembers(spaceId!, signal));
  const groups = useLoad(spaceId ? `groups:${spaceId}` : null, () => listGroups(spaceId!));
  const roles = useLoad(spaceId ? `roles:${spaceId}` : null, () => listRoles(spaceId!));
  useReloadOn((e) => !!spaceId && affects.permissions(e, spaceId), () => {
    groups.reload();
    roles.reload();
  }, 300);
  return { members: members.data ?? [], groups: groups.data ?? [], roles: roles.data ?? [] };
}
