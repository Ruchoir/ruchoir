import type { Member } from "@ruchoir/client";
import { useMemo } from "react";

import { useApi } from "../api/useApi";
import { useLoad } from "./useLoad";
import { affects } from "../realtime/events";
import { useReloadOn } from "./useReloadOn";

/** The people of a space: who wrote what, their pictures, and the names a mention can take. */
export function useSpaceMembers(spaceId: string | undefined) {
  const { getSpaceMembers } = useApi();
  const members = useLoad(spaceId ? `members:${spaceId}` : null, (signal) => getSpaceMembers(spaceId!, signal));
  // A new photo or name shows at once, not at the next launch; so does someone joining or leaving.
  useReloadOn((e) => !!spaceId && affects.members(e, spaceId), members.reload, 300);
  const list = members.data;
  return useMemo(() => {
    const byName = new Map<string, Member>();
    for (const m of list ?? []) byName.set(m.name, m);
    return { list: list ?? [], avatarOf: (name: string) => byName.get(name)?.avatarUrl, mentionNames: mentionNames(list ?? []) };
  }, [list]);
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
