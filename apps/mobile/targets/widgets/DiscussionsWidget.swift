// The discussions widget (widget mockup "Widgets iOS"): how much is unread and who addressed the
// reader (small), the space's latest conversations (medium), and the lock screen's round.

import SwiftUI
import WidgetKit

private struct SpaceSummary: Decodable {
  let id: String
  let unread: Int?
}

struct Note: Decodable, Identifiable {
  let id: String
  let kind: String
  let actor_name: String?
  let channel_name: String?
  let space_name: String
  let preview: String
  let created_at: String?
  /// The instance it comes from, set once read (ADR 0007).
  var server: String? = nil

  func from(_ server: String) -> Note {
    var note = self
    note.server = server
    return note
  }
}

private struct NotePage: Decodable {
  let notifications: [Note]
}

private struct LastMessage: Decodable {
  let excerpt: String
  let mine: Bool
  let created_at: String
  let author: String?
  let system_event: String?
}

private struct ChannelRow: Decodable {
  let id: String
  let name: String
  let member: Bool
  let unread: Int
  let last_message: LastMessage?
}

private struct DirectRow: Decodable {
  let id: String
  let name: String
  let unread: Int
  let last_message: LastMessage?
}

/// One of the space's conversations, as a row says it.
struct Conversation: Identifiable {
  let id: String
  let name: String
  let channel: Bool
  let unread: Int
  let at: Date?
  let preview: String
  let space: String

  var link: URL? {
    var parts = URLComponents(string: "ruchoir://conversation/\(id)")
    parts?.queryItems = [
      URLQueryItem(name: "title", value: name),
      URLQueryItem(name: "space", value: space),
      URLQueryItem(name: "channel", value: channel ? "1" : "0"),
    ]
    return parts?.url
  }
}

struct DiscussionsEntry: TimelineEntry {
  let date: Date
  /// nil: signed out.
  let unread: Int?
  let notes: [Note]
  let conversations: [Conversation]
  let failed: Bool
}

