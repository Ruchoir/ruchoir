// The agenda widget (widget mockup "Widgets iOS"): the next event (small), the day (medium), the
// week with what is coming (large, with "New event"), and the lock screen's line and rectangle.

import SwiftUI
import WidgetKit

struct AgendaEvent: Decodable, Identifiable {
  let event_id: String
  let calendar_id: String?
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

  /// "14:00 – 15:00", or "All day".
  var span: String {
    if all_day { return Words.allDay }
    guard let from = startDate, let to = endDate else { return when }
    return "\(Instant.time(from)) – \(Instant.time(to))"
  }

  /// Its page in the app.
  var link: URL? {
    var parts = URLComponents(string: "ruchoir://event/\(event_id)")
    parts?.queryItems = [URLQueryItem(name: "start", value: start)]
    return parts?.url
  }
}

private struct CalendarInfo: Decodable {
  let id: String
  let color: String?
  let hidden: Bool?
}

struct AgendaEntry: TimelineEntry {
  let date: Date
  /// nil: signed out; empty with `failed`: the instance could not be reached.
  let events: [AgendaEvent]?
  /// Each calendar's colour, by id.
  let colors: [String: String]
  let failed: Bool
}

struct AgendaProvider: TimelineProvider {
  func placeholder(in context: Context) -> AgendaEntry {
    AgendaEntry(date: .now, events: [], colors: [:], failed: false)
  }

  func getSnapshot(in context: Context, completion: @escaping (AgendaEntry) -> Void) {
    Task { completion(await load()) }
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<AgendaEntry>) -> Void) {
    Task {
      let entry = await load()
      // Read again in a quarter of an hour, or when the next event ends if sooner.
      var next = Date.now.addingTimeInterval(15 * 60)
      if let end = entry.events?.first(where: { ($0.endDate ?? .now) > .now })?.endDate, end < next { next = end }
      completion(Timeline(entries: [entry], policy: .after(next)))
    }
  }

  private func load() async -> AgendaEntry {
    guard Instance.signedIn else { return AgendaEntry(date: .now, events: nil, colors: [:], failed: false) }
    let now = Date.now
    // From the start of today, so the day's count holds what is over too, to a week on.
    let from = Calendar.current.startOfDay(for: now)
    let path = "/calendar/occurrences?from=\(Instant.api(from))&to=\(Instant.api(from.addingTimeInterval(8 * 86_400)))"
    async let occurrences = Instance.get(path, as: [AgendaEvent].self)
    async let calendars = Instance.get("/calendars", as: [CalendarInfo].self)
    guard let all = await occurrences else {
      return AgendaEntry(date: now, events: [], colors: [:], failed: true)
    }
    let known = await calendars ?? []
    let hidden = Set(known.filter { $0.hidden == true }.map(\.id))
    var colors: [String: String] = [:]
    for calendar in known { colors[calendar.id] = calendar.color }
    let shown = all
      .filter { !hidden.contains($0.calendar_id ?? "") }
      .sorted { ($0.startDate ?? now) < ($1.startDate ?? now) }
    return AgendaEntry(date: now, events: shown, colors: colors, failed: false)
  }
}

struct AgendaView: View {
  @Environment(\.widgetFamily) private var family
  @Environment(\.colorScheme) private var scheme
  @Environment(\.widgetRenderingMode) private var mode
  let entry: AgendaEntry

  private var look: Look { Look(scheme: scheme, glass: mode != .fullColor) }
  private static let agenda = URL(string: "ruchoir://agenda")!

  var body: some View {
    // iOS 17 wants every widget's background declared, the lock screen's too (where it is dropped).
    // The small one opens its event; the others, the agenda (their rows open their own events).
    content.widgetCard(look).widgetURL(family == .systemSmall ? (coming.first?.link ?? Self.agenda) : Self.agenda)
  }

  @ViewBuilder private var content: some View {
    switch family {
    case .accessoryInline:
      if let event = coming.first {
        Label("\(event.when) · \(event.title)", systemImage: "calendar")
      } else {
        Label(Words.nothingPlanned, systemImage: "calendar")
      }
    case .accessoryRectangular:
      rectangular
    case .systemSmall:
      small
    case .systemMedium:
      medium
    default:
      large
    }
  }

  /// What is not over yet, soonest first.
  private var coming: [AgendaEvent] {
    (entry.events ?? []).filter { ($0.endDate ?? entry.date) > entry.date }
  }

