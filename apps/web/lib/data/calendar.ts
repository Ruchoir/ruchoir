/**
 * The calendar's side of the API: calendars, occurrences of a period, events and their series, the
 * viewer's own settings, and iCal subscription addresses.
 *
 * Kept apart from `api.ts`, which is long enough already; the shapes follow the API's DTOs
 * (`apps/api/src/calendar/dto.rs`), renamed to the web's camelCase on the way in.
 */

import { apiDelete, apiGet, apiPatch, apiPost, apiPut, apiRequest } from "./http";

/** The palette's pastels a calendar may wear. */
/** A palette pastel, or `accent`: the viewer's own theme accent (what a personal calendar wears). */
export type CalendarColor = "accent" | "sky" | "mint" | "violet" | "pink" | "peach" | "lime" | "sun";
export const CALENDAR_COLORS: readonly CalendarColor[] = ["accent", "sky", "mint", "violet", "pink", "peach", "lime", "sun"];


export type Calendar = {
  id: string;
  /** Absent for a personal calendar. */
  spaceId?: string;
  name: string;
  description?: string;
  color: CalendarColor;
  writeAccess: "members" | "admins";
  /** The reminders a timed event gets by default, in minutes before it; empty is none. */
  defaultReminders: number[];
  isDefault: boolean;
  canWriteEvents: boolean;
  canManage: boolean;
  hidden: boolean;
  /** The viewer's own reminders for the whole calendar: `undefined` follows the defaults, empty is
   *  none. */
  myReminders?: number[];
};

export type Occurrence = {
  eventId: string;
  calendarId: string;
  recurrenceId?: string;
  title: string;
  location?: string;
  /** The occurrence's notes: its own when it was changed apart, else the series'. */
  description?: string;
  allDay: boolean;
  /** RFC 3339 (UTC) for a timed occurrence, `YYYY-MM-DD` for an all-day one. */
  start: string;
  end: string;
  tzid?: string;
  isRecurring: boolean;
  overridden: boolean;
  canEdit: boolean;
  /** The reminders the viewer gets for it, in minutes; empty when none. */
  myReminders: number[];
  /** The viewer's answer for this occurrence; `accepted` for the organiser of an event with
   *  attendees; absent for anyone not on its list. */
  myStatus?: AttendeeStatus;
  /** Seen through an invitation alone: its calendar is not the viewer's to see. */
  invited: boolean;
  hasAttendees: boolean;
};

/** An answer to an invitation. */
export type AttendeeStatus = "needs_action" | "accepted" | "tentative" | "declined";

export type Attendee = {
  id: string;
  userId?: string;
  /** For someone invited by address only. */
  email?: string;
  name: string;
  status: AttendeeStatus;
};

/** Someone on the list as the form sends it: an account, or an address. */
export type AttendeeInput = { userId: string } | { email: string; name?: string };

export type CalendarEvent = Occurrence & {
  rrule?: string;
  createdBy?: string;
  updatedAt: string;
  organizer?: { userId: string; name: string };
  attendees: Attendee[];
  /** The channel it is linked to. */
  channel?: EventChannel;
  /** The Drive files it carries, readable by whoever sees it. */
  files: EventFile[];
  /** The viewer's own reminders: `undefined` follows their calendar's, empty is none. */
  myOwnReminders?: number[];
};

/** The channel an event is linked to, as the viewer may know it: a private channel they are not in
 *  has no name. */
export type EventChannel = { id: string; name?: string; spaceId: string; private: boolean; accessible: boolean };

/** A channel an event may be linked to. */
export type LinkableChannel = { id: string; name: string; spaceId: string; spaceName: string; private: boolean };

/** A Drive file an event carries. */
export type EventFile = { id: string; name: string; size: number };

/** An event as its card in a channel shows it to the reader: its next occurrence. */
export type EventCard = {
  eventId: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  tzid?: string;
  location?: string;
  recurring: boolean;
  organizer?: string;
  organizerId?: string;
  myStatus?: AttendeeStatus;
  recurrenceId?: string;
};

/** An occurrence a channel lists as upcoming. */
export type UpcomingEvent = {
  eventId: string;
  recurrenceId?: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
};

/** Someone who may be invited. */
export type Invitee = { userId: string; name: string };

/** One person's busy times, RFC 3339 in UTC, merged. */
export type BusyTimes = { userId: string; busy: { start: string; end: string }[] };

