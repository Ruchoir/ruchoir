import type { Group, Member } from "@ruchoir/client";
import { useMemo } from "react";

import { useApi } from "../api/useApi";
import { useLoad } from "./useLoad";
import { affects } from "../realtime/events";
import { useReloadOn } from "./useReloadOn";

/** The people of a space: who wrote what, their pictures, and the names a mention can take. */
export function useSpaceMembers(spaceId: string | undefined) {
  const { getSpaceMembers, listGroups } = useApi();
  const members = useLoad(spaceId ? `members:${spaceId}` : null, (signal) => getSpaceMembers(spaceId!, signal));
  // A new photo or name shows at once, not at the next launch; so does someone joining or leaving.
  useReloadOn((e) => !!spaceId && affects.members(e, spaceId), members.reload, 300);
  // The groups a mention can name, under the key the groups screens use, so one request serves all.
  const groups = useLoad(spaceId ? `groups:${spaceId}` : null, () => listGroups(spaceId!));
  useReloadOn((e) => !!spaceId && affects.permissions(e, spaceId), groups.reload, 300);
  const list = members.data;
  const groupList: Group[] | undefined = groups.data;
  return useMemo(() => {
    const byName = new Map<string, Member>();
    for (const m of list ?? []) byName.set(m.name, m);
    return {
      list: list ?? [],
      avatarOf: (name: string) => byName.get(name)?.avatarUrl,
      mentionNames: mentionNames(list ?? []),
      groups: groupList ?? [],
    };
  }, [list, groupList]);
}

/**
 * Every spelling a mention can take, as the server resolves them (the web's `getMentionNames`): the
 * display name, its first word, the name without spaces, and the room-wide handles in both languages.
 */
export function mentionNames(members: Pick<Member, "name">[]): string[] {
  const names = new Set(["canal", "ici", "channel", "here", "tous", "everyone", "all"]);
  for (const { name } of members) {
    names.add(name);
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length > 1) {
      names.add(words[0]);
      names.add(words.join(""));
    }
  }
  return [...names];
}