  /// Today's timed events and all-day ones, over or not.
  private var today: [AgendaEvent] {
    (entry.events ?? []).filter { event in
      guard let start = event.startDate else { return false }
      return Calendar.current.isDate(start, inSameDayAs: entry.date)
    }
  }

  private var message: String {
    if entry.events == nil { return Words.signIn }
    if entry.failed { return Words.unreachable }
    return Words.nothingPlanned
  }

  private func color(_ event: AgendaEvent) -> Color {
    look.pastel(entry.colors[event.calendar_id ?? ""])
  }

  /// "In 2 h", "In 20 min", "Now", or the day for later.
  private func startsIn(_ event: AgendaEvent) -> String {
    guard let start = event.startDate else { return "" }
    let minutes = Int((start.timeIntervalSince(entry.date) / 60).rounded())
    if minutes <= 0 { return Words.now }
    if minutes < 60 { return Words.inMinutes(minutes) }
    if minutes < 24 * 60 { return Words.inHours(Int((Double(minutes) / 60).rounded())) }
    return dayLabel(start)
  }

  /// "Today", or "Wed. 17".
  private func dayLabel(_ date: Date) -> String {
    if Calendar.current.isDateInToday(date) { return Words.today }
    let text = date.formatted(.dateTime.weekday(.abbreviated).day())
    return text.prefix(1).uppercased() + text.dropFirst()
  }

  // MARK: Lock screen