/** An invitation as someone invited by address sees it, on its public page. */
export type PublicInvitation = {
  title: string;
  location?: string;
  description?: string;
  start: string;
  end: string;
  allDay: boolean;
  tzid?: string;
  recurring: boolean;
  organizer?: string;
  name?: string;
  status: AttendeeStatus;
  /** Files to download with the page's token. */
  files: EventFile[];
};

/** What the form sends for a new event or a change. */
export type EventInput = {
  title: string;
  description?: string;
  location?: string;
  allDay: boolean;
  start: string;
  end: string;
  tzid?: string;
  rrule?: string | null;
  /** The author's own reminders: `undefined` leaves them as they are, empty turns them off. */
  reminders?: number[];
  /** Another calendar to move the event to (whole-series changes only). */
  calendarId?: string;
  /** The whole list of attendees; `undefined` leaves it as it is. */
  attendees?: AttendeeInput[];
  /** The linked channel; `null` unlinks it, `undefined` leaves it as it is. */
  channelId?: string | null;
  /** The whole list of attached files; `undefined` leaves it as it is. */
  files?: string[];
};

export type EditScope = "this" | "following" | "all";

export type Feed = { id: string; calendarId?: string; createdAt: string; lastUsedAt?: string };
export type CreatedFeed = { id: string; calendarId?: string; url: string; createdAt: string };

type CalendarDto = {
  id: string;
  space_id?: string | null;
  name: string;
  description?: string | null;
  color: CalendarColor;
  write_access: "members" | "admins";
  default_reminders: number[];
  is_default: boolean;
  can_write_events: boolean;
  can_manage: boolean;
  hidden: boolean;
  my_reminders?: number[];
};

type OccurrenceDto = {
  event_id: string;
  calendar_id: string;
  recurrence_id?: string | null;
  title: string;
  location?: string | null;
  description?: string | null;
  all_day: boolean;
  start: string;
  end: string;
  tzid?: string | null;
  is_recurring: boolean;
  overridden: boolean;
  can_edit: boolean;
  my_reminders?: number[];
  my_status?: AttendeeStatus | null;
  invited?: boolean;
  has_attendees?: boolean;
};

type AttendeeDto = { id: string; user_id?: string | null; email?: string | null; name: string; status: AttendeeStatus };

type EventDto = OccurrenceDto & {
  rrule?: string | null;
  created_by?: string | null;
  updated_at: string;
  organizer?: { user_id: string; name: string } | null;
  attendees?: AttendeeDto[];
  channel?: { id: string; name?: string | null; space_id: string; private: boolean; accessible: boolean } | null;
  files?: EventFile[];
  my_own_reminders?: number[];
};

export type EventCardDto = {
  event_id: string;
  title: string;
  start: string;
  end: string;
  all_day: boolean;
  tzid?: string | null;
  location?: string | null;
  recurring: boolean;
  organizer?: string | null;
  organizer_id?: string | null;
  my_status?: AttendeeStatus | null;
  recurrence_id?: string | null;
};

type FeedDto = { id: string; calendar_id?: string | null; created_at: string; last_used_at?: string | null; url?: string };

function opt<T>(value: T | null | undefined): T | undefined {
  return value === null ? undefined : value;
}

function toCalendar(dto: CalendarDto): Calendar {
  return {
    id: dto.id,
    spaceId: opt(dto.space_id),
    name: dto.name,
    description: opt(dto.description),
    color: dto.color,
    writeAccess: dto.write_access,
    defaultReminders: dto.default_reminders ?? [],
    isDefault: dto.is_default,
    canWriteEvents: dto.can_write_events,
    canManage: dto.can_manage,
    hidden: dto.hidden,
    ...(dto.my_reminders !== undefined ? { myReminders: dto.my_reminders } : {}),
  };
}

function toOccurrence(dto: OccurrenceDto): Occurrence {
  return {
    eventId: dto.event_id,
    calendarId: dto.calendar_id,
    recurrenceId: opt(dto.recurrence_id),
    title: dto.title,
    location: opt(dto.location),
    description: opt(dto.description),
    allDay: dto.all_day,
    start: dto.start,
    end: dto.end,
    tzid: opt(dto.tzid),
    isRecurring: dto.is_recurring,
    overridden: dto.overridden,
    canEdit: dto.can_edit,
    myReminders: dto.my_reminders ?? [],
    myStatus: opt(dto.my_status),
    invited: dto.invited ?? false,
    hasAttendees: dto.has_attendees ?? false,
  };
}

