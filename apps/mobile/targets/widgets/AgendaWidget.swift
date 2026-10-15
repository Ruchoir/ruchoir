// The agenda widget: the next events, on the home screen and the lock screen.

import SwiftUI
import WidgetKit

struct AgendaEvent: Decodable, Identifiable {
  let event_id: String
  let title: String
  let location: String?
  let all_day: Bool
  let start: String
  let end: String

  var id: String { event_id + start }
  var startDate: Date? { Instant.parse(start) }
  var endDate: Date? { Instant.parse(end) }

  /// "14:00", or "All day".
  var when: String {
    if all_day { return Words.allDay }
    guard let date = startDate else { return "" }
    return Instant.time(date)
  }
}

struct AgendaEntry: TimelineEntry {
  let date: Date
  /// nil: signed out; empty with `failed`: the instance could not be reached.
  let events: [AgendaEvent]?
  let failed: Bool
}

struct AgendaProvider: TimelineProvider {
  func placeholder(in context: Context) -> AgendaEntry {
    AgendaEntry(date: .now, events: [], failed: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (AgendaEntry) -> Void) {
    Task { completion(await load()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<AgendaEntry>) -> Void) {
    Task {
      let entry = await load()
      // Read again in a quarter of an hour, or when the next event ends if sooner.
      var next = Date.now.addingTimeInterval(15 * 60)
      if let end = entry.events?.first?.endDate, end > .now, end < next { next = end }
      completion(Timeline(entries: [entry], policy: .after(next)))
    }
  }

  private func load() async -> AgendaEntry {
    guard Instance.signedIn else { return AgendaEntry(date: .now, events: nil, failed: false) }
    let now = Date.now
    let path = "/calendar/occurrences?from=\(Instant.api(now))&to=\(Instant.api(now.addingTimeInterval(7 * 86_400)))"
    guard let all = await Instance.get(path, as: [AgendaEvent].self) else {
      return AgendaEntry(date: now, events: [], failed: true)
    }
    let upcoming = all
      .filter { ($0.endDate ?? now) > now }
      .sorted { ($0.startDate ?? now) < ($1.startDate ?? now) }
    return AgendaEntry(date: now, events: Array(upcoming.prefix(6)), failed: false)
  }
}

struct AgendaView: View {
  @Environment(\.widgetFamily) private var family
  let entry: AgendaEntry

  var body: some View {
    // iOS 17 wants every widget's background declared, the lock screen's too (where it is dropped).
    content.widgetCanvas().widgetURL(URL(string: "ruchoir://agenda"))
  }

  @ViewBuilder private var content: some View {
    switch family {
    case .accessoryInline:
      if let event = entry.events?.first {
        Text("\(event.when) · \(event.title)")
      } else {
        Text(Words.nothingPlanned)
      }
    case .accessoryRectangular:
      VStack(alignment: .leading, spacing: 1) {
        if let event = entry.events?.first {
          Text(event.when).font(.caption).widgetAccentable()
          Text(event.title).font(.headline).lineLimit(1)
          if let place = event.location, !place.isEmpty {
            Text(place).font(.caption).lineLimit(1)
          }
        } else {
          Text(Words.agenda).font(.headline)
          Text(message).font(.caption).lineLimit(2)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
    case .systemSmall:
      small
    default:
      list(limit: family == .systemLarge ? 6 : 3)
    }
  }

  private var message: String {
    if entry.events == nil { return Words.signIn }
    if entry.failed { return Words.unreachable }
    return Words.nothingPlanned
  }

  private var header: some View {
    HStack {
      Text(Words.agenda).font(.caption.weight(.semibold)).foregroundStyle(Color("brand"))
      Spacer()
      Text(Instant.weekday(entry.date)).font(.caption).foregroundStyle(Color("muted"))
    }
  }

  private var small: some View {
    VStack(alignment: .leading, spacing: 6) {
      header
      Spacer(minLength: 0)
      if let event = entry.events?.first {
        Text(event.when).font(.title3.weight(.bold)).foregroundStyle(Color("ink"))
        Text(event.title).font(.subheadline.weight(.semibold)).foregroundStyle(Color("ink")).lineLimit(2)
        if let place = event.location, !place.isEmpty {
          Text(place).font(.caption).foregroundStyle(Color("muted")).lineLimit(1)
        }
      } else {
        Text(message).font(.subheadline).foregroundStyle(Color("muted"))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  private func list(limit: Int) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      header
      if let events = entry.events, !events.isEmpty {
        ForEach(events.prefix(limit)) { event in
          HStack(alignment: .top, spacing: 8) {
            RoundedRectangle(cornerRadius: 2).fill(Color("brand")).frame(width: 3)
            VStack(alignment: .leading, spacing: 1) {
              Text(event.title).font(.subheadline.weight(.semibold)).foregroundStyle(Color("ink")).lineLimit(1)
              Text([event.when, event.location ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.caption).foregroundStyle(Color("muted")).lineLimit(1)
            }
          }
          .fixedSize(horizontal: false, vertical: true)
        }
      } else {
        Text(message).font(.subheadline).foregroundStyle(Color("muted"))
      }
      Spacer(minLength: 0)
      if family == .systemLarge, entry.events != nil {
        Link(destination: URL(string: "ruchoir://new-event")!) {
          Text(Words.newEvent)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(.white)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 8)
            .background(Color("brand"), in: RoundedRectangle(cornerRadius: 10))
        }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

struct AgendaWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: "RuchoirAgenda", provider: AgendaProvider()) { entry in
      AgendaView(entry: entry)
    }
    .configurationDisplayName(Words.agenda)
    .description(Words.agendaDescription)
    .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryInline, .accessoryRectangular])
  }
}
