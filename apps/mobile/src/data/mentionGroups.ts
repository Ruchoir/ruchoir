import type { Group, RuchoirClient } from "@ruchoir/client";
import { useEffect, useReducer } from "react";

import { useFeature } from "../api/features";
import { useApi } from "../api/useApi";
import { createGroupStore, mayListGroups } from "../logic/mentionGroups";
import { affects } from "../realtime/events";
import { useResync } from "../realtime/RealtimeProvider";
import { useSpace } from "../space/SpaceProvider";
import { useReloadOn } from "./useReloadOn";

const store = createGroupStore<RuchoirClient>((client, spaceId, signal) => client.listGroups(spaceId, signal));

const NONE: Group[] = [];

/**
 * The groups a `@` can name in the open space, for the screens that write or read messages (the
 * conversation, a thread). Not part of `useSpaceMembers`: most screens never mention anyone, and a
 * guest or a role without `members.view` would be refused on every one of them. Skipped (and empty)
 * for those; one request is shared by every screen watching the same space.
 */
export function useMentionGroups(spaceId: string | undefined): Group[] {
  const api = useApi();
  const { current } = useSpace();
  const supported = useFeature("permissions") === true;
  const enabled = !!spaceId && current?.id === spaceId && mayListGroups(current, supported);
  const [, bump] = useReducer((n: number) => n + 1, 0);
  const resync = useResync();
  useEffect(() => {
    if (!enabled) return;
    return store.watch(api, spaceId!, bump);
  }, [api, spaceId, enabled]);
  // A role or group changing, or coming back online, may change what can be named.
  useReloadOn((e) => enabled && affects.permissions(e, spaceId!), () => store.reload(api, spaceId!), 300);
  useEffect(() => {
    if (enabled && resync > 0) store.reload(api, spaceId!);
  }, [resync, api, spaceId, enabled]);
  return (enabled ? store.read(api, spaceId!) : undefined) ?? NONE;
}