function toEvent(dto: EventDto): CalendarEvent {
  return {
    ...toOccurrence(dto),
    rrule: opt(dto.rrule),
    createdBy: opt(dto.created_by),
    updatedAt: dto.updated_at,
    organizer: dto.organizer ? { userId: dto.organizer.user_id, name: dto.organizer.name } : undefined,
    attendees: (dto.attendees ?? []).map((a) => ({
      id: a.id,
      userId: opt(a.user_id),
      email: opt(a.email),
      name: a.name,
      status: a.status,
    })),
    channel: dto.channel
      ? {
          id: dto.channel.id,
          name: opt(dto.channel.name),
          spaceId: dto.channel.space_id,
          private: dto.channel.private,
          accessible: dto.channel.accessible,
        }
      : undefined,
    files: dto.files ?? [],
    ...(dto.my_own_reminders !== undefined ? { myOwnReminders: dto.my_own_reminders } : {}),
  };
}

/** A message's event card, as the API sends it. */
export function toEventCard(dto: EventCardDto): EventCard {
  return {
    eventId: dto.event_id,
    title: dto.title,
    start: dto.start,
    end: dto.end,
    allDay: dto.all_day,
    tzid: opt(dto.tzid),
    location: opt(dto.location),
    recurring: dto.recurring,
    organizer: opt(dto.organizer),
    organizerId: opt(dto.organizer_id),
    myStatus: opt(dto.my_status),
    recurrenceId: opt(dto.recurrence_id),
  };
}

function toFeed(dto: FeedDto): Feed {
  return { id: dto.id, calendarId: opt(dto.calendar_id), createdAt: dto.created_at, lastUsedAt: opt(dto.last_used_at) };
}

function eventBody(input: EventInput) {
  return {
    title: input.title,
    description: input.description,
    location: input.location,
    all_day: input.allDay,
    start: input.start,
    end: input.end,
    tzid: input.tzid,
    rrule: input.rrule ?? null,
    ...(input.reminders !== undefined ? { reminders: input.reminders } : {}),
    calendar_id: input.calendarId,
    ...(input.attendees
      ? { attendees: input.attendees.map((a) => ("userId" in a ? { user_id: a.userId } : { email: a.email, name: a.name })) }
      : {}),
    ...(input.channelId !== undefined ? { channel_id: input.channelId } : {}),
    ...(input.files ? { files: input.files } : {}),
  };
}

/** `GET /calendars`: every calendar the viewer sees, theirs first. */
export async function listCalendars(signal?: AbortSignal): Promise<Calendar[]> {
  return (await apiGet<CalendarDto[]>("/calendars", signal)).map(toCalendar);
}

type CalendarFields = {
  name: string;
  color: CalendarColor;
  description?: string;
  writeAccess?: "members" | "admins";
  defaultReminders?: number[];
};

function calendarBody(fields: Partial<CalendarFields>) {
  return {
    name: fields.name,
    color: fields.color,
    description: fields.description,
    write_access: fields.writeAccess,
    ...(fields.defaultReminders !== undefined ? { default_reminders: fields.defaultReminders } : {}),
  };
}

/** A new calendar: the viewer's own, or a space's (its administrators). */
export async function createCalendar(fields: CalendarFields, spaceId?: string): Promise<Calendar> {
  const path = spaceId ? `/spaces/${spaceId}/calendars` : "/calendars";
  return toCalendar(await apiPost<CalendarDto>(path, calendarBody(fields)));
}

export async function updateCalendar(id: string, fields: Partial<CalendarFields>): Promise<Calendar> {
  return toCalendar(await apiPatch<CalendarDto>(`/calendars/${id}`, calendarBody(fields)));
}

/** Delete a calendar and its events, typing its name as a confirmation. */
export async function deleteCalendar(id: string, confirmName: string): Promise<void> {
  await apiRequest<void>("DELETE", `/calendars/${id}`, { json: { confirm_name: confirmName } });
}

/** The viewer's own settings for a calendar: shown or hidden, their reminders (`"default"` follows
 *  the calendar's again). */
export async function setCalendarMe(id: string, me: { hidden?: boolean; reminders?: number[] | "default" }): Promise<void> {
  await apiPut<void>(`/calendars/${id}/me`, {
    hidden: me.hidden,
    ...(me.reminders === "default" ? { reminder_default: true } : me.reminders !== undefined ? { reminders: me.reminders } : {}),
  });
}

