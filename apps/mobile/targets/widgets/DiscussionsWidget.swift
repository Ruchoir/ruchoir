// The discussions widget: how much is unread, and who is waiting for an answer.

import SwiftUI
import WidgetKit

private struct SpaceSummary: Decodable {
  let unread: Int?
  let mentions: Int?
}

struct Note: Decodable, Identifiable {
  let id: String
  let kind: String
  let actor_name: String?
  let channel_name: String?
  let space_name: String
  let preview: String

  /// "#général", or the person who wrote.
  var place: String {
    if let channel = channel_name { return "#" + channel }
    return actor_name ?? space_name
  }
}

private struct NotePage: Decodable {
  let notifications: [Note]
}

struct DiscussionsEntry: TimelineEntry {
  let date: Date
  /// nil: signed out.
  let unread: Int?
  let notes: [Note]
  let failed: Bool
}

struct DiscussionsProvider: TimelineProvider {
  func placeholder(in context: Context) -> DiscussionsEntry {
    DiscussionsEntry(date: .now, unread: 0, notes: [], failed: false)
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
    guard Instance.signedIn else { return DiscussionsEntry(date: .now, unread: nil, notes: [], failed: false) }
    async let spaces = Instance.get("/me/spaces", as: [SpaceSummary].self)
    async let page = Instance.get("/notifications?unread=true&limit=3", as: NotePage.self)
    guard let all = await spaces else {
      return DiscussionsEntry(date: .now, unread: 0, notes: [], failed: true)
    }
    let unread = all.reduce(0) { $0 + ($1.unread ?? 0) }
    return DiscussionsEntry(date: .now, unread: unread, notes: await page?.notifications ?? [], failed: false)
  }
}

struct DiscussionsView: View {
  @Environment(\.widgetFamily) private var family
  let entry: DiscussionsEntry

  var body: some View {
    content.widgetCanvas().widgetURL(URL(string: "ruchoir://discussions"))
  }

  @ViewBuilder private var content: some View {
    switch family {
    case .accessoryCircular:
      ZStack {
        AccessoryWidgetBackground()
        VStack(spacing: 0) {
          Text("\(entry.unread ?? 0)").font(.title2.weight(.bold)).widgetAccentable()
          Image(systemName: "bubble.left.and.bubble.right").font(.caption2)
        }
      }
    case .accessoryInline:
      Text("\(entry.unread ?? 0) \(Words.unread)")
    case .systemSmall:
      VStack(alignment: .leading, spacing: 4) {
        Text(Words.discussions).font(.caption.weight(.semibold)).foregroundStyle(Color("brand"))
        Spacer(minLength: 0)
        if entry.unread == nil {
          Text(Words.signIn).font(.subheadline).foregroundStyle(Color("muted"))
        } else if entry.failed {
          Text(Words.unreachable).font(.subheadline).foregroundStyle(Color("muted"))
        } else {
          Text("\(entry.unread ?? 0)").font(.system(size: 40, weight: .bold)).foregroundStyle(Color("ink"))
          Text(Words.unread).font(.subheadline).foregroundStyle(Color("muted"))
          if let note = entry.notes.first {
            Text(line(note)).font(.caption).foregroundStyle(Color("ink")).lineLimit(2)
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    default:
      VStack(alignment: .leading, spacing: 8) {
        HStack {
          Text(Words.discussions).font(.caption.weight(.semibold)).foregroundStyle(Color("brand"))
          Spacer()
          if let unread = entry.unread, !entry.failed {
            Text("\(unread) \(Words.unread)").font(.caption).foregroundStyle(Color("muted"))
          }
        }
        if entry.unread == nil {
          Text(Words.signIn).font(.subheadline).foregroundStyle(Color("muted"))
        } else if entry.failed {
          Text(Words.unreachable).font(.subheadline).foregroundStyle(Color("muted"))
        } else if entry.notes.isEmpty {
          Text(Words.allRead).font(.subheadline).foregroundStyle(Color("muted"))
        } else {
          ForEach(entry.notes.prefix(family == .systemLarge ? 3 : 2)) { note in
            VStack(alignment: .leading, spacing: 1) {
              Text(note.place).font(.caption.weight(.semibold)).foregroundStyle(Color("ink")).lineLimit(1)
              Text(note.preview.isEmpty ? line(note) : note.preview)
                .font(.caption).foregroundStyle(Color("muted")).lineLimit(1)
            }
          }
        }
        Spacer(minLength: 0)
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
    }
  }

  private func line(_ note: Note) -> String {
    "\(note.actor_name ?? note.place) \(Words.mentionedYou)"
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
