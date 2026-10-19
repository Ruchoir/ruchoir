// What both widgets share: the session the app hands over, the instance's answers, the words.

import Foundation
import Security
import SwiftUI
import WidgetKit

/// The items the app writes with expo-secure-store (service `ruchoir.push`) in the keychain group it
/// shares with its extensions (`src/push/phone.ts`).
enum SharedSession {
  private static func read(_ key: String) -> String? {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrService as String: "ruchoir.push:no-auth",
      kSecAttrAccount as String: Data(key.utf8),
      kSecReturnData as String: true,
      kSecMatchLimit as String: kSecMatchLimitOne,
    ]
    var found: AnyObject?
    guard SecItemCopyMatching(query as CFDictionary, &found) == errSecSuccess,
      let data = found as? Data
    else { return nil }
    return String(data: data, encoding: .utf8)
  }

  static func value(_ key: String) -> String? { read(key) }

  static var current: (server: String, token: String)? {
    guard let server = read("push.server"), let token = read("push.token") else { return nil }
    return (server, token)
  }
}

enum Instance {
  /// GET a path of the instance's API with the shared session; nil when signed out or unreachable.
  static func get<T: Decodable>(_ path: String, as type: T.Type) async -> T? {
    guard let session = SharedSession.current, let url = URL(string: session.server + "/api/v1" + path)
    else { return nil }
    var request = URLRequest(url: url, timeoutInterval: 15)
    request.setValue("Bearer " + session.token, forHTTPHeaderField: "Authorization")
    request.setValue("application/json", forHTTPHeaderField: "Accept")
    guard let (data, response) = try? await URLSession.shared.data(for: request),
      (response as? HTTPURLResponse)?.statusCode == 200
    else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
  }

  static var signedIn: Bool { SharedSession.current != nil }

  /// The space on screen in the app, and the theme chosen there (`src/widgets/share.ts`).
  static var space: String? { SharedSession.value("widget.space") }
  static var theme: String? { SharedSession.value("widget.theme") }
}

/// An instant as the API writes it: RFC 3339 (with or without fractions), or a day for an all-day
/// event, read in the phone's own zone.
enum Instant {
  private static let withFractions: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
  }()
  private static let plain = ISO8601DateFormatter()
  private static let day: DateFormatter = {
    let f = DateFormatter()
    f.calendar = Calendar(identifier: .gregorian)
    f.locale = Locale(identifier: "en_US_POSIX")
    f.dateFormat = "yyyy-MM-dd"
    return f
  }()

  static func parse(_ text: String) -> Date? {
    withFractions.date(from: text) ?? plain.date(from: text) ?? day.date(from: text)
  }

  static func api(_ date: Date) -> String { plain.string(from: date) }

  static func time(_ date: Date) -> String {
    date.formatted(date: .omitted, time: .shortened)
  }

  static func weekday(_ date: Date) -> String {
    date.formatted(.dateTime.weekday(.abbreviated).day())
  }
}

/// A colour from the app's tokens (`src/theme/tokens.ts`), as hex.
extension Color {
  init(hex: UInt32) {
    self.init(
      .sRGB,
      red: Double((hex >> 16) & 0xFF) / 255,
      green: Double((hex >> 8) & 0xFF) / 255,
      blue: Double(hex & 0xFF) / 255,
      opacity: 1
    )
  }
}

/// The app's look in a widget: its accent and day or night, as chosen in the app ("violet-dark"),
/// else the phone's own; and, when the home screen is clear or tinted glass (`accented`), white on
/// glass, as the widget mockup's "Liquid Glass" column draws it.
struct Look {
  let dark: Bool
  let glass: Bool
  let accHex: UInt32

  static let pastels: [String: UInt32] = [
    "sky": 0x8FD0FF, "mint": 0x6FE0C2, "violet": 0xC9A8FF, "pink": 0xF5B0F0,
    "peach": 0xFFB3BA, "lime": 0x8FE6A3, "sun": 0xFFD84D,
  ]

  init(scheme: ColorScheme, glass: Bool) {
    let theme = Instance.theme ?? ""
    let accent = theme.split(separator: "-").first.map(String.init) ?? "sky"
    accHex = Look.pastels[accent] ?? Look.pastels["sky"]!
    dark = theme.isEmpty ? scheme == .dark : theme.hasSuffix("-dark")
    self.glass = glass
  }

  private func pick(_ day: UInt32, _ night: UInt32) -> Color { Color(hex: dark ? night : day) }

