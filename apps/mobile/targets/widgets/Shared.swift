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
  static var discussionsDescription: String { pick("Ce qui vous attend dans vos discussions.", "What is waiting in your conversations.", "Lo que le espera en sus conversaciones.", "Was in Ihren Unterhaltungen wartet.", "Cosa vi aspetta nelle discussioni.", "Co czeka w twoich rozmowach.") }
}

extension View {
  /// The widget's own background: `containerBackground` from iOS 17 on, a plain one before.
  @ViewBuilder func widgetCanvas() -> some View {
    if #available(iOSApplicationExtension 17.0, *) {
      containerBackground(Color("canvas"), for: .widget)
    } else {
      background(Color("canvas"))
    }
  }
}
