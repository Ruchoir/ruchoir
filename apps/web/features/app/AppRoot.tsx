"use client";

import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getChannelMembers, getPresence, setChannelMembers, setCurrentUser, setUserPresence } from "@/lib/data";
import {
  acceptInvitation,
  addReaction,
  type ApiNotification,
  connectRealtime,
  createInvitation,
  createChannel as apiCreateChannel,
  createDm,
  createSpace,
  deleteMessage,
  editMessage,
  getChannels,
  getChannelMessages,
  getDirectMessages,
  getFolder,
  getInvitations,
  getNotifications,
  getSession,
  getSpaceMembers,
  getSpacePresence,
  getWorkspaces,
  joinChannel as apiJoinChannel,
  leaveChannel as apiLeaveChannel,
  type Member,
  login as apiLogin,
  logout as apiLogout,
  type MfaMethod,
  markAllNotificationsRead,
  markNotificationRead,
  confirmEmailVerification,
  confirmPasswordReset,
  register as apiRegister,
  previewInvitation,
  requestEmailVerification,
  requestPasswordReset,
  revokeInvitation,
  verifyPasskey,
  verifyRecoveryCode,
  verifyTotp,
  type RealtimeConnection,
  type RealtimeReaction,
  removeReaction,
  sendMessage,
  setMessagePinned,
  setMessageSaved,
  setMyPresence as apiSetMyPresence,
  setReadCursor,
  type SessionUser,
  updateChannel as apiUpdateChannel,
} from "@/lib/data/api";
import { apiErrorCode, isApiError } from "@/lib/data/http";
import { clearAuthLink, forgetInvite, readAuthLink, readRememberedInvite, rememberInvite } from "@/lib/authLink";
import type { Channel, DirectMessage, Invitation, InvitationPreview, Message, SpaceFile, Workspace } from "@/lib/data";
import { Button, Dialog, Drawer, Textarea } from "@/components/ds";
import type { Presence } from "@/components/ds";
import { ChannelScreen } from "@/features/channel/ChannelScreen";
import { ChannelNotificationsDialog, ChannelSettingsDialog } from "@/features/channel/ChannelDialogs";
import { LoginScreen } from "@/features/auth/LoginScreen";
import { SignupScreen, type SignupValues } from "@/features/auth/SignupScreen";
import { OnboardingFlow } from "@/features/auth/OnboardingFlow";
import { ForgotPasswordScreen } from "@/features/auth/ForgotPasswordScreen";
import { MfaChallengeScreen } from "@/features/auth/MfaChallengeScreen";
import { ResetPasswordScreen } from "@/features/auth/ResetPasswordScreen";
import { InviteScreen, type InviteStatus } from "@/features/auth/InviteScreen";
import { VerifyEmailScreen, type VerifyEmailStatus } from "@/features/auth/VerifyEmailScreen";
import { FilesScreen } from "@/features/files/FilesScreen";
import { WorkspaceSettings } from "@/features/settings/WorkspaceSettings";
import { ImportDialog } from "@/features/import/ImportDialog";
import { ActivityView } from "./ActivityView";
import { collectMentions, collectSaved, collectThreads, type MessageMap } from "./activity";
import { HelpDialog, InviteDialog, NewChannelDialog, NewMessageDialog, NewWorkspaceDialog } from "./dialogs";
import { GettingStarted } from "./GettingStarted";
import { GlobalSearchDialog } from "./GlobalSearchDialog";
import { QuickSwitcher } from "./QuickSwitcher";
import { useGlobalShortcuts } from "./useGlobalShortcuts";
import { useMountAnimation } from "./useMountAnimation";
import {
  type AppNotification,
  type ChannelNotifPref,
  DEFAULT_CHANNEL_PREF,
  type NotifKind,
  passesPref,
} from "./notifications";
import { PreferencesScreen, type PrefTab } from "./PreferencesScreen";
import { SettingsProvider, useSettings } from "./settings";
import { Sidebar } from "./Sidebar";
import type { AppView, ChannelPanel, Toast } from "./types";
import { WorkspaceRail } from "./WorkspaceRail";
import { readDeepLink } from "@/lib/dev/deeplink";
import { useCompact } from "./useCompact";
import { MobileTopBar } from "./MobileTopBar";
import { BottomTabs } from "./BottomTabs";

/** Wraps the app in the settings provider (emoji rendering, etc.). */
export function AppRoot() {
  return (
    <SettingsProvider>
      <AppShell />
    </SettingsProvider>
  );
}

type Modal = "import" | "newChannel" | "newMessage" | "invite" | "newWorkspace" | "help" | "search" | "switcher" | null;

const toastStyle: Record<string, CSSProperties> = {
  wrap: { position: "fixed", right: 20, bottom: 20, zIndex: 60 },
  card: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
    minWidth: 240,
    maxWidth: 360,
    padding: "10px 14px",
    borderRadius: "var(--radius-md)",
    background: "var(--surface-inverse)",
    color: "var(--text-inverse)",
    boxShadow: "var(--shadow-dialog)",
  },
  title: { fontSize: 13, fontWeight: 600 },
  desc: { fontSize: 12, color: "var(--grey-300)" },
};

/** A message that only exists client-side: an optimistic send not yet acknowledged by the API. */
function isPendingId(id: string): boolean {
  return id.startsWith("tmp-");
}

/** Insert or replace a message in a conversation's list (realtime `message.created`, de-duped by id). */
function upsertMessage(map: MessageMap, conv: string, m: Message): MessageMap {
  const list = map[conv] ?? [];
  const idx = list.findIndex((x) => x.id === m.id);
  if (idx === -1) return { ...map, [conv]: [...list, m] };
  const next = list.slice();
  next[idx] = m;
  return { ...map, [conv]: next };
}

/** Replace a message already present in a conversation (realtime `message.updated`/`deleted`). */
function replaceMessage(map: MessageMap, conv: string, m: Message): MessageMap {
  const list = map[conv] ?? [];
  if (!list.some((x) => x.id === m.id)) return map;
  return { ...map, [conv]: list.map((x) => (x.id === m.id ? m : x)) };
}

/** Apply another user's reaction delta to a message's buckets (our own deltas are already optimistic). */
function applyReactionDelta(map: MessageMap, conv: string, r: RealtimeReaction): MessageMap {
  const list = map[conv] ?? [];
  const idx = list.findIndex((x) => x.id === r.messageId);
  if (idx === -1) return map;
  const msg = list[idx];
  const reactions = (msg.reactions ?? []).map((x) => ({ ...x }));
  const ri = reactions.findIndex((x) => x.emoji === r.emoji);
  if (r.added) {
    if (ri === -1) reactions.push({ emoji: r.emoji, count: 1 });
    else reactions[ri] = { ...reactions[ri], count: reactions[ri].count + 1 };
  } else if (ri !== -1) {
    const count = reactions[ri].count - 1;
    if (count <= 0) reactions.splice(ri, 1);
    else reactions[ri] = { ...reactions[ri], count };
  }
  const next = list.slice();
  next[idx] = { ...msg, reactions: reactions.length ? reactions : undefined };
  return { ...map, [conv]: next };
}

/**
 * The screen the shell is showing: one of the authentication steps, or the app itself. The flow is
 * login -> (second factor) -> app, with sign-up, password reset and email confirmation branching off
 * it; the emailed links land straight on `verify` and `reset`.
 */
type AuthStage = "login" | "signup" | "mfa" | "forgot" | "reset" | "verify" | "invite" | "onboarding" | "app";

/**
 * French copy for each authentication failure the API can report. The API answers with a
 * machine-readable code (`{ "error": "email_taken", … }`) plus an English message meant for
 * operators; the client owns what the user reads.
 */
const AUTH_MESSAGES: Record<string, string> = {
  invalid_credentials: "Adresse ou mot de passe incorrect.",
  unauthorized: "Votre session a expiré. Connectez-vous à nouveau.",
  email_taken: "Un compte existe déjà avec cette adresse.",
  weak_password: "Ce mot de passe est trop court : 12 caractères au minimum.",
  breached_password: "Ce mot de passe apparaît dans une fuite de données connue. Choisissez-en un autre.",
  account_locked: "Ce compte est verrouillé. Contactez votre administrateur.",
  too_many_attempts: "Trop de tentatives. Réessayez dans quelques minutes.",
  email_not_verified: "Confirmez votre adresse électronique avant de vous connecter.",
  invalid_token: "Ce lien est invalide ou a expiré.",
  invalid_code: "Code incorrect. Vérifiez-le et réessayez.",
};

/** The message to show for a failed auth request: the mapped code, else the caller's fallback. */
function authMessage(err: unknown, fallback: string): string {
  const code = apiErrorCode(err);
  return (code && AUTH_MESSAGES[code]) || fallback;
}

/**
 * Client root of the app shell. Holds the authentication stage, the navigation state and the domain
 * state loaded from the API: it boots against `GET /auth/session`, drives the whole authentication
 * flow, then keeps the space's channels, DMs, feeds and realtime updates in state for the screens.
 */