/** What happens in `[from, to)`, in the given calendars (every visible one by default), and the
 *  events seen through an invitation alone unless `invitations` is false. */
export async function listOccurrences(
  from: string,
  to: string,
  calendarIds?: string[],
  signal?: AbortSignal,
  invitations = true,
): Promise<Occurrence[]> {
  const params = new URLSearchParams({ from, to });
  if (calendarIds && calendarIds.length > 0) params.set("calendars", calendarIds.join(","));
  if (!invitations) params.set("invitations", "false");
  return (await apiGet<OccurrenceDto[]>(`/calendar/occurrences?${params}`, signal)).map(toOccurrence);
}

/** Where the PDF of a view is read: the same calendars and invitations as the screen, from the
 *  viewer's first day of the week (0 for Sunday). */
export function printUrl(view: "day" | "week" | "month" | "list" | "year", date: string, calendarIds: string[], invitations: boolean, weekStart: number): string {
  const params = new URLSearchParams({ view, date, week_start: String(weekStart) });
  if (calendarIds.length > 0) params.set("calendars", calendarIds.join(","));
  if (!invitations) params.set("invitations", "false");
  return `/api/v1/calendar/print?${params}`;
}

/** The events whose words hold `query`, each once: the coming ones on their next date, soonest
 *  first, then the past ones on their last, latest first. */
export async function searchEvents(query: string, signal?: AbortSignal): Promise<Occurrence[]> {
  const params = new URLSearchParams({ q: query });
  return (await apiGet<OccurrenceDto[]>(`/calendar/search?${params}`, signal)).map(toOccurrence);
}

export async function getEvent(id: string, signal?: AbortSignal): Promise<CalendarEvent> {
  return toEvent(await apiGet<EventDto>(`/events/${id}`, signal));
}

export async function createEvent(calendarId: string, input: EventInput): Promise<CalendarEvent> {
  return toEvent(await apiPost<EventDto>(`/calendars/${calendarId}/events`, eventBody(input)));
}

function scopeQuery(scope: EditScope, recurrenceId?: string): string {
  const params = new URLSearchParams({ scope });
  if (recurrenceId) params.set("recurrence_id", recurrenceId);
  return params.toString();
}

/** Change one occurrence, the following ones, or the whole series. Answers the changed event (the new
 *  series for `following`). */
export async function updateEvent(id: string, input: EventInput, scope: EditScope, recurrenceId?: string): Promise<CalendarEvent> {
  return toEvent(await apiPatch<EventDto>(`/events/${id}?${scopeQuery(scope, recurrenceId)}`, eventBody(input)));
}

export async function deleteEvent(id: string, scope: EditScope, recurrenceId?: string): Promise<void> {
  await apiDelete<void>(`/events/${id}?${scopeQuery(scope, recurrenceId)}`);
}

/** The viewer's own reminders for an event (its whole series); `"default"` follows their calendar
 *  setting again. */
export async function setEventMe(id: string, reminders: number[] | "default"): Promise<void> {
  await apiPut<void>(`/events/${id}/me`, reminders === "default" ? { reminder_default: true } : { reminders });
}

export async function listFeeds(signal?: AbortSignal): Promise<Feed[]> {
  return (await apiGet<FeedDto[]>("/calendar/feeds", signal)).map(toFeed);
}

/** A new subscription address, for one calendar or (`null`) for all of them. Its URL is shown once. */
export async function createFeed(calendarId: string | null): Promise<CreatedFeed> {
  const dto = await apiPost<FeedDto>("/calendar/feeds", { calendar_id: calendarId });
  return { ...toFeed(dto), url: dto.url ?? "" };
}

export async function revokeFeed(id: string): Promise<void> {
  await apiDelete<void>(`/calendar/feeds/${id}`);
}

/** Answer an invitation, for the series or for one date of it. */
export async function respondToEvent(id: string, status: Exclude<AttendeeStatus, "needs_action">, recurrenceId?: string): Promise<CalendarEvent> {
  return toEvent(await apiPut<EventDto>(`/events/${id}/response`, { status, recurrence_id: recurrenceId }));
}

/** Who may be invited to an event of this calendar, matching `query`; with `channel`, only that
 *  channel's members (all of them for an empty query: "invite the whole channel"). */