  private var rectangular: some View {
    VStack(alignment: .leading, spacing: 1) {
      if let event = coming.first {
        HStack(spacing: 5) {
          Mark(size: 12, color: .primary)
          Text(event.span).font(Face.sans(12, .semibold))
        }
        .opacity(0.85)
        .widgetAccentable()
        Text(event.title).font(Face.sans(15, .bold)).lineLimit(1)
        if let place = event.location, !place.isEmpty {
          Text(place).font(Face.sans(12)).opacity(0.8).lineLimit(1)
        }
      } else {
        Text(Words.agenda).font(Face.sans(15, .bold))
        Text(message).font(Face.sans(12)).lineLimit(2)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  // MARK: Small: the next event

  private var small: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack {
        Image(systemName: "calendar")
          .font(.system(size: 14, weight: .semibold))
          .foregroundStyle(look.onPastel)
          .frame(width: 28, height: 28)
          .background(look.pastel("sky"), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        Spacer()
        if let event = coming.first {
          Text(startsIn(event)).font(Face.sans(11.5, .semibold)).foregroundStyle(look.muted)
        }
      }
      Spacer(minLength: 0)
      if let event = coming.first {
        Text(event.when).font(Face.mono(26)).foregroundStyle(look.strong).lineLimit(1).minimumScaleFactor(0.7)
        Text(event.title).font(Face.sans(14, .bold)).foregroundStyle(look.strong).lineLimit(2)
        if let place = event.location, !place.isEmpty {
          Text(place).font(Face.sans(12)).foregroundStyle(look.muted).lineLimit(1)
        }
      } else {
        Text(message).font(Face.sans(13)).foregroundStyle(look.muted)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }

  // MARK: Medium: the day

  private var medium: some View {
    HStack(alignment: .top, spacing: 14) {
      VStack(alignment: .leading, spacing: 0) {
        Text(entry.date.formatted(.dateTime.weekday(.wide)).uppercased())
          .font(Face.sans(12, .bold))
          .foregroundStyle(look.danger)
          .lineLimit(1)
          .minimumScaleFactor(0.8)
        Text(entry.date.formatted(.dateTime.day()))
          .font(Face.sans(44, .bold))
          .foregroundStyle(look.strong)
          .kerning(-1.3)
        Spacer(minLength: 0)
        Text(entry.events == nil ? Words.signIn : entry.failed ? Words.unreachable : Words.todayCount(today.count))
          .font(Face.sans(11.5))
          .foregroundStyle(look.muted)
          .lineSpacing(1)
      }
      .frame(width: 96, alignment: .leading)
      .frame(maxHeight: .infinity, alignment: .topLeading)
      VStack(spacing: 7) {
        ForEach(Array(today.filter { ($0.endDate ?? entry.date) > entry.date }.prefix(2))) { event in
          Link(destination: event.link ?? Self.agenda) {
            HStack(spacing: 9) {
              RoundedRectangle(cornerRadius: 2).fill(color(event)).frame(width: 4)
              VStack(alignment: .leading, spacing: 1) {
                Text(event.title).font(Face.sans(13.5, .bold)).foregroundStyle(look.strong).lineLimit(1)
                Text([event.when, event.location ?? ""].filter { !$0.isEmpty }.joined(separator: " · "))
                  .font(Face.sans(11.5)).foregroundStyle(look.muted).lineLimit(1)
              }
              Spacer(minLength: 0)
            }
            .padding(.vertical, 8)
            .padding(.horizontal, 10)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
            .background(look.tint(color(event), 0.26), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
      }
      .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
  }

  // MARK: Large: the week and what is coming

  private var week: [Date] {
    let calendar = Calendar.current
    let start = calendar.dateInterval(of: .weekOfYear, for: entry.date)?.start ?? calendar.startOfDay(for: entry.date)
    return (0..<7).compactMap { calendar.date(byAdding: .day, value: $0, to: start) }
  }

  private func hasEvents(_ day: Date) -> Bool {
    (entry.events ?? []).contains { event in
      guard let start = event.startDate else { return false }
      return Calendar.current.isDate(start, inSameDayAs: day)
    }
  }

  private var large: some View {
    VStack(alignment: .leading, spacing: 12) {
      HStack(spacing: 8) {
        Mark(size: 22, color: look.mark)
        Text("\(Words.agenda) · \(entry.date.formatted(.dateTime.month(.wide)))")
          .font(Face.sans(15, .bold)).foregroundStyle(look.strong).lineLimit(1)
        Spacer(minLength: 4)
        if entry.events != nil {
          // Interactive, as its mockup says: the form opens at once.
          Link(destination: URL(string: "ruchoir://new-event")!) {
            HStack(spacing: 5) {
              Image(systemName: "calendar.badge.plus").font(.system(size: 12, weight: .semibold))
              Text(Words.newEvent).font(Face.sans(12, .bold)).lineLimit(1)
            }
            .foregroundStyle(look.onPastel)
            .padding(.horizontal, 10)
            .frame(height: 30)
            .background(look.acc, in: Capsule())
          }
        }
      }
      HStack(spacing: 4) {
        ForEach(week, id: \.self) { day in
          let isToday = Calendar.current.isDate(day, inSameDayAs: entry.date)
          VStack(spacing: 2) {
            Text(String(day.formatted(.dateTime.weekday(.narrow))))
              .font(Face.sans(10, .semibold)).opacity(0.8)
            Text(day.formatted(.dateTime.day())).font(Face.sans(16, .bold))
            Circle()
              .fill(hasEvents(day) ? (isToday ? look.onPastel : look.muted) : Color.clear)
              .frame(width: 5, height: 5)
          }
          .foregroundStyle(isToday ? look.onPastel : look.strong)
          .frame(maxWidth: .infinity)
          .frame(height: 50)
          .background(isToday ? look.acc : Color.clear, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
      }
      if coming.isEmpty {
        Text(message).font(Face.sans(13)).foregroundStyle(look.muted)
      }
      VStack(spacing: 5) {
        ForEach(Array(coming.prefix(4))) { event in
          Link(destination: event.link ?? Self.agenda) {
            HStack(spacing: 10) {
              RoundedRectangle(cornerRadius: 2).fill(color(event)).frame(width: 4)
              VStack(alignment: .leading, spacing: 0) {
                Text(event.startDate.map(dayLabel) ?? "").font(Face.sans(10.5, .semibold)).foregroundStyle(look.muted).lineLimit(1)
                Text(event.when).font(Face.mono(12.5)).foregroundStyle(look.strong).lineLimit(1)
              }
              .frame(width: 58, alignment: .leading)
              VStack(alignment: .leading, spacing: 0) {
                Text(event.title).font(Face.sans(13.5, .bold)).foregroundStyle(look.strong).lineLimit(1)
                if let place = event.location, !place.isEmpty {
                  Text(place).font(Face.sans(11.5)).foregroundStyle(look.muted).lineLimit(1)
                }
              }
              Spacer(minLength: 0)
            }
            .padding(.vertical, 6)
            .padding(.horizontal, 10)
            .fixedSize(horizontal: false, vertical: true)
            .background(look.tint(color(event), 0.26), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
          }
        }
      }
      Spacer(minLength: 0)
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