struct DiscussionsProvider: TimelineProvider {
  func placeholder(in context: Context) -> DiscussionsEntry {
    DiscussionsEntry(date: .now, unread: 0, notes: [], conversations: [], failed: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (DiscussionsEntry) -> Void) {
    Task { completion(await load()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<DiscussionsEntry>) -> Void) {
    Task {
      let entry = await load()
      completion(Timeline(entries: [entry], policy: .after(Date.now.addingTimeInterval(15 * 60))))
    }
  }

  private func load() async -> DiscussionsEntry {
    guard Instance.signedIn else {
      return DiscussionsEntry(date: .now, unread: nil, notes: [], conversations: [], failed: false)
    }
    // The unread count and the notes of every instance (ADR 0007); the conversations of the space on
    // screen, on its own instance.
    async let everySpace = Instance.everywhere("/me/spaces", as: [SpaceSummary].self)
    async let pages = Instance.everywhere("/notifications?unread=true&limit=10", as: NotePage.self)
    async let spaces = Instance.get("/me/spaces", as: [SpaceSummary].self)
    guard let everywhere = await everySpace else {
      return DiscussionsEntry(date: .now, unread: 0, notes: [], conversations: [], failed: true)
    }
    let unread = everywhere.flatMap(\.value).reduce(0) { $0 + ($1.unread ?? 0) }
    let spoken: Set<String> = ["mention", "reply", "dm", "broadcast"]
    let notes = (await pages ?? [])
      .flatMap { answer in answer.value.notifications.map { $0.from(answer.server) } }
      .filter { spoken.contains($0.kind) }
      .sorted { ($0.created_at ?? "") > ($1.created_at ?? "") }
    let all = await spaces ?? []
    // The space on screen in the app, else the first one.
    let space = Instance.space.flatMap { id in all.first { $0.id == id }?.id } ?? all.first?.id
    var conversations: [Conversation] = []
    if let space {
      async let channels = Instance.get("/spaces/\(space)/channels", as: [ChannelRow].self)
      async let directs = Instance.get("/spaces/\(space)/dms", as: [DirectRow].self)
      for row in (await channels ?? []) where row.member {
        conversations.append(Conversation(id: row.id, name: row.name, channel: true, unread: row.unread, at: row.last_message.flatMap { Instant.parse($0.created_at) }, preview: preview(row.last_message), space: space))
      }
      for row in await directs ?? [] {
        conversations.append(Conversation(id: row.id, name: row.name, channel: false, unread: row.unread, at: row.last_message.flatMap { Instant.parse($0.created_at) }, preview: preview(row.last_message), space: space))
      }
      conversations.sort { ($0.at ?? .distantPast) > ($1.at ?? .distantPast) }
    }
    return DiscussionsEntry(date: .now, unread: unread, notes: notes, conversations: Array(conversations.prefix(3)), failed: false)
  }

  /// "Léa: the words", "You: the words", or a notice as it reads.
  private func preview(_ last: LastMessage?) -> String {
    guard let last else { return "" }
    if last.system_event != nil { return last.excerpt }
    if last.mine { return Words.said(Words.you, last.excerpt) }
    if let author = last.author, let first = author.split(separator: " ").first { return Words.said(String(first), last.excerpt) }
    return last.excerpt
  }
}

struct DiscussionsView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var mode
  let entry: DiscussionsEntry

  private var look: Look { Look(scheme: scheme, glass: mode != .fullColor) }
  private static let discussions = URL(string: "ruchoir://discussions")!

  var body: some View {
    content.widgetCard(look).widgetURL(Self.discussions)
  }

  @ViewBuilder private var content: some View {
    switch family {
    case .accessoryCircular:
      ZStack {
        AccessoryWidgetBackground()
        VStack(spacing: 1) {
          Image(systemName: "message").font(.system(size: 16, weight: .semibold))
          Text("\(entry.unread ?? 0)").font(Face.sans(20, .bold)).widgetAccentable()
        }
      }
    case .accessoryInline:
      Label("\(entry.unread ?? 0) \(Words.unread)", systemImage: "message")
    case .systemSmall:
      small
    default:
      medium
    }
  }

  private var message: String? {
    if entry.unread == nil { return Words.signIn }
    if entry.failed { return Words.unreachable }
    return nil
  }

  /// "Léa mentioned you".
  private func line(_ note: Note) -> String {
    let who = note.actor_name.flatMap { $0.split(separator: " ").first.map(String.init) } ?? note.channel_name ?? note.space_name
    return "\(who) \(Words.mentionedYou)"
  }

  // MARK: Small: the count, and who addressed the reader

  private var small: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: 6) {
        Mark(size: 20, color: look.mark)
        Text(Words.discussions).font(Face.sans(12, .bold)).foregroundStyle(look.strong).lineLimit(1)
      }
      Spacer(minLength: 0)
      if let message {
        Text(message).font(Face.sans(13)).foregroundStyle(look.muted)
      } else {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text("\(entry.unread ?? 0)").font(Face.sans(40, .bold)).foregroundStyle(look.strong).kerning(-1.2).lineLimit(1).minimumScaleFactor(0.6)
          Text(Words.messagesUnread).font(Face.sans(12.5)).foregroundStyle(look.body).lineLimit(2)
        }
        if let note = entry.notes.first {
          HStack(spacing: 5) {
            Image(systemName: "at").font(.system(size: 12, weight: .bold))
            Text(line(note)).font(Face.sans(11.5, .bold)).lineLimit(1)
          }
          .foregroundStyle(look.onPastel)
          .padding(.vertical, 5)
          .padding(.horizontal, 8)
          .frame(maxWidth: .infinity, alignment: .leading)
          .background(look.acc, in: RoundedRectangle(cornerRadius: 9, style: .continuous))
          .padding(.top, 6)
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  // MARK: Medium: the latest conversations

  private func time(_ date: Date?) -> String {
    guard let date else { return "" }
    if Calendar.current.isDateInToday(date) { return Instant.time(date) }
    return date.formatted(Date.FormatStyle.dateTime.weekday(.abbreviated).locale(Words.locale))
  }

  private var medium: some View {
    VStack(alignment: .leading, spacing: 6) {
      if let message {
        Text(message).font(Face.sans(13)).foregroundStyle(look.muted)
      } else if entry.conversations.isEmpty {
        Text(Words.noConversation).font(Face.sans(13)).foregroundStyle(look.muted)
      }
      ForEach(entry.conversations) { conversation in
        Link(destination: conversation.link ?? Self.discussions) {
          HStack(spacing: 10) {
            Initials(name: conversation.name, size: 32, round: false, look: look)
            VStack(alignment: .leading, spacing: 0) {
              HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(conversation.name).font(Face.sans(13.5, .bold)).foregroundStyle(look.strong).lineLimit(1)
                Spacer(minLength: 0)
                Text(time(conversation.at)).font(Face.sans(11)).foregroundStyle(look.muted)
              }
              Text(conversation.preview).font(Face.sans(12)).foregroundStyle(look.body).lineLimit(1)
            }
            if conversation.unread > 0 {
              CountBadge(
                count: conversation.unread,
                background: conversation.channel ? look.acc : look.strong,
                foreground: conversation.channel ? look.onPastel : look.surface
              )
            }
          }
          .frame(minHeight: 40)
        }
      }
      Spacer(minLength: 0)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

struct DiscussionsWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RuchoirDiscussions", provider: DiscussionsProvider()) { entry in
      DiscussionsView(entry: entry)
    }
    .configurationDisplayName(Words.discussions)
    .description(Words.discussionsDescription)
    .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryInline])
  }
}