export async function searchInvitees(calendarId: string, query: string, signal?: AbortSignal, channel?: string): Promise<Invitee[]> {
  const params = new URLSearchParams({ q: query });
  if (channel) params.set("channel", channel);
  const found = await apiGet<{ user_id: string; name: string }[]>(`/calendars/${calendarId}/invitees?${params}`, signal);
  return found.map((p) => ({ userId: p.user_id, name: p.name }));
}

/** When some people are busy over `[from, to)` (31 days at most), leaving out `excludeEvent` (the one
 *  being moved). */
export async function freeBusy(userIds: string[], from: string, to: string, signal?: AbortSignal, excludeEvent?: string): Promise<BusyTimes[]> {
  const found = await apiRequest<{ user_id: string; busy: { start: string; end: string }[] }[]>("POST", "/calendar/freebusy", {
    json: { users: userIds, from, to, exclude_event: excludeEvent },
    signal,
  });
  return found.map((p) => ({ userId: p.user_id, busy: p.busy }));
}

type PublicInvitationDto = {
  title: string;
  location?: string | null;
  description?: string | null;
  start: string;
  end: string;
  all_day: boolean;
  tzid?: string | null;
  recurring: boolean;
  organizer?: string | null;
  name?: string | null;
  status: AttendeeStatus;
  files?: EventFile[];
};

function toPublicInvitation(dto: PublicInvitationDto): PublicInvitation {
  return {
    title: dto.title,
    location: opt(dto.location),
    description: opt(dto.description),
    start: dto.start,
    end: dto.end,
    allDay: dto.all_day,
    tzid: opt(dto.tzid),
    recurring: dto.recurring,
    organizer: opt(dto.organizer),
    name: opt(dto.name),
    status: dto.status,
    files: dto.files ?? [],
  };
}

/** Where someone invited by address downloads a file of the event, with their page's token. */
export function invitationFileUrl(token: string, fileId: string): string {
  return `/api/v1/public/invitation/${encodeURIComponent(token)}/files/${fileId}`;
}

/** The channels an event of this calendar may be linked to, by space then by name. */
export async function listLinkableChannels(calendarId: string, signal?: AbortSignal): Promise<LinkableChannel[]> {
  const found = await apiGet<{ id: string; name: string; space_id: string; space_name: string; private: boolean }[]>(
    `/calendars/${calendarId}/channels`,
    signal,
  );
  return found.map((c) => ({ id: c.id, name: c.name, spaceId: c.space_id, spaceName: c.space_name, private: c.private }));
}

/** A channel's next linked occurrences (three at most, within two months). */
export async function listChannelEvents(channelId: string, signal?: AbortSignal): Promise<UpcomingEvent[]> {
  const found = await apiGet<
    { event_id: string; recurrence_id?: string | null; title: string; start: string; end: string; all_day: boolean; location?: string | null }[]
  >(`/channels/${channelId}/events`, signal);
  return found.map((u) => ({
    eventId: u.event_id,
    recurrenceId: opt(u.recurrence_id),
    title: u.title,
    start: u.start,
    end: u.end,
    allDay: u.all_day,
    location: opt(u.location),
  }));
}

/** Where files dropped for an event of this calendar go: its space's "Agenda" folder (for a personal
 *  calendar, that of the linked channel's space). */
export async function eventAttachmentFolder(calendarId: string, channelId?: string, signal?: AbortSignal): Promise<{ spaceId: string; folderId: string }> {
  const query = channelId ? `?channel=${channelId}` : "";
  const found = await apiGet<{ space_id: string; folder_id: string }>(`/calendars/${calendarId}/attachment-folder${query}`, signal);
  return { spaceId: found.space_id, folderId: found.folder_id };
}

/** `GET /public/invitation/{token}`: no session needed. A `404` means it is no longer there. */
export async function readInvitation(token: string, signal?: AbortSignal): Promise<PublicInvitation> {
  return toPublicInvitation(await apiGet<PublicInvitationDto>(`/public/invitation/${encodeURIComponent(token)}`, signal));
}

/** Answer an invitation from its public page, for every date. */
export async function answerInvitation(token: string, status: Exclude<AttendeeStatus, "needs_action">): Promise<PublicInvitation> {
  return toPublicInvitation(await apiPost<PublicInvitationDto>(`/public/invitation/${encodeURIComponent(token)}`, { status }));
}
