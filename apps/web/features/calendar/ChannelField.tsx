"use client";

import { useEffect, useState } from "react";
import { Button, Select } from "@/components/ds";
import { listLinkableChannels, searchInvitees, type EventChannel, type Invitee, type LinkableChannel } from "@/lib/data/calendar";
import { useTranslation } from "@/lib/i18n";

/**
 * The channel an event is linked to: none, or one of those its calendar's events may be linked to
 * (the public channels of the calendar's space and the private ones the author is in; for a personal
 * calendar, those of every space of theirs, grouped by space). Once one is chosen, "Invite the whole
 * channel" adds its members to the list.
 *
 * A private channel the author is not in, already linked by someone else, stays offered under the
 * name the event gives it, so that saving does not unlink it.
 */
export function ChannelField({
  calendarId,
  value,
  current,
  onChange,
  onInviteAll,
}: {
  calendarId: string;
  value: string | null;
  /** The channel the event was linked to when the form opened. */
  current?: EventChannel;
  onChange: (next: string | null) => void;
  /** The channel's members who may be invited. */
  onInviteAll: (people: Invitee[]) => void;
}) {
  const { t } = useTranslation();
  const [channels, setChannels] = useState<{ calendarId: string; list: LinkableChannel[] } | null>(null);
  const [inviting, setInviting] = useState(false);

  useEffect(() => {
    if (!calendarId) return;
    const abort = new AbortController();
    listLinkableChannels(calendarId, abort.signal)
      .then((list) => setChannels({ calendarId, list }))
      .catch(() => {
        // An aborted read is a newer one on its way, not an empty list.
        if (!abort.signal.aborted) setChannels({ calendarId, list: [] });
      });
    return () => abort.abort();
  }, [calendarId]);

  const list = channels?.calendarId === calendarId ? channels.list : null;
  // A calendar changed for one whose events may not be linked to the channel chosen: unlinked.
  useEffect(() => {
    if (!list || !value || value === current?.id) return;
    if (!list.some((c) => c.id === value)) onChange(null);
  }, [list, value, current?.id, onChange]);

  const kept = current && value === current.id && !list?.some((c) => c.id === current.id) ? current : undefined;
  const spaces = [...new Set((list ?? []).map((c) => c.spaceId))];
  const label = (c: { name: string; private: boolean }) => (c.private ? `${c.name} (${t("calendar.privateTag")})` : `#${c.name}`);
  const inviteAll = async () => {
    if (!value) return;
    setInviting(true);
    try {
      onInviteAll(await searchInvitees(calendarId, "", undefined, value));
    } catch {
      // Nobody added: the button stays there to try again.
    } finally {
      setInviting(false);
    }
  };

  return (
    <>
      <Select
        id="event-channel"
        size="sm"
        aria-label={t("calendar.channel")}
        value={value ?? ""}
        disabled={!list}
        onChange={(e) => onChange(e.target.value || null)}
        style={{ width: "100%" }}
      >
        <option value="">{t("calendar.noChannel")}</option>
        {kept ? <option value={kept.id}>{kept.name ? label({ name: kept.name, private: kept.private }) : t("sidebar.privateChannel")}</option> : null}
        {spaces.length > 1
          ? spaces.map((space) => {
              const of = (list ?? []).filter((c) => c.spaceId === space);
              return (
                <optgroup key={space} label={of[0]?.spaceName ?? ""}>
                  {of.map((c) => (
                    <option key={c.id} value={c.id}>
                      {label(c)}
                    </option>
                  ))}
                </optgroup>
              );
            })
          : (list ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                {label(c)}
              </option>
            ))}
      </Select>
      {value ? (
        <Button type="button" size="sm" variant="ghost" iconLeft="users" disabled={inviting} onClick={() => void inviteAll()}>
          {t("calendar.inviteChannel")}
        </Button>
      ) : null}
    </>
  );
}