function AppShell() {
  const settings = useSettings();

  // The signed-in user, resolved from the session at boot. `currentUser` (the display name) is read
  // throughout the shell; it is empty until the session loads, but the app view is gated behind the
  // boot below, so nothing renders against an empty name.
  const [session, setSession] = useState<SessionUser | null>(null);
  const currentUser = session?.name ?? "";
  // Boot lifecycle: `booting` covers the initial session check and data load; `bootError` holds a
  // fatal load failure (the API being unreachable), distinct from a 401 which sends us to the login.
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  // Shared by every screen of the authentication flow: the message under the form, and whether a
  // request is in flight. They are reset on each stage change so an error never leaks across screens.
  const [authError, setAuthError] = useState<string | null>(null);
  const [authPending, setAuthPending] = useState(false);
  /** True once a link (verification or reset) has been sent from the current screen. */
  const [authSent, setAuthSent] = useState(false);

  const [authStage, setAuthStage] = useState<AuthStage>("app");
  /** The pending second-factor challenge returned by sign-in, until it is completed or abandoned. */
  const [mfaChallenge, setMfaChallenge] = useState<{ methods: MfaMethod[]; mfaToken: string } | null>(null);
  /** Address awaiting confirmation (just registered, or refused at sign-in as unverified). */
  const [pendingEmail, setPendingEmail] = useState("");
  /** First name of the signed-in user, to greet them through onboarding. */
  const [signupFirst, setSignupFirst] = useState("");
  /** Token carried by an emailed link, held in memory only (the address bar is cleared on arrival). */
  const [linkToken, setLinkToken] = useState("");
  const [verifyStatus, setVerifyStatus] = useState<VerifyEmailStatus>("sent");
  const [resetDone, setResetDone] = useState(false);
  /**
   * An invitation the visitor arrived with, held across the whole authentication flow: they may have
   * to sign in or register first, and the token has to survive that. Kept in memory only, like the
   * other emailed tokens.
   */
  const [inviteToken, setInviteToken] = useState("");
  const [invitePreview, setInvitePreview] = useState<InvitationPreview | null>(null);
  const [inviteStatus, setInviteStatus] = useState<InviteStatus>("loading");
  /** The current space's outstanding invitations, loaded when the invite dialog opens. */
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [dms, setDms] = useState<DirectMessage[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  // The space's files (root folder), for the in-channel file panel and search. The full Files screen
  // manages its own folder navigation separately.
  const [spaceFiles, setSpaceFiles] = useState<SpaceFile[]>([]);
  const [messages, setMessages] = useState<MessageMap>({});
  // Notification inbox, loaded from the API feed and mutated in place (read state); realtime
  // `notification.created` events prepend to it.
  const [notifs, setNotifs] = useState<AppNotification[]>([]);
  // Live presence by user id (space snapshot + realtime events), and who is typing in each
  // conversation (user id -> last-seen ms, so stale signals expire).
  const [presence, setPresence] = useState<Record<string, Presence>>({});
  const [typing, setTyping] = useState<Record<string, Record<string, number>>>({});
  // Per-conversation notification preferences, keyed by channel/DM id. Absent = defaults (all, unmuted).
  const [channelPrefs, setChannelPrefs] = useState<Record<string, ChannelNotifPref>>({});
  const [channelNotifId, setChannelNotifId] = useState<string | null>(null);

  const [ws, setWs] = useState("");
  const [view, setView] = useState<AppView>("channel");
  // The view to restore when the full-screen preferences are closed (they are opened from menus, not the nav).
  const [prevView, setPrevView] = useState<AppView>("channel");
  // Which preferences section to land on when the full-screen preferences open.
  const [prefsTab, setPrefsTab] = useState<PrefTab>("appearance");
  // Dev/audit only: a click-only popover the deep-link asked to open on load (set post-mount, see below).
  const [deepLinkPop, setDeepLinkPop] = useState<string | undefined>(undefined);
  const [channelId, setChannelId] = useState("");
  // Desktop opens a conversation with its default panel: members for a channel, files for a DM (see
  // openChannel). The landing conversation is a channel, so it starts on members. `compact` is false on
  // the first render (SSR-safe, see useCompact), so this matches the server render; the compact shell
  // shows the list first and openChannel resets the panel per navigation anyway.
  const [panel, setPanel] = useState<ChannelPanel>(() =>
    channels.some((c) => c.id === channelId) ? "members" : "files",
  );
  // True once the user closes the right panel by hand, so opening another conversation stops
  // auto-opening its default panel. Reset when they open a panel again.
  const [panelDismissed, setPanelDismissed] = useState(false);
  const [thread, setThread] = useState<string | null>(null);
  const [profile, setProfile] = useState<string | null>(null);
  const [profileEdit, setProfileEdit] = useState(false);
  const [unreadMarker, setUnreadMarker] = useState<string | null>(null);
  const [focusMessageId, setFocusMessageId] = useState<string | null>(null);
  const [myPresence, setMyPresence] = useState<Presence>("online");
  const [modal, setModal] = useState<Modal>(null);
  const [channelSettingsId, setChannelSettingsId] = useState<string | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  // Toast: `toast` holds the content (kept through the exit so it stays rendered while animating out),
  // `toastVisible` drives the enter/exit, and useMountAnimation keeps it mounted for the exit window.
  const [toast, setToast] = useState<Toast | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  // Bumped on every toast so React remounts the element and replays the enter animation, even when a
  // toast is already on screen.
  const [toastKey, setToastKey] = useState(0);
  const { mounted: toastMounted, closing: toastClosing } = useMountAnimation(toastVisible, 280);

  // Compact (mobile/narrow) shell state. `mobileTab` picks the bottom-tab list; `mobileContent`
  // is true when a conversation or view is pushed full-screen over that list; `railOpen` toggles
  // the workspace rail drawer.
  const compact = useCompact();
  const [mobileTab, setMobileTab] = useState<"channels" | "messages" | "activity">("channels");
  const [mobileContent, setMobileContent] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  /**
   * Seed the shell state for one space: its channels, DMs, members, presence, files and the
   * per-conversation message feeds (eager-loaded so the cross-conversation views and the derived
   * notification badges keep working), plus the notification inbox.
   *
   * Used both at boot and when the workspace rail switches space, so a switch shows the space it
   * says it does rather than the previous one's conversations.
   */
  const loadSpace = useCallback(async (activeWs: string) => {
    setWs(activeWs);
    if (!activeWs) {
      setChannels([]);
      setDms([]);
      setMembers([]);
      setPresence({});
      setSpaceFiles([]);
      setMessages({});
      setNotifs([]);
      setChannelId("");
      return;
    }
    const [chans, dmList, memberList, presenceMap, feed, folder] = await Promise.all([
      getChannels(activeWs),
      getDirectMessages(activeWs),
      getSpaceMembers(activeWs).catch(() => [] as Member[]),
      getSpacePresence(activeWs).catch(() => ({}) as Record<string, Presence>),
      getNotifications().catch(() => ({ notifications: [], unreadCount: 0, nextBefore: undefined })),
      getFolder(activeWs).catch(() => ({ folderId: undefined, breadcrumb: [], entries: [] as SpaceFile[] })),
    ]);
    setChannels(chans);
    setMembers(memberList);
    setPresence(presenceMap);
    setSpaceFiles(folder.entries);
    // Overlay each 1:1 DM's counterpart presence onto its sidebar row.
    setDms(dmList.map((d) => (d.userId && presenceMap[d.userId] ? { ...d, presence: presenceMap[d.userId] } : d)));
    const convIds = [...chans.map((c) => c.id), ...dmList.map((d) => d.id)];
    const pages = await Promise.all(
      convIds.map((id) => getChannelMessages(id).catch(() => ({ messages: [], nextBefore: undefined }))),
    );
    const map: MessageMap = {};
    convIds.forEach((id, i) => {
      map[id] = pages[i].messages;
    });
    setMessages(map);
    const labelOf = (id: string): { label: string; isDm: boolean } => {
      const c = chans.find((x) => x.id === id);
      if (c) return { label: `#${c.name}`, isDm: false };
      const d = dmList.find((x) => x.id === id);
      if (d) return { label: d.name, isDm: true };
      return { label: id, isDm: false };
    };
    setNotifs(
      feed.notifications.map((n) => {
        const { label, isDm } = labelOf(n.conversationId);
        return {
          id: n.id,
          kind: n.kind as NotifKind,
          channelId: n.conversationId,
          label,
          isDm,
          actor: n.actor,
          messageId: n.messageId,
          preview: n.preview,
          time: n.time,
          read: n.read,
        };
      }),
    );
    // Land on the first channel of the space (or the first DM if the space has no visible channel).
    if (chans[0]) setChannelId(chans[0].id);
    else if (dmList[0]) setChannelId(dmList[0].id);
    else setChannelId("");
  }, []);

  /**
   * Load the signed-in user's spaces and enter the first one. Returns the spaces, so the caller can
   * tell an account with no space yet (which is sent to onboarding) from one that landed in a space.
   */
  const loadInitialData = useCallback(async () => {
    const spaces = await getWorkspaces();
    setWorkspaces(spaces);
    await loadSpace(spaces[0]?.id ?? "");
    return spaces;
  }, [loadSpace]);

  // Boot: check for an existing session, then load its data. A 401 sends us to the login screen; any
  // other failure is a fatal boot error (the API being unreachable).
  useEffect(() => {
    let active = true;
    // Dev/audit only: a deep-link renders a specific screen offline, without the API (the responsive
    // and accessibility audits rely on this). Skip the real boot so the shell renders with empty data
    // instead of the boot-error screen. `readDeepLink()` is null in the production static export.
    if (readDeepLink()) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBooting(false);
      return;
    }
    void (async () => {
      // An invitation held from an earlier load of this tab (see `rememberInvite`): registering from
      // an invitation means following the address-confirmation link, which reloads the bundle. Pick
      // it back up so the sign-in that follows still joins the space instead of dropping the invitee
      // into the "create your first space" onboarding.
      const held = readRememberedInvite();
      if (held) setInviteToken(held);

      // An emailed link (verification, password reset or invitation) takes precedence over the
      // session check: it addresses an account that is, by definition, not signed in here.
      const link = readAuthLink();
      // An invitation is the one link that can also apply to someone already signed in, so it
      // resolves the token first and only then falls back to asking who they are.
      if (link?.kind === "invite") {
        clearAuthLink();
        if (!active) return;
        setInviteToken(link.token);
        setAuthStage("invite");
        setInviteStatus("loading");
        const preview = link.token ? await previewInvitation(link.token).catch(() => null) : null;
        if (!active) return;
        if (!preview) {
          setInviteStatus("invalid");
          setBooting(false);
          return;
        }
        setInvitePreview(preview);
        rememberInvite(link.token);
        // Already signed in: join without asking for a password again.
        let user: SessionUser;
        try {
          user = await getSession();
        } catch {
          if (active) {
            setInviteStatus("ready");
            setBooting(false);
          }
          return;
        }
        if (!active) return;
        setInviteStatus("joining");
        try {
          await acceptInvitation(link.token);
        } catch {
          if (active) {
            // Most often an invitation addressed to a different address than the open session.
            setInviteStatus("ready");
            setAuthError("Cette invitation ne correspond pas au compte connecté. Connectez-vous avec le bon compte.");
            setBooting(false);
          }
          return;
        }
        if (!active) return;
        setInviteToken("");
        forgetInvite();
        setSession(user);
        const spaces = await loadInitialData();
        if (!active) return;
        setBooting(false);
        setAuthStage(spaces.length === 0 ? "onboarding" : "app");
        return;
      }
      if (link) {
        clearAuthLink();
        if (!active) return;
        setBooting(false);
        setLinkToken(link.token);
        if (link.kind === "reset-password") {
          setAuthStage("reset");
          if (!link.token) setAuthError("Ce lien de réinitialisation est incomplet. Demandez-en un nouveau.");
          return;
        }
        setAuthStage("verify");
        if (!link.token) {
          setVerifyStatus("error");
          return;
        }
        setVerifyStatus("verifying");
        try {
          await confirmEmailVerification(link.token);
          if (active) setVerifyStatus("done");
        } catch (err) {
          if (!active) return;
          setVerifyStatus("error");
          setAuthError(authMessage(err, "La confirmation a échoué. Réessayez plus tard."));
        }
        return;
      }
      try {
        const user = await getSession();
        if (!active) return;
        setSession(user);
        await loadInitialData();
        if (!active) return;
        setAuthStage("app");
      } catch (err) {
        if (!active) return;
        if (isApiError(err, 401)) setAuthStage("login");
        else setBootError("Le serveur est injoignable. Réessayez plus tard.");
      } finally {
        if (active) setBooting(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [loadInitialData]);

  // Load the space's outstanding invitations whenever the invite dialog opens. Fetching on open
  // rather than on space load keeps an administration-only call off the boot path, and means the
  // list is never a stale snapshot from an earlier visit.
  useEffect(() => {
    if (modal !== "invite" || !ws) return;
    let active = true;
    void getInvitations(ws)
      .then((rows) => {
        if (active) setInvitations(rows);
      })
      .catch(() => {
        // A member who is not an administrator gets a 403 here: an empty list is the honest view.
        if (active) setInvitations([]);
      });
    return () => {
      active = false;
    };
  }, [modal, ws]);

  // Publish the signed-in user's name into the data seam, so components that read it synchronously
  // (message ownership, thread reply author, "my profile") reflect the real session, not the mock.
  useEffect(() => {
    if (session) setCurrentUser(session.name);
  }, [session]);

  // The realtime handlers read the latest lists/ids through a ref so the socket does not reconnect on
  // every state change. Updated after each render (not during, to respect the ref rules).
  const rtRef = useRef<RealtimeConnection | null>(null);
  const liveRef = useRef({ channels, dms, channelId, view, myId: session?.id, ws });
  /**
   * Latest toast function, for the realtime handlers. They are wired once per session, so they
   * cannot close over `showToast` directly: it is a new function on every render, and adding it to
   * the effect's dependencies would tear the WebSocket down and rebuild it on each one.
   */
  const notifyRef = useRef<((toast: Toast) => void) | null>(null);
  useEffect(() => {
    liveRef.current = { channels, dms, channelId, view, myId: session?.id, ws };
  });

  // Live realtime channel: connect once per session and dispatch server pushes into state. Mutations
  // still go through REST; this only receives (and sends typing/ping).
  useEffect(() => {
    if (!session) return;
    const conn = connectRealtime({
      onMessageCreated: (conv, m) => {
        const { channelId: active, myId } = liveRef.current;
        // Our own message is already shown optimistically and reconciled by the POST response; skip
        // the echo so it does not briefly duplicate at the bottom of the feed.
        if (m.authorId && m.authorId === myId) return;
        setMessages((prev) => upsertMessage(prev, conv, m));
        // The author stopped typing the moment they sent: clear their now-stale typing signal.
        const author = m.authorId;
        if (author) {
          setTyping((prev) => {
            const users = prev[conv];
            if (!users || !(author in users)) return prev;
            const next = { ...users };
            delete next[author];
            return { ...prev, [conv]: next };
          });
        }
        // Someone else posted in a conversation we are not looking at: bump its unread badge.
        if (conv !== active) {
          setChannels((prev) => prev.map((c) => (c.id === conv ? { ...c, unread: c.unread + 1 } : c)));
          setDms((prev) => prev.map((d) => (d.id === conv ? { ...d, unread: d.unread + 1 } : d)));
        }
      },
      onMessageUpdated: (conv, m) => setMessages((prev) => replaceMessage(prev, conv, m)),
      onMessageDeleted: (conv, m) => setMessages((prev) => replaceMessage(prev, conv, m)),
      onReaction: (conv, r) => {
        // Our own reaction is already applied optimistically; only fold in other users' deltas.
        if (r.userId === liveRef.current.myId) return;
        setMessages((prev) => applyReactionDelta(prev, conv, r));
      },
      onPinned: (conv, messageId, pinned) => {
        setMessages((prev) => {
          const list = prev[conv];
          if (!list || !list.some((m) => m.id === messageId)) return prev;
          return { ...prev, [conv]: list.map((m) => (m.id === messageId ? { ...m, pinned } : m)) };
        });
      },
      onChannelCreated: (channel) => {
        // Only the space on screen: an event for another one is folded in when it is next loaded.
        if (channel.spaceId !== liveRef.current.ws) return;
        setChannels((prev) =>
          prev.some((c) => c.id === channel.id)
            ? prev
            : [
                ...prev,
                {
                  id: channel.id,
                  name: channel.name,
                  type: channel.type,
                  topic: channel.topic,
                  fav: false,
                  unread: 0,
                  // The creator's own row already came from the POST; for everyone else the channel
                  // exists but they have not joined it.
                  member: false,
                },
              ],
        );
      },
      onChannelUpdated: (channel) => {
        const { ws: activeWs, channels: current, channelId: openId } = liveRef.current;
        if (channel.spaceId !== activeWs) return;
        const row = current.find((c) => c.id === channel.id);
        if (!row) return;
        // A channel turned private leaves the sidebar of everyone who is not in it: this event is
        // the only way they learn they lost access to it.
        if (channel.type === "private" && row.member !== true) {
          setChannels((prev) => prev.filter((c) => c.id !== channel.id));
          if (openId === channel.id) {
            // Move off the conversation that just closed. `setChannelId` rather than `openChannel`:
            // the handlers are wired before it is declared, and there is no panel to reset here.
            const fallback = current.find((c) => c.id !== channel.id);
            if (fallback) setChannelId(fallback.id);
          }
          return;
        }
        setChannels((prev) =>
          prev.map((c) =>
            c.id === channel.id ? { ...c, name: channel.name, type: channel.type, topic: channel.topic } : c,
          ),
        );
      },
      onMemberJoined: (member) => {
        // Only the space on screen: an arrival elsewhere is folded in when that space is next
        // loaded. Keeping the roster sorted matches the order the API returns it in, so the list
        // does not reshuffle on the next load.
        if (member.spaceId !== liveRef.current.ws) return;
        setMembers((prev) =>
          prev.some((m) => m.userId === member.userId)
            ? prev
            : [...prev, member].sort((a, b) => a.name.localeCompare(b.name, "fr")),
        );
        // The newcomer is in the audience too; they do not need to be told they arrived.
        if (member.userId !== liveRef.current.myId) {
          notifyRef.current?.({ tone: "info", title: `${member.name} a rejoint l'espace` });
        }
      },
      onPresence: (userId, p) => {
        setPresence((prev) => ({ ...prev, [userId]: p }));
        setDms((prev) => prev.map((d) => (d.userId === userId ? { ...d, presence: p } : d)));
      },
      onNotification: (n) => {
        const { channels: chs, dms: dmList, channelId: activeConv, view: activeView } = liveRef.current;
        const channel = chs.find((x) => x.id === n.conversationId);
        const dm = dmList.find((x) => x.id === n.conversationId);
        const label = channel ? `#${channel.name}` : dm ? dm.name : n.conversationId;
        // If the recipient is already looking at that conversation, the notification is redundant:
        // file it as already read (both locally and on the server) and do not bump the unread badge.
        const viewing = n.conversationId === activeConv && activeView === "channel";
        const notif: AppNotification = {
          id: n.id,
          kind: n.kind as NotifKind,
          channelId: n.conversationId,
          label,
          isDm: !channel && !!dm,
          actor: n.actor,
          messageId: n.messageId,
          preview: n.preview,
          time: n.time,
          read: n.read || viewing,
        };
        setNotifs((prev) => [notif, ...prev.filter((x) => x.id !== n.id)]);
        if (viewing) {
          void markNotificationRead(n.id).catch(() => {});
          return;
        }
        // Ensure the source conversation shows as unread. `Math.max` so this never double-counts with
        // the message.created bump when both fire (a mention the viewer also received as a message).
        setChannels((prev) => prev.map((c) => (c.id === n.conversationId ? { ...c, unread: Math.max(c.unread, 1) } : c)));
        setDms((prev) => prev.map((d) => (d.id === n.conversationId ? { ...d, unread: Math.max(d.unread, 1) } : d)));
      },
      onTyping: (conv, userId) =>
        setTyping((prev) => ({ ...prev, [conv]: { ...prev[conv], [userId]: Date.now() } })),
    });
    rtRef.current = conn;
    return () => {
      conn.close();
      rtRef.current = null;
    };
  }, [session]);

  // Expire typing signals a few seconds after the last keystroke, so the indicator does not stick.
  useEffect(() => {
    const timer = setInterval(() => {
      const cutoff = Date.now() - 5000;
      setTyping((prev) => {
        let changed = false;
        const next: Record<string, Record<string, number>> = {};
        for (const [conv, users] of Object.entries(prev)) {
          const fresh: Record<string, number> = {};
          for (const [uid, ts] of Object.entries(users)) {
            if (ts >= cutoff) fresh[uid] = ts;
            else changed = true;
          }
          if (Object.keys(fresh).length > 0) next[conv] = fresh;
        }
        return changed ? next : prev;
      });
    }, 3000);
    return () => clearInterval(timer);
  }, []);

  // Dev-only: land directly on a UI state from query params (see lib/dev/deeplink.ts).
  // A no-op in the production static export; used by tools/responsive-audit to reach every screen.
  useEffect(() => {
    const link = readDeepLink();
    if (!link) return;
    // One-shot dev entry point: apply the URL deep-link to the app's state on mount. Reading it in the
    // state initializers instead would diverge from the server render (readDeepLink is client-only), so
    // the synchronous setStates here are intentional.
    /* eslint-disable react-hooks/set-state-in-effect */
    if (link.stage) setAuthStage(link.stage);
    // The invitation screen has nothing to show without a resolved token, and the audits run
    // offline: seed the card it renders for a real invitation so the state is auditable.
    if (link.stage === "invite") {
      setInviteStatus("ready");
      setInvitePreview({ spaceName: "Atelier Néon", invitedBy: "Alice Moreau", role: "member" });
    }
    if (link.view) setView(link.view);
    if (link.prefsTab) setPrefsTab(link.prefsTab);
    if (link.channel) setChannelId(link.channel);
    if (link.panel) setPanel(link.panel);
    if (link.modal) setModal(link.modal);
    if (link.push) setMobileContent(true); // compact: land on the pushed content, not the list
    // Appearance is a persisted setting, not component state, so the audit forces it through the store.
    // Write it to localStorage here (this child effect runs before the SettingsProvider's own load
    // effect, so the provider picks the forced value up instead of clobbering it) and reset to the
    // defaults when absent, so a value set by one audit state does not leak into the next (the runner
    // reuses one page, so localStorage persists across navigations).
    try {
      const raw = localStorage.getItem("ruchoir.settings");
      const stored = raw ? JSON.parse(raw) : {};
      localStorage.setItem(
        "ruchoir.settings",
        JSON.stringify({
          ...stored,
          textSize: link.text ?? "m",
          font: link.font ?? "plex",
          // Hidden by default under a deep-link so it does not clutter every audited screen; welcome=1 shows it.
          welcome: { dismissed: !link.welcome, done: [] },
        }),
      );
    } catch {
      // ignore storage failures (dev-only affordance)
    }
    // Dev-only: open a click-only popover on load (audit coverage). Set in the effect, NOT during
    // render, so the server and first client render match (reading it at render time would open the
    // popover only on the client -> hydration mismatch).
    if (link.pop) setDeepLinkPop(link.pop);
    /* eslint-enable react-hooks/set-state-in-effect */
    // Run once on mount; deep-link is an entry point, not a live binding.
  }, []);

  const dm = dms.find((d) => d.id === channelId) ?? null;
  const chan: Channel =
    channels.find((c) => c.id === channelId) ??
    ({ id: channelId, name: dm?.name ?? "général", fav: false, unread: 0, type: "public" } as Channel);
  const feed = messages[channelId] ?? [];

  // The space's members with live presence overlaid, feeding the member list, the @-mention
  // autocomplete and the people section of search. Falls back to the mock roster before load.
  const memberRecords = useMemo(
    () => members.map((m) => ({ name: m.name, presence: (presence[m.userId] ?? "offline") as Presence, bot: m.bot })),
    [members, presence],
  );
  // Publish the real roster and per-name presence into the data seam, which the composer, message
  // renderer and dialogs read synchronously (getChannelMembers / getMentionNames / getPresence).
  useEffect(() => {
    if (members.length === 0) return;
    setChannelMembers(memberRecords);
    for (const m of members) {
      if (presence[m.userId]) setUserPresence(m.name, presence[m.userId]);
    }
  }, [memberRecords, members, presence]);
  const people = members.length > 0 ? memberRecords : getChannelMembers();

  // Reverse lookup (user id -> display name) for realtime signals that arrive as bare ids (typing,
  // presence), built from the DM counterparts and the authors seen in the loaded feeds.
  const userNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const m of members) names[m.userId] = m.name;
    for (const d of dms) if (d.userId) names[d.userId] = d.name;
    for (const list of Object.values(messages)) {
      for (const msg of list) if (msg.authorId) names[msg.authorId] = msg.author;
    }
    return names;
  }, [members, dms, messages]);

  // Names currently typing in the open conversation, excluding the current user. Freshness is kept by
  // the pruning interval below (which drops stale signals), so this stays a pure derivation.
  const typingNames = useMemo(() => {
    const users = typing[channelId] ?? {};
    return Object.keys(users)
      .map((uid) => userNames[uid] ?? "Quelqu'un")
      .filter((name) => name !== currentUser);
  }, [typing, channelId, userNames, currentUser]);

  // The opened profile's user id, when resolvable (DM counterpart, or an author seen in a feed), so
  // the profile panel can fetch the real profile from the API instead of the mock.
  const profileUserId = useMemo(() => {
    if (!profile) return undefined;
    const dm = dms.find((d) => d.name === profile);
    if (dm?.userId) return dm.userId;
    return Object.entries(userNames).find(([, name]) => name === profile)?.[0];
  }, [profile, dms, userNames]);
  const saved = collectSaved(messages, channels, dms);
  const mentions = collectMentions(messages, channels, dms, currentUser);
  const threads = collectThreads(messages, channels, dms);

  // Notifications the user should actually see, after applying the per-channel and global preferences.
  const visibleNotifs = useMemo(
    () => notifs.filter((n) => passesPref(n, channelPrefs[n.channelId], settings.notif)),
    [notifs, channelPrefs, settings.notif],
  );
  const notifUnread = visibleNotifs.filter((n) => !n.read).length;

  const setNotifRead = (id: string, read: boolean) => {
    setNotifs((prev) => prev.map((n) => (n.id === id ? { ...n, read } : n)));
    // The API only marks a notification read (there is no "unread" inverse), so sync only that way.
    if (read) void markNotificationRead(id).catch(() => {});
  };
  const markAllNotifsRead = () => {
    setNotifs((prev) => prev.map((n) => ({ ...n, read: true })));
    void markAllNotificationsRead().catch(() => {});
  };
  const saveChannelPref = (id: string, pref: ChannelNotifPref) =>
    setChannelPrefs((prev) => ({ ...prev, [id]: pref }));

  /** Mark a whole conversation read: clears its unread badge and any pending notifications from it. */
  const markConversationRead = (id: string) => {
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, unread: 0 } : c)));
    setDms((prev) => prev.map((d) => (d.id === id ? { ...d, unread: 0 } : d)));
    // Clear this conversation's notifications from the inbox too, locally and on the server, so
    // reading the channel directly (not via the notification center) empties its unread there.
    const toMark = notifs.filter((n) => n.channelId === id && !n.read);
    setNotifs((prev) => prev.map((n) => (n.channelId === id ? { ...n, read: true } : n)));
    for (const n of toMark) void markNotificationRead(n.id).catch(() => {});
    // Advance the server-side read cursor to the latest acknowledged message. Best-effort: a failure
    // only means the badge reappears on reload, so it is not surfaced.
    const list = messages[id] ?? [];
    const last = [...list].reverse().find((m) => !isPendingId(m.id));
    if (last) void setReadCursor(id, last.id).catch(() => {});
  };

  /** Jump to the next (dir 1) or previous (dir -1) unread conversation, channels then DMs, cyclically. */
  const gotoUnread = (dir: 1 | -1) => {
    const ids = [...channels, ...dms].filter((c) => c.unread > 0).map((c) => c.id);
    if (ids.length === 0) {
      showToast({ tone: "info", title: "Aucune conversation non lue" });
      return;
    }
    const cur = ids.indexOf(channelId);
    const next = cur === -1 ? (dir === 1 ? 0 : ids.length - 1) : (cur + dir + ids.length) % ids.length;
    openChannel(ids[next]);
  };

  const showToast = (t: Toast) => {
    setToast(t);
    setToastVisible(true);
    setToastKey((k) => k + 1);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastVisible(false), 4000);
  };

  // Keep `notifyRef` (declared with the other realtime refs, and read by handlers wired once per
  // session) pointing at the current `showToast`. It is filled here rather than in the ref-refresh
  // effect above because that effect runs before this declaration, and a forward reference would
  // freeze the first one instead of tracking it.
  useEffect(() => {
    notifyRef.current = showToast;
  });

  /** Move to an authentication screen with a clean slate (no stale error, notice or pending flag). */
  const goToStage = (stage: AuthStage) => {
    setAuthError(null);
    setAuthSent(false);
    setAuthPending(false);
    setAuthStage(stage);
  };

  /**
   * Leave the authentication flow: keep the session, load the spaces and enter the app. An account
   * that belongs to no space yet (a fresh registration) goes to onboarding instead, which creates
   * its first one: entering an empty shell would be a dead end.
   */
  const enterApp = async (user: SessionUser) => {
    setSession(user);
    setMfaChallenge(null);
    setBooting(true);
    // An invitation the visitor arrived with is accepted before the spaces are loaded, so they land
    // inside the space that invited them rather than in the empty-shell onboarding.
    if (inviteToken) {
      try {
        await acceptInvitation(inviteToken);
      } catch {
        showToast({
          tone: "danger",
          title: "Invitation refusée",
          description: "Ce lien ne correspond pas à ce compte.",
        });
      }
      setInviteToken("");
      forgetInvite();
    }
    const spaces = await loadInitialData();
    setBooting(false);
    if (spaces.length === 0) {
      setSignupFirst(user.name.split(" ")[0] ?? "");
      goToStage("onboarding");
      return;
    }
    setAuthStage("app");
    showToast({ tone: "success", title: "Connecté", description: `Bienvenue, ${user.name.split(" ")[0]}.` });
  };

  /**
   * Create the account's first space from onboarding, then enter it. The space is born with a
   * starting channel, so the app opens on a real conversation.
   */
  const handleCreateFirstSpace = async (name: string) => {
    setAuthError(null);
    setAuthPending(true);
    try {
      const space = await createSpace(name);
      setWorkspaces((prev) => [...prev, space]);
      setBooting(true);
      await loadSpace(space.id);
      setBooting(false);
      setAuthStage("app");
      showToast({ tone: "success", title: "Espace créé", description: space.name });
    } catch (err) {
      setBooting(false);
      setAuthError(
        isApiError(err, 400)
          ? "Ce nom d'espace n'est pas utilisable. Essayez-en un autre."
          : "Création impossible. Réessayez.",
      );
    } finally {
      setAuthPending(false);
    }
  };

  /**
   * Sign in against the API. An account with a second factor answers with a challenge instead of a
   * session: hold it and hand over to the step-up screen. An unconfirmed address is refused with its
   * own code, so the login can offer to send the verification link again.
   */
  const handleLogin = async (email: string, password: string) => {
    setAuthError(null);
    setAuthPending(true);
    try {
      const result = await apiLogin(email, password);
      if (result.kind === "mfa") {
        setMfaChallenge({ methods: result.methods, mfaToken: result.mfaToken });
        goToStage("mfa");
        return;
      }
      await enterApp(result.user);
    } catch (err) {
      if (apiErrorCode(err) === "email_not_verified") setPendingEmail(email);
      setAuthError(authMessage(err, "Connexion impossible. Réessayez."));
    } finally {
      setAuthPending(false);
    }
  };

  /**
   * Create an account. Registration opens no session: the API emails a confirmation link and refuses
   * sign-in until the address is confirmed, so this lands on the "check your inbox" screen.
   */
  const handleSignup = async ({ email, displayName, password }: SignupValues) => {
    setAuthError(null);
    setAuthPending(true);
    try {
      await apiRegister(email, displayName, password);
      setPendingEmail(email);
      setVerifyStatus("sent");
      goToStage("verify");
    } catch (err) {
      setAuthError(authMessage(err, "Création impossible. Réessayez."));
    } finally {
      setAuthPending(false);
    }
  };

  /** Ask for a fresh confirmation link. The API answers the same way for an unknown address. */
  const handleResendVerification = async (email: string) => {
    setAuthPending(true);
    try {
      await requestEmailVerification(email);
      setPendingEmail(email);
      setAuthSent(true);
      setAuthError(null);
    } catch {
      setAuthError("Envoi impossible. Réessayez plus tard.");
    } finally {
      setAuthPending(false);
    }
  };

  /** Request a password-reset link. The confirmation stays neutral: the API reveals nothing. */
  const handlePasswordResetRequest = async (email: string) => {
    setAuthPending(true);
    try {
      await requestPasswordReset(email);
      setAuthSent(true);
      setAuthError(null);
    } catch {
      setAuthError("Envoi impossible. Réessayez plus tard.");
    } finally {
      setAuthPending(false);
    }
  };

  /** Set the new password behind the emailed token. The server drops every session of that account. */
  const handlePasswordReset = async (password: string) => {
    if (!linkToken) {
      setAuthError("Ce lien de réinitialisation est incomplet. Demandez-en un nouveau.");
      return;
    }
    setAuthError(null);
    setAuthPending(true);
    try {
      await confirmPasswordReset(linkToken, password);
      setLinkToken("");
      setResetDone(true);
    } catch (err) {
      setAuthError(authMessage(err, "Réinitialisation impossible. Réessayez."));
    } finally {
      setAuthPending(false);
    }
  };

  /** Complete the pending second factor with a typed code (authenticator or recovery). */
  const handleMfaCode = async (method: "totp" | "recovery", code: string) => {
    if (!mfaChallenge) return;
    setAuthError(null);
    setAuthPending(true);
    try {
      const verify = method === "totp" ? verifyTotp : verifyRecoveryCode;
      await enterApp(await verify(mfaChallenge.mfaToken, code));
    } catch (err) {
      // An expired or already-spent challenge cannot be retried: start the sign-in over.
      if (apiErrorCode(err) === "invalid_token") {
        setMfaChallenge(null);
        goToStage("login");
        setAuthError("Cette demande de connexion a expiré. Recommencez.");
        return;
      }
      setAuthError(authMessage(err, "Vérification impossible. Réessayez."));
    } finally {
      setAuthPending(false);
    }
  };

  /** Complete the pending second factor with a passkey (WebAuthn ceremony, then the assertion). */
  const handleMfaPasskey = async () => {
    if (!mfaChallenge) return;
    setAuthError(null);
    setAuthPending(true);
    try {
      await enterApp(await verifyPasskey(mfaChallenge.mfaToken));
    } catch (err) {
      // The user dismissing the browser prompt is a cancellation, not a failure.
      const cancelled = err instanceof DOMException && err.name === "NotAllowedError";
      setAuthError(
        cancelled
          ? "Authentification par clé d'accès annulée."
          : authMessage(err, "Cette clé d'accès n'a pas pu être utilisée. Essayez une autre méthode."),
      );
    } finally {
      setAuthPending(false);
    }
  };

  /** End the session server-side, then drop the loaded state and return to the login screen. */
  const handleLogout = async () => {
    try {
      await apiLogout();
    } catch {
      // Even if the request fails (already-expired session, offline), clear the client state.
    }
    setSession(null);
    setWorkspaces([]);
    setChannels([]);
    setDms([]);
    setMessages({});
    setNotifs([]);
    setMfaChallenge(null);
    setInviteToken("");
    forgetInvite();
    goToStage("login");
  };

  // First-run getting-started checklist, persisted in settings.welcome.
  const markWelcomeDone = (id: string) =>
    settings.set("welcome", { ...settings.welcome, done: Array.from(new Set([...settings.welcome.done, id])) });
  const dismissWelcome = () => settings.set("welcome", { ...settings.welcome, dismissed: true });
  const restartWelcome = () => settings.set("welcome", { dismissed: false, done: settings.welcome.done });
  /** Launch the action for a checklist step and tick it off. */
  const runWelcomeStep = (id: string) => {
    markWelcomeDone(id);
    if (id === "profile") {
      setModal(null);
      setView("channel");
      setThread(null);
      setProfileEdit(true);
      setProfile(currentUser);
    } else if (id === "channel") {
      setModal("newChannel");
    } else if (id === "message") {
      openChannel(channels[0]?.id ?? channelId);
    } else if (id === "invite") {
      setModal("invite");
    } else if (id === "import") {
      setModal("import");
    }
  };

  /** Open the full-screen preferences on a given section, remembering the current view so closing returns to it. */
  const openPreferences = (tab: PrefTab = "appearance") => {
    setModal(null);
    setPrefsTab(tab);
    if (view !== "prefs") setPrevView(view);
    // Preferences are a full-screen overlay: leave the underlying view, panel and thread untouched so
    // closing them returns to exactly where the user was (with the right panel still open).
    setView("prefs");
    // Compact shell: push the view full-screen over the tab list and close the rail drawer.
    setMobileContent(true);
    setRailOpen(false);
  };

  const openChannel = (id: string) => {
    setView("channel");
    setChannelId(id);
    // Right panel is app-level state, so reset it per conversation. On desktop a channel opens with its
    // members panel and a DM with its files panel by default; the compact shell opens with no panel
    // (there the panel is a full-screen overlay that would hide the conversation). Once the user has
    // closed the panel by hand, respect that and keep it closed.
    const isChannel = channels.some((c) => c.id === id);
    setPanel(compact || panelDismissed ? null : isChannel ? "members" : "files");
    setThread(null);
    setProfile(null);
    setProfileEdit(false);
    setUnreadMarker(null);
    setFocusMessageId(null);
    // Opening a conversation marks it read: clears its unread badge, its notifications and advances
    // the read cursor.
    markConversationRead(id);
  };

  /** Switch the right panel, closing the thread and profile views so it is visible. */
  const openPanel = (next: ChannelPanel) => {
    setPanel(next);
    // Closing the panel (next === null) is a manual dismissal; opening one re-engages the auto-default.
    setPanelDismissed(next === null);
    setThread(null);
    setProfile(null);
  };

  const updateMessage = (targetChannel: string, messageId: string, updater: (m: Message) => Message) => {
    setMessages((prev) => {
      const list = prev[targetChannel] ?? [];
      return { ...prev, [targetChannel]: list.map((m) => (m.id === messageId ? updater(m) : m)) };
    });
  };

  /** Restore a message to a captured snapshot, to undo an optimistic change that the API rejected. */
  const rollbackMessage = (targetChannel: string, snapshot: Message) =>
    updateMessage(targetChannel, snapshot.id, () => snapshot);

  /** Open (or create, via the API) a direct message with a person, then navigate to it. */
  const openDmByName = (name: string) => {
    setModal(null);
    const existing = dms.find((d) => d.name === name);
    if (existing) {
      openChannel(existing.id);
      return;
    }
    const target = members.find((m) => m.name === name);
    if (!target) {
      showToast({ tone: "info", title: "Impossible d'ouvrir la conversation", description: name });
      return;
    }
    createDm(ws, [target.userId])
      .then((id) => {
        setDms((prev) =>
          prev.some((d) => d.id === id)
            ? prev
            : [
                ...prev,
                {
                  id,
                  name,
                  presence: presence[target.userId] ?? "offline",
                  unread: 0,
                  userId: target.userId,
                  bot: target.bot || undefined,
                },
              ],
        );
        setMessages((prev) => (prev[id] ? prev : { ...prev, [id]: [] }));
        openChannel(id);
      })
      .catch(() => showToast({ tone: "danger", title: "Ouverture du message direct impossible" }));
  };

  const openMessage = (targetChannel: string, messageId: string) => {
    setModal(null);
    openChannel(targetChannel);
    setFocusMessageId(messageId);
  };

  /** Open a notification: mark it read, then jump to its source message. */
  const openNotification = (targetChannel: string, messageId: string, id: string) => {
    setNotifRead(id, true);
    openMessage(targetChannel, messageId);
  };

  const messageActions = {
    react: (messageId: string, emoji: string) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target || isPendingId(messageId)) return;
      const wasMine = !!target.reactions?.find((r) => r.emoji === emoji)?.mine;
      updateMessage(conv, messageId, (m) => {
        const reactions = m.reactions ? m.reactions.map((r) => ({ ...r })) : [];
        const idx = reactions.findIndex((r) => r.emoji === emoji);
        if (idx === -1) {
          reactions.push({ emoji, count: 1, mine: true });
        } else if (reactions[idx].mine) {
          const count = reactions[idx].count - 1;
          if (count <= 0) reactions.splice(idx, 1);
          else reactions[idx] = { ...reactions[idx], count, mine: false };
        } else {
          reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, mine: true };
        }
        return { ...m, reactions };
      });
      const request = wasMine ? removeReaction(messageId, emoji) : addReaction(messageId, emoji);
      request.catch(() => {
        rollbackMessage(conv, target);
        showToast({ tone: "info", title: "Réaction non enregistrée" });
      });
    },
    openThread: (messageId: string) => {
      setThread(messageId);
      setProfile(null);
    },
    openProfile: (name: string) => {
      setProfile(name);
      setProfileEdit(false);
      setThread(null);
    },
    editProfile: (name: string) => {
      setProfile(name);
      setProfileEdit(true);
      setThread(null);
    },
    message: (name: string) => openDmByName(name),
    toggleSave: (messageId: string) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target || isPendingId(messageId)) return;
      const nowSaved = !(target.saved ?? false);
      updateMessage(conv, messageId, (m) => ({ ...m, saved: nowSaved }));
      showToast({
        tone: nowSaved ? "success" : "info",
        title: nowSaved ? "Message enregistré" : "Retiré des enregistrés",
      });
      setMessageSaved(messageId, nowSaved).catch(() => {
        rollbackMessage(conv, target);
        showToast({ tone: "info", title: "Enregistrement non synchronisé" });
      });
    },
    edit: (messageId: string) => {
      const target = feed.find((x) => x.id === messageId);
      if (target) setEditing({ id: messageId, body: target.body });
    },
    togglePin: (messageId: string) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target || isPendingId(messageId)) return;
      const nowPinned = !(target.pinned ?? false);
      updateMessage(conv, messageId, (m) => ({ ...m, pinned: nowPinned }));
      showToast({ tone: "info", title: nowPinned ? "Message épinglé" : "Message désépinglé" });
      // Pins are a channel concept (the endpoint is channel-scoped); DMs keep the toggle client-side.
      if (channels.some((c) => c.id === conv)) {
        setMessagePinned(conv, messageId, nowPinned).catch(() => {
          rollbackMessage(conv, target);
          showToast({ tone: "info", title: "Épinglage non synchronisé" });
        });
      }
    },
    copyLink: () => showToast({ tone: "success", title: "Lien copié" }),
    copyMessage: (messageId: string) => {
      const target = feed.find((x) => x.id === messageId);
      navigator.clipboard?.writeText(target?.body ?? "");
      showToast({ tone: "success", title: "Message copié" });
    },
    markUnread: (messageId: string) => {
      setUnreadMarker(messageId);
      showToast({ tone: "info", title: "Marqué comme non lu" });
    },
    remove: (messageId: string) => {
      const conv = channelId;
      const target = (messages[conv] ?? []).find((x) => x.id === messageId);
      if (!target) return;
      if (isPendingId(messageId)) {
        // An optimistic message the API never saw: just drop it locally.
        setMessages((prev) => ({ ...prev, [conv]: (prev[conv] ?? []).filter((x) => x.id !== messageId) }));
        return;
      }
      updateMessage(conv, messageId, (m) => ({ ...m, deleted: true, body: "" }));
      showToast({ tone: "info", title: "Message supprimé" });
      deleteMessage(messageId)
        .then((m) => updateMessage(conv, messageId, () => m))
        .catch(() => {
          rollbackMessage(conv, target);
          showToast({ tone: "info", title: "Suppression impossible" });
        });
    },
  };

  const send = (text: string, attachment?: Message["attachment"]) => {
    if (!text.trim() && !attachment) return;
    const conv = channelId;
    const tempId = `tmp-${Date.now()}`;
    const optimistic: Message = {
      id: tempId,
      author: currentUser,
      time: new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" }),
      body: text,
      attachment,
    };
    setMessages((prev) => ({ ...prev, [conv]: [...(prev[conv] ?? []), optimistic] }));
    // An attachment needs an uploaded file id (the files surface is not wired yet), so a message that
    // carries one stays client-side. A plain text message is persisted and its optimistic row is
    // replaced by the server row (real id, timestamp) on success, or removed on failure.
    if (!text.trim() || attachment) return;
    sendMessage(conv, text)
      .then((m) =>
        // Drop the optimistic row and de-dupe the real id, so a realtime echo of our own message that
        // may have already arrived does not leave a duplicate.
        setMessages((prev) => {
          const list = (prev[conv] ?? []).filter((x) => x.id !== tempId && x.id !== m.id);
          return { ...prev, [conv]: [...list, m] };
        }),
      )
      .catch(() => {
        setMessages((prev) => ({ ...prev, [conv]: (prev[conv] ?? []).filter((x) => x.id !== tempId) }));
        showToast({ tone: "info", title: "Message non envoyé" });
      });
  };

  const saveEdit = () => {
    if (!editing) return;
    const conv = channelId;
    const { id, body } = editing;
    const target = (messages[conv] ?? []).find((x) => x.id === id);
    updateMessage(conv, id, (m) => ({ ...m, body, edited: true }));
    setEditing(null);
    showToast({ tone: "success", title: "Message modifié" });
    if (isPendingId(id)) return;
    editMessage(id, body)
      .then((m) => updateMessage(conv, id, () => m))
      .catch(() => {
        if (target) rollbackMessage(conv, target);
        showToast({ tone: "info", title: "Modification non enregistrée" });
      });
  };

  // Domain mutations wired to the creation dialogs.
  /**
   * Create a channel in the current space. The server normalises the name into a handle, so the row
   * added to the sidebar is the one it will keep, which may differ from what was typed.
   */
  const createChannel = async ({ name, type, topic }: { name: string; type: Channel["type"]; topic: string }) => {
    try {
      const channel = await apiCreateChannel(ws, { name, type, topic });
      setChannels((prev) => [...prev, channel]);
      setMessages((prev) => ({ ...prev, [channel.id]: [] }));
      setModal(null);
      openChannel(channel.id);
      showToast({ tone: "success", title: "Canal créé", description: `#${channel.name}` });
    } catch (err) {
      showToast({
        tone: "danger",
        title: "Canal non créé",
        description: isApiError(err, 400)
          ? "Ce nom est déjà pris dans cet espace, ou il n'est pas utilisable."
          : "Réessayez dans un instant.",
      });
    }
  };

  /** Save a channel's settings (name, topic, visibility, archived) against the API. */
  const updateChannel = async (id: string, patch: Partial<Channel>) => {
    const before = channels.find((c) => c.id === id);
    // Optimistic: the settings dialog closes on save, so the sidebar must not lag behind it.
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...patch } : c)));
    try {
      const saved = await apiUpdateChannel(id, { name: patch.name, type: patch.type, topic: patch.topic });
      setChannels((prev) => prev.map((c) => (c.id === id ? saved : c)));
    } catch (err) {
      if (before) setChannels((prev) => prev.map((c) => (c.id === id ? before : c)));
      showToast({
        tone: "danger",
        title: "Modification non enregistrée",
        description: isApiError(err, 403)
          ? "Vous n'avez pas les droits sur ce canal."
          : isApiError(err, 400)
            ? "Ce nom est déjà pris dans cet espace, ou il n'est pas utilisable."
            : "Réessayez dans un instant.",
      });
    }
  };

  /**
   * Leave a channel. Only the caller's membership goes: a public channel stays readable and stays in
   * the sidebar (with a "join" entry to come back), while a private one disappears with its access.
   */
  const leaveChannel = async (id: string) => {
    const channel = channels.find((c) => c.id === id);
    const isPrivate = channel?.type === "private";
    try {
      await apiLeaveChannel(id);
    } catch {
      showToast({ tone: "danger", title: "Impossible de quitter ce canal", description: "Réessayez dans un instant." });
      return;
    }
    if (isPrivate) {
      setChannels((prev) => prev.filter((c) => c.id !== id));
      const fallback = channels.find((c) => c.id !== id);
      if (fallback) openChannel(fallback.id);
    } else {
      setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, member: false, unread: 0 } : c)));
    }
    showToast({
      tone: "info",
      title: "Canal quitté",
      description: isPrivate ? undefined : "Vous pouvez toujours le lire, sans notifications.",
    });
  };

  /** Rejoin a public channel left earlier, so its messages notify again. */
  const joinChannel = async (id: string) => {
    try {
      await apiJoinChannel(id);
      setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, member: true } : c)));
      showToast({ tone: "success", title: "Canal rejoint" });
    } catch {
      showToast({ tone: "danger", title: "Impossible de rejoindre ce canal", description: "Réessayez dans un instant." });
    }
  };

  /** Create a space and switch to it. It is born with a starting channel, so it opens on one. */
  const createWorkspace = async (name: string) => {
    try {
      const space = await createSpace(name);
      setWorkspaces((prev) => [...prev, space]);
      setModal(null);
      setBooting(true);
      await loadSpace(space.id);
      setBooting(false);
      showToast({ tone: "success", title: "Espace créé", description: space.name });
    } catch (err) {
      setBooting(false);
      showToast({
        tone: "danger",
        title: "Espace non créé",
        description: isApiError(err, 400) ? "Ce nom n'est pas utilisable." : "Réessayez dans un instant.",
      });
    }
  };

  /** Switch to another space and load it. */
  const switchWorkspace = async (id: string) => {
    if (id === ws) return;
    setBooting(true);
    try {
      await loadSpace(id);
    } catch {
      showToast({ tone: "danger", title: "Espace injoignable", description: "Réessayez dans un instant." });
    } finally {
      setBooting(false);
    }
  };

  // Global keyboard shortcuts, using the user's (customizable) bindings. Suspended whenever a modal,
  // dialog, the preferences overlay or the login flow is up, so their own key handling wins.
  const shortcutsEnabled =
    authStage === "app" &&
    modal === null &&
    view !== "prefs" &&
    editing === null &&
    channelSettingsId === null &&
    channelNotifId === null;
  useGlobalShortcuts(
    settings.shortcuts,
    {
      search: () => setModal("search"),
      switcher: () => setModal("switcher"),
      newMessage: () => setModal("newMessage"),
      nextUnread: () => gotoUnread(1),
      prevUnread: () => gotoUnread(-1),
      markRead: () => {
        if (view === "channel") markConversationRead(channelId);
      },
      help: () => setModal("help"),
    },
    shortcutsEnabled,
  );

  if (booting) {
    return (
      <div
        style={{
          height: "var(--ui-vh)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "var(--surface-canvas)",
        }}
        aria-busy
        aria-label="Chargement"
      >
        <div className="wc-boot">
          <div className="wc-boot__ring">
            <span className="wc-boot__mark">
              {/* eslint-disable-next-line @next/next/no-img-element -- small same-origin brand mark */}
              <img src="/brand/ruchoir-mark.png" alt="" width={30} height={30} />
            </span>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 16, fontWeight: 600, letterSpacing: "var(--tracking-tight)", color: "var(--text-strong)" }}>
              Ruchoir
            </div>
            <div style={{ fontSize: 13, color: "var(--text-muted)", marginTop: 2 }}>Préparation de votre espace…</div>
          </div>
        </div>
      </div>
    );
  }

  if (bootError) {
    return (
      <div
        style={{
          height: "var(--ui-vh)",
          display: "flex",
          flexDirection: "column",
          gap: 12,
          alignItems: "center",
          justifyContent: "center",
          background: "var(--surface-canvas)",
          color: "var(--text-muted)",
          fontSize: 14,
          padding: 24,
          textAlign: "center",
        }}
      >
        <span>{bootError}</span>
        <Button
          onClick={() => {
            setBootError(null);
            setBooting(true);
            window.location.reload();
          }}
        >
          Réessayer
        </Button>
      </div>
    );
  }

  if (authStage !== "app") {
    return (
      <div style={{ height: "var(--ui-vh)", display: "flex", flexDirection: "column", overflow: "auto", background: "var(--surface-canvas)" }}>
        {authStage === "login" ? (
          <LoginScreen
            onSubmit={handleLogin}
            onCreateAccount={() => goToStage("signup")}
            onForgotPassword={() => goToStage("forgot")}
            onSso={() => showToast({ tone: "info", title: "Le SSO n'est pas encore disponible" })}
            onResendVerification={
              // Offered only when the sign-in was refused for an unconfirmed address.
              pendingEmail
                ? (email) => {
                    void handleResendVerification(email || pendingEmail);
                    setVerifyStatus("sent");
                    goToStage("verify");
                  }
                : undefined
            }
            error={authError}
            pending={authPending}
          />
        ) : null}
        {authStage === "signup" ? (
          <SignupScreen
            onSubmit={(values) => void handleSignup(values)}
            onBackToLogin={() => goToStage("login")}
            error={authError}
            pending={authPending}
          />
        ) : null}
        {authStage === "mfa" ? (
          <MfaChallengeScreen
            // Reached with a challenge from a real sign-in; the dev deep-link lands here without one,
            // which renders the default (authenticator) card with its submit handlers inert.
            methods={mfaChallenge?.methods ?? []}
            onSubmitCode={(method, code) => void handleMfaCode(method, code)}
            onPasskey={() => void handleMfaPasskey()}
            onCancel={() => {
              setMfaChallenge(null);
              goToStage("login");
            }}
            error={authError}
            pending={authPending}
          />
        ) : null}
        {authStage === "forgot" ? (
          <ForgotPasswordScreen
            onSubmit={(email) => void handlePasswordResetRequest(email)}
            onBackToLogin={() => goToStage("login")}
            sent={authSent}
            error={authError}
            pending={authPending}
          />
        ) : null}
        {authStage === "reset" ? (
          <ResetPasswordScreen
            onSubmit={(password) => void handlePasswordReset(password)}
            onBackToLogin={() => {
              setResetDone(false);
              goToStage("login");
            }}
            done={resetDone}
            error={authError}
            pending={authPending}
          />
        ) : null}
        {authStage === "verify" ? (
          <VerifyEmailScreen
            status={verifyStatus}
            email={pendingEmail || undefined}
            onResend={(email) => void handleResendVerification(email)}
            onBackToLogin={() => goToStage("login")}
            error={authError}
            pending={authPending}
            resent={authSent}
          />
        ) : null}
        {/*
          The invitation landing screen. It shows what the visitor was invited to before asking them
          to sign in or register; the token is held in `inviteToken` across whichever they choose,
          and `enterApp` accepts it once a session exists.
        */}
        {authStage === "invite" ? (
          <InviteScreen
            status={inviteStatus}
            preview={invitePreview}
            error={authError}
            onSignIn={() => goToStage("login")}
            onCreateAccount={() => goToStage("signup")}
            onDismiss={() => {
              setInviteToken("");
              forgetInvite();
              setInvitePreview(null);
              goToStage("login");
            }}
          />
        ) : null}
        {/*
          Onboarding is where an account with no space gets its first one: a fresh sign-in lands here
          instead of on an empty shell. The dev deep-link also reaches this stage for the audits, where
          the creation call simply fails and reports itself.
        */}
        {authStage === "onboarding" ? (
          <OnboardingFlow
            firstName={signupFirst || undefined}
            pending={authPending}
            error={authError}
            onFinish={({ workspaceName }) => void handleCreateFirstSpace(workspaceName)}
          />
        ) : null}
      </div>
    );
  }

  const wsName = workspaces.find((w) => w.id === ws)?.name ?? "espace";
  const contentTitles: Record<string, string> = {
    files: "Fichiers de l'espace",
    settings: "Réglages de l'espace",
    prefs: "Préférences",
    threads: "Fils de discussion",
    mentions: "Mentions",
    saved: "Enregistrés",
  };
  const contentTitle = view === "channel" ? (dm ? dm.name : `# ${chan.name}`) : (contentTitles[view] ?? wsName);
  const mobileTabs = [
    { id: "channels", label: "Canaux", icon: "hash" },
    { id: "messages", label: "Messages", icon: "message-square" },
    { id: "activity", label: "Activité", icon: "bell", badge: notifUnread || undefined },
    { id: "search", label: "Recherche", icon: "search" },
  ];

  const rail = (
    <WorkspaceRail
      workspaces={workspaces}
      active={ws}
      currentUser={currentUser}
      onSelect={(id) => {
        setRailOpen(false);
        void switchWorkspace(id);
      }}
      onNew={() => setModal("newWorkspace")}
      onHelp={() => setModal("help")}
      onLogout={handleLogout}
      presence={myPresence}
      onSetPresence={(p) => {
        setUserPresence(currentUser, p);
        setMyPresence(p);
        // Persist and broadcast the manual override so other members see the change live.
        void apiSetMyPresence(p).catch(() => {});
      }}
      onOpenSettings={() => openPreferences()}
      onOpenOwnProfile={() => {
        setView("channel");
        setThread(null);
        setProfileEdit(false);
        setProfile(currentUser);
      }}
      onEditOwnProfile={() => {
        setView("channel");
        setThread(null);
        setProfileEdit(true);
        setProfile(currentUser);
      }}
    />
  );

  const desktopSidebar = (
    <Sidebar
        workspace={workspaces.find((w) => w.id === ws)}
        channels={channels}
        directMessages={dms}
        view={view}
        channel={channelId}
        mentionCount={mentions.length}
        channelPrefs={channelPrefs}
        notifications={visibleNotifs}
        notifUnread={notifUnread}
        onView={setView}
        onChannel={openChannel}
        onNotify={showToast}
        onImport={() => setModal("import")}
        onInvite={() => setModal("invite")}
        onNewChannel={() => setModal("newChannel")}
        onNewMessage={() => setModal("newMessage")}
        onGlobalSearch={() => setModal("search")}
        onLeaveChannel={leaveChannel}
        onJoinChannel={joinChannel}
        onChannelSettings={setChannelSettingsId}
        onChannelNotifications={setChannelNotifId}
        onMarkRead={markConversationRead}
        onOpenNotification={openNotification}
        onToggleNotifRead={setNotifRead}
        onMarkAllNotifsRead={markAllNotifsRead}
        onOpenNotifPrefs={() => openPreferences("notifications")}
        onLogout={handleLogout}
        openNotifications={deepLinkPop === "notifications"}
      />
  );

  const content = (
    // The main landmark: screen-reader users jump here to skip the rail and channel list. Exactly one
    // view renders at a time, so there is always exactly one main. Flex container so the view fills it
    // in both the desktop row shell and the compact column shell.
    <main
      aria-label="Contenu principal"
      style={{ flex: 1, minWidth: 0, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}
    >
      {view === "channel" ? (
        <ChannelScreen
          channel={chan}
          dm={dm}
          messages={feed}
          panel={panel}
          threadId={thread}
          profileName={profile}
          profileEditing={profileEdit}
          unreadMarker={unreadMarker}
          focusMessageId={focusMessageId}
          compact={compact}
          onSend={send}
          onPanel={openPanel}
          onCloseThread={() => setThread(null)}
          onCloseProfile={() => setProfile(null)}
          onNotify={showToast}
          onUpdateChannel={(patch) => updateChannel(channelId, patch)}
          onLeaveChannel={() => leaveChannel(channelId)}
          onJoinChannel={() => joinChannel(channelId)}
          notifPref={channelPrefs[channelId] ?? DEFAULT_CHANNEL_PREF}
          onSaveNotifPref={(pref) => saveChannelPref(channelId, pref)}
          members={memberRecords}
          files={spaceFiles}
          dmPresence={dm?.presence}
          typingNames={typingNames}
          profileUserId={profileUserId}
          profilePresence={profileUserId ? presence[profileUserId] : undefined}
          onTyping={() => rtRef.current?.sendTyping(channelId)}
          actions={messageActions}
        />
      ) : null}
      {view === "files" ? (
        <FilesScreen
          spaceId={ws}
          workspaceName={workspaces.find((w) => w.id === ws)?.name ?? "espace"}
          currentUser={currentUser}
          compact={compact}
          onNotify={showToast}
        />
      ) : null}
      {view === "settings" ? (
        <WorkspaceSettings
          workspaceName={workspaces.find((w) => w.id === ws)?.name ?? "espace"}
          members={people.filter((p) => !p.bot).map((p) => ({ name: p.name, presence: p.presence }))}
          compact={compact}
          onInvite={() => setModal("invite")}
          onNotify={showToast}
        />
      ) : null}
      {view === "threads" ? <ActivityView kind="threads" items={threads} onOpen={openMessage} /> : null}
      {view === "mentions" ? <ActivityView kind="mentions" items={mentions} onOpen={openMessage} /> : null}
      {view === "saved" ? <ActivityView kind="saved" items={saved} onOpen={openMessage} /> : null}
    </main>
  );

  const overlays = (
    <>
      {/* Personal preferences take over the whole viewport (covering the rail and sidebar) so it is
          clear they are account-wide, not scoped to the current workspace. Sits below toasts (z 60)
          and dialogs (z 90) so the security sub-dialogs still layer on top. */}
      {view === "prefs" ? (
        <div style={{ position: "fixed", top: 0, left: 0, width: "var(--ui-vw)", height: "var(--ui-vh)", zIndex: 50, display: "flex", flexDirection: "column", background: "var(--surface-canvas)" }}>
          <PreferencesScreen compact={compact} initialTab={prefsTab} onClose={() => setView(prevView)} onNotify={showToast} />
        </div>
      ) : null}
      {modal === "import" ? (
        <ImportDialog
          onClose={() => setModal(null)}
          onDone={(source) => {
            setModal(null);
            showToast({ tone: "success", title: "Import lancé", description: `Reprise depuis ${source} en arrière-plan.` });
          }}
        />
      ) : null}
      {modal === "newChannel" ? <NewChannelDialog onClose={() => setModal(null)} onCreate={createChannel} /> : null}
      {modal === "newMessage" ? (
        <NewMessageDialog people={people} onClose={() => setModal(null)} onSelect={openDmByName} />
      ) : null}
      {modal === "invite" ? (
        <InviteDialog
          onClose={() => setModal(null)}
          canInvite={["owner", "admin"].includes(workspaces.find((w) => w.id === ws)?.role ?? "")}
          invitations={invitations}
          onCreate={async ({ email, role }) => {
            const created = await createInvitation(ws, { email, role });
            setInvitations(await getInvitations(ws));
            showToast({
              tone: "success",
              title: created.emailed ? "Invitation envoyée" : "Lien d'invitation créé",
              description: email ?? undefined,
            });
            return { url: created.url, emailed: created.emailed };
          }}
          onRevoke={async (id) => {
            await revokeInvitation(ws, id);
            setInvitations(await getInvitations(ws));
            showToast({ tone: "info", title: "Invitation révoquée" });
          }}
        />
      ) : null}
      {modal === "newWorkspace" ? <NewWorkspaceDialog onClose={() => setModal(null)} onCreate={createWorkspace} /> : null}
      {modal === "help" ? (
        <HelpDialog
          onClose={() => setModal(null)}
          onCustomize={() => openPreferences("shortcuts")}
          onGettingStarted={() => {
            setModal(null);
            restartWelcome();
          }}
        />
      ) : null}
      {modal === "switcher" ? (
        <QuickSwitcher
          channels={channels}
          dms={dms}
          onClose={() => setModal(null)}
          onOpen={(id) => {
            setModal(null);
            openChannel(id);
          }}
        />
      ) : null}
      {modal === "search" ? (
        <GlobalSearchDialog
          spaceId={ws}
          people={people}
          onClose={() => setModal(null)}
          onOpenMessage={openMessage}
          onOpenFile={() => {
            setModal(null);
            setView("files");
          }}
          onOpenProfile={(name) => {
            setModal(null);
            setView("channel");
            setThread(null);
            setProfileEdit(false);
            setProfile(name);
          }}
        />
      ) : null}

      {channelSettingsId && channels.find((c) => c.id === channelSettingsId) ? (
        <ChannelSettingsDialog
          channel={channels.find((c) => c.id === channelSettingsId)!}
          onClose={() => setChannelSettingsId(null)}
          onUpdate={(patch) => updateChannel(channelSettingsId, patch)}
          onNotify={showToast}
        />
      ) : null}

      {channelNotifId ? (
        <ChannelNotificationsDialog
          channelName={
            channels.find((c) => c.id === channelNotifId)?.name ??
            dms.find((d) => d.id === channelNotifId)?.name ??
            channelNotifId
          }
          isDm={!channels.some((c) => c.id === channelNotifId) && dms.some((d) => d.id === channelNotifId)}
          value={channelPrefs[channelNotifId] ?? DEFAULT_CHANNEL_PREF}
          onClose={() => setChannelNotifId(null)}
          onSave={(pref) => saveChannelPref(channelNotifId, pref)}
          onNotify={showToast}
        />
      ) : null}

      {editing ? (
        <Dialog
          title="Modifier le message"
          size="md"
          onClose={() => setEditing(null)}
          footer={
            <>
              <Button onClick={() => setEditing(null)}>Annuler</Button>
              <Button variant="primary" onClick={saveEdit}>
                Enregistrer
              </Button>
            </>
          }
        >
          <Textarea
            rows={4}
            autoFocus
            value={editing.body}
            onChange={(e) => setEditing({ ...editing, body: e.target.value })}
          />
        </Dialog>
      ) : null}

      {!settings.welcome.dismissed ? (
        <GettingStarted
          done={settings.welcome.done}
          onRun={runWelcomeStep}
          onDismiss={dismissWelcome}
          compact={compact}
        />
      ) : null}

      {toastMounted && toast ? (
        <div
          key={toastKey}
          className={toastClosing ? "wc-toast--out" : "wc-toast--in"}
          // Lift the toast above the getting-started card when it is on screen (desktop only; on compact
          // the card sits above the bottom tabs and the toast keeps its place).
          style={{ ...toastStyle.wrap, bottom: !settings.welcome.dismissed && !compact ? 84 : 20 }}
          role="status"
          aria-live="polite"
        >
          <div style={toastStyle.card}>
            <span style={toastStyle.title}>{toast.title}</span>
            {toast.description ? <span style={toastStyle.desc}>{toast.description}</span> : null}
          </div>
        </div>
      ) : null}
    </>
  );

  if (compact) {
    return (
      <>
        <div style={{ height: "var(--ui-vh)", display: "flex", flexDirection: "column", overflow: "hidden", background: "var(--surface-canvas)" }}>
          <MobileTopBar
            title={mobileContent ? contentTitle : wsName}
            workspaceName={wsName}
            onBack={mobileContent ? () => setMobileContent(false) : undefined}
            onOpenRail={() => setRailOpen(true)}
            onSearch={() => setModal("search")}
            onCompose={() => setModal("newMessage")}
          />
          <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
            {mobileContent ? (
              content
            ) : (
              // The mobile list screen is a main landmark; a visually-hidden h1 gives the screen reader
              // a heading to land on (the top bar shows the same name visually).
              <main style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
                <h1
                  style={{ position: "absolute", width: 1, height: 1, padding: 0, margin: -1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap", border: 0 }}
                >
                  {wsName}
                </h1>
                <Sidebar
                  workspace={workspaces.find((w) => w.id === ws)}
                channels={channels}
                directMessages={dms}
                view={view}
                channel={channelId}
                mentionCount={mentions.length}
                channelPrefs={channelPrefs}
                notifications={visibleNotifs}
                notifUnread={notifUnread}
                compact
                only={mobileTab}
                onView={(v) => {
                  setView(v);
                  setMobileContent(true);
                }}
                onChannel={(id) => {
                  openChannel(id);
                  setMobileContent(true);
                }}
                onNotify={showToast}
                onImport={() => setModal("import")}
                onInvite={() => setModal("invite")}
                onNewChannel={() => setModal("newChannel")}
                onNewMessage={() => setModal("newMessage")}
                onGlobalSearch={() => setModal("search")}
                onLeaveChannel={leaveChannel}
                onJoinChannel={joinChannel}
                onChannelSettings={setChannelSettingsId}
                onChannelNotifications={setChannelNotifId}
                onMarkRead={markConversationRead}
                onOpenNotification={openNotification}
                onToggleNotifRead={setNotifRead}
                onMarkAllNotifsRead={markAllNotifsRead}
                onOpenNotifPrefs={() => openPreferences("notifications")}
                onLogout={handleLogout}
                />
              </main>
            )}
          </div>
          <BottomTabs
            tabs={mobileTabs}
            active={mobileTab}
            onSelect={(id) => {
              if (id === "search") {
                setModal("search");
                return;
              }
              setMobileTab(id as "channels" | "messages" | "activity");
              setMobileContent(false);
            }}
          />
        </div>
        <Drawer open={railOpen} onClose={() => setRailOpen(false)} side="left" width={72} label="Espaces de travail">
          {rail}
        </Drawer>
        {overlays}
      </>
    );
  }

  return (
    <div style={{ height: "var(--ui-vh)", display: "flex", overflow: "hidden", background: "var(--surface-canvas)" }}>
      {rail}
      {desktopSidebar}
      {content}
      {overlays}
    </div>
  );
}