  var acc: Color { glass ? .white.opacity(0.9) : Color(hex: accHex) }
  var surface: Color { glass ? .white.opacity(0.14) : pick(0xFDFDFE, 0x1D2027) }
  var strong: Color { glass ? .white.opacity(0.95) : pick(0x15171C, 0xF6F7F9) }
  var body: Color { glass ? .white.opacity(0.85) : pick(0x2E323A, 0xDFE2E7) }
  var muted: Color { glass ? .white.opacity(0.68) : pick(0x5A6070, 0xA7ADB8) }
  var line: Color { glass ? .white.opacity(0.2) : pick(0xE2E5EA, 0x2E323A) }
  var onPastel: Color { Color(hex: 0x15171C) }
  var danger: Color { glass ? .white.opacity(0.95) : (dark ? Color(hex: 0xFFB3BA) : Color(hex: 0xC2303F)) }
  /// The Ruchoir mark's colour in the heads.
  var mark: Color { glass ? .white.opacity(0.95) : (dark ? Color(hex: 0xE8775E) : Color(hex: 0xCA4E34)) }

  /// A calendar's colour: one of the pastels, or the reader's accent.
  func pastel(_ name: String?) -> Color {
    if glass { return .white.opacity(0.85) }
    guard let name, let hex = Look.pastels[name] else { return Color(hex: accHex) }
    return Color(hex: hex)
  }

  /// `color-mix(in srgb, color weight%, transparent)`, the events' tint.
  func tint(_ color: Color, _ weight: Double) -> Color { color.opacity(weight) }
}

/// The app's typefaces, bundled with the widgets (Info.plist `UIAppFonts`), at fixed sizes: a
/// widget's layout is drawn to the point, as its mockup is.
enum Face {
  static func sans(_ size: CGFloat, _ weight: Font.Weight = .regular) -> Font {
    let name: String
    switch weight {
    case .bold, .heavy, .black: name = "IBMPlexSans-Bold"
    case .semibold: name = "IBMPlexSans-SemiBold"
    case .medium: name = "IBMPlexSans-Medium"
    default: name = "IBMPlexSans-Regular"
    }
    return .custom(name, fixedSize: size)
  }

  static func mono(_ size: CGFloat) -> Font { .custom("IBMPlexMono-SemiBold", fixedSize: size) }
}

/// The Ruchoir mark, tinted.
struct Mark: View {
  let size: CGFloat
  let color: Color
  var body: some View {
    Image("mark").resizable().renderingMode(.template).scaledToFit().frame(width: size, height: size).foregroundStyle(color)
  }
}

/// A count on a pill, as the app's badges.
struct CountBadge: View {
  let count: Int
  let background: Color
  let foreground: Color
  var body: some View {
    Text(count > 99 ? "99+" : "\(count)")
      .font(Face.mono(11))
      .foregroundStyle(foreground)
      .padding(.horizontal, 5)
      .frame(minWidth: 18, minHeight: 18)
      .background(background, in: Capsule())
  }
}

/// A face: the person's or the space's initials on a pastel, as the app draws a face with no photo.
struct Initials: View {
  let name: String
  let size: CGFloat
  let round: Bool
  let look: Look

  private var letters: String {
    let words = name.split(separator: " ").prefix(2)
    return words.compactMap { $0.first.map(String.init) }.joined().uppercased()
  }

  private var color: Color {
    let names = ["sky", "mint", "violet", "pink", "peach", "sun"]
    let sum = name.unicodeScalars.reduce(0) { $0 + Int($1.value) }
    return look.pastel(names[sum % names.count])
  }

  var body: some View {
    let shape = RoundedRectangle(cornerRadius: round ? size / 2 : size * 0.28, style: .continuous)
    Text(letters)
      .font(Face.sans(size * 0.38, .bold))
      .foregroundStyle(look.onPastel)
      .frame(width: size, height: size)
      .background(color, in: shape)
  }
}

/// The words the widgets say, in the app's six languages.
enum Words {
  private static var language: String {
    String((Locale.preferredLanguages.first ?? "en").prefix(2))
  }

  private static func pick(_ fr: String, _ en: String, _ es: String, _ de: String, _ it: String, _ pl: String) -> String {
    switch language {
    case "fr": return fr
    case "es": return es
    case "de": return de
    case "it": return it
    case "pl": return pl
    default: return en
    }
  }

