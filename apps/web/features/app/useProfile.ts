"use client";

import { useEffect, useState } from "react";
import type { Profile } from "@/lib/data";
import { getUserProfile } from "@/lib/data/api";

/** A minimal profile placeholder built from a display name, before (or without) a real fetch. */
export function minimalProfile(name: string): Profile {
  return {
    name,
    presence: "offline",
    email: "",
    // No timezone: this is the placeholder shown while the real profile loads, and inventing one
    // here is how every profile came to report Europe/Paris in the first place.
  };
}

/**
 * Profiles already read in this session, by user id.
 *
 * A profile card opened on the placeholder grew once the real profile landed (a role, a local
 * time, a bio), and the popover holding it moved or flipped above its anchor to make room: a
 * visible jump on every opening. Serving the last known profile first, and refreshing it behind,
 * makes a second opening instant, and `prefetchProfile` lets a first one wait for its data.
 */
const profiles = new Map<string, Profile>();
const inFlight = new Map<string, Promise<Profile>>();

/** Read a profile into the cache, sharing the request with any other caller asking meanwhile. */
export function prefetchProfile(userId: string): Promise<Profile> {
  const pending = inFlight.get(userId);
  if (pending) return pending;
  const request = getUserProfile(userId)
    .then((profile) => {
      profiles.set(userId, profile);
      return profile;
    })
    .finally(() => inFlight.delete(userId));
  inFlight.set(userId, request);
  return request;
}

/**
 * Fetch a member's real profile from the API by id, falling back to a minimal profile derived from
 * the display name while it loads or when the id is unknown. A profile read earlier is shown at
 * once and refreshed, so an edit made since still arrives.
 */
export function useProfile(userId: string | undefined, name: string): Profile {
  const [fetched, setFetched] = useState<Profile | null>(() => (userId ? profiles.get(userId) ?? null : null));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFetched(userId ? profiles.get(userId) ?? null : null);
    if (!userId) return;
    let active = true;
    prefetchProfile(userId)
      .then((profile) => active && setFetched(profile))
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [userId]);
  return fetched ?? minimalProfile(name);
}