  static var agenda: String { pick("Agenda", "Agenda", "Agenda", "Kalender", "Agenda", "Kalendarz") }
  static var discussions: String { pick("Discussions", "Discussions", "Conversaciones", "Unterhaltungen", "Discussioni", "Rozmowy") }
  static var nothingPlanned: String { pick("Rien de prévu", "Nothing planned", "Nada previsto", "Nichts geplant", "Niente in programma", "Nic zaplanowanego") }
  static var allDay: String { pick("Toute la journée", "All day", "Todo el día", "Ganztägig", "Tutto il giorno", "Cały dzień") }
  static var newEvent: String { pick("Nouvel événement", "New event", "Nuevo evento", "Neuer Termin", "Nuovo evento", "Nowe wydarzenie") }
  static var signIn: String { pick("Ouvrez Ruchoir pour vous connecter", "Open Ruchoir to sign in", "Abra Ruchoir para iniciar sesión", "Öffnen Sie Ruchoir, um sich anzumelden", "Aprite Ruchoir per accedere", "Otwórz Ruchoir, aby się zalogować") }
  static var unreachable: String { pick("Serveur injoignable", "Server unreachable", "Servidor inaccesible", "Server nicht erreichbar", "Server irraggiungibile", "Serwer nieosiągalny") }
  static var allRead: String { pick("Tout est lu", "All caught up", "Todo leído", "Alles gelesen", "Tutto letto", "Wszystko przeczytane") }
  static var unread: String { pick("non lus", "unread", "sin leer", "ungelesen", "non letti", "nieprzeczytane") }
  static var mentionedYou: String { pick("vous a mentionné", "mentioned you", "le ha mencionado", "hat Sie erwähnt", "vi ha menzionato", "wspomniał(a) o tobie") }
  static var agendaDescription: String { pick("Vos prochains rendez-vous.", "Your next events.", "Sus próximas citas.", "Ihre nächsten Termine.", "I vostri prossimi appuntamenti.", "Twoje najbliższe wydarzenia.") }
  static var today: String { pick("Aujourd’hui", "Today", "Hoy", "Heute", "Oggi", "Dzisiaj") }
  static var now: String { pick("Maintenant", "Now", "Ahora", "Jetzt", "Adesso", "Teraz") }
  static func inMinutes(_ n: Int) -> String { pick("Dans \(n) min", "In \(n) min", "En \(n) min", "In \(n) Min.", "Tra \(n) min", "Za \(n) min") }
  static func inHours(_ n: Int) -> String { pick("Dans \(n) h", "In \(n) h", "En \(n) h", "In \(n) Std.", "Tra \(n) h", "Za \(n) godz.") }
  static var messagesUnread: String { pick("messages\nnon lus", "unread\nmessages", "mensajes\nsin leer", "ungelesene\nNachrichten", "messaggi\nnon letti", "nieprzeczytane\nwiadomości") }
  static func todayCount(_ n: Int) -> String {
    if n == 0 { return pick("Rien de prévu\naujourd’hui", "Nothing\ntoday", "Nada\nhoy", "Heute\nnichts", "Niente\noggi", "Dziś\nnic") }
    if n == 1 { return pick("1 rendez-vous\naujourd’hui", "1 event\ntoday", "1 cita\nhoy", "1 Termin\nheute", "1 appuntamento\noggi", "1 wydarzenie\ndziś") }
    return pick("\(n) rendez-vous\naujourd’hui", "\(n) events\ntoday", "\(n) citas\nhoy", "\(n) Termine\nheute", "\(n) appuntamenti\noggi", "\(n) wydarzenia\ndziś")
  }
  static func said(_ who: String, _ text: String) -> String { pick("\(who) : \(text)", "\(who): \(text)", "\(who): \(text)", "\(who): \(text)", "\(who): \(text)", "\(who): \(text)") }
  static var you: String { pick("Vous", "You", "Usted", "Sie", "Voi", "Ty") }
  static var noConversation: String { pick("Aucune conversation", "No conversation", "Ninguna conversación", "Keine Unterhaltung", "Nessuna conversazione", "Brak rozmów") }
  static var nextDescription: String { pick("Votre prochain rendez-vous.", "Your next event.", "Su próxima cita.", "Ihr nächster Termin.", "Il vostro prossimo appuntamento.", "Twoje najbliższe wydarzenie.") }
  static var todayDescription: String { pick("Votre journée.", "Your day.", "Su día.", "Ihr Tag.", "La vostra giornata.", "Twój dzień.") }
  static var conversationsDescription: String { pick("Vos dernières conversations.", "Your latest conversations.", "Sus últimas conversaciones.", "Ihre letzten Unterhaltungen.", "Le vostre ultime conversazioni.", "Twoje ostatnie rozmowy.") }
  static var discussionsDescription: String { pick("Ce qui vous attend dans vos discussions.", "What is waiting in your conversations.", "Lo que le espera en sus conversaciones.", "Was in Ihren Unterhaltungen wartet.", "Cosa vi aspetta nelle discussioni.", "Co czeka w twoich rozmowach.") }
}

extension View {
  /// The widget's own background, the app's surface as the mockups draw the cards (the system lays
  /// glass instead when the home screen is clear or tinted): `containerBackground` from iOS 17 on.
  @ViewBuilder func widgetCard(_ look: Look) -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      containerBackground(look.surface, for: .widget)
    } else {
      padding(14).background(look.surface)
    }
  }
}
