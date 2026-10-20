// The iPhone's Notification Service Extension (ADR 0006).
//
// The relay's push carries nothing but a placeholder ("Ruchoir", "…") and `mutable-content`, so iOS
// hands it here before showing it. The extension asks the instance what is waiting, with the address
// and the session token the app shares in its keychain group (`push/phone.ts`), and shows the newest
// item instead: its title and text, its conversation as the thread, and what the app needs to open
// it on a tap (under `body`, where expo-notifications reads a remote notification's data). When the
// instance cannot be reached, or nothing is waiting any more, it says only "New activity".
//
// Whatever it shows, it then tells WidgetKit to read again: something new is waiting, and the home
// screen's widgets would otherwise keep the old count until their own quarter hour (which iOS
// stretches to an hour or more).

import Foundation
import Security
import UserNotifications
import WidgetKit

final class NotificationService: UNNotificationServiceExtension {
  private var contentHandler: ((UNNotificationContent) -> Void)?
  private var content: UNMutableNotificationContent?

  override func didReceive(
    _ request: UNNotificationRequest,
    withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
  ) {
    let content =
      (request.content.mutableCopy() as? UNMutableNotificationContent) ?? UNMutableNotificationContent()
    content.title = "Ruchoir"
    content.body = Fallback.newActivity()
    self.contentHandler = contentHandler
    self.content = content

    guard
      let server = SharedKeychain.read("push.server"),
      let token = SharedKeychain.read("push.token"),
      let url = URL(string: server + "/api/v1/push/pending")
    else {
      finish()
      return
    }
    var asking = URLRequest(url: url, timeoutInterval: 20)
    asking.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
    asking.setValue("application/json", forHTTPHeaderField: "Accept")
    URLSession.shared.dataTask(with: asking) { [weak self] data, response, _ in
      defer { self?.finish() }
      guard
        let self, let content = self.content,
        let http = response as? HTTPURLResponse, http.statusCode == 200,
        let data,
        let pending = try? JSONDecoder().decode(Pending.self, from: data),
        let newest = pending.items.first
      else { return }
      content.title = newest.title
      content.body =
        pending.items.count > 1
        ? newest.body + "\n" + Fallback.more(pending.items.count - 1)
        : newest.body
      if pending.silent { content.sound = nil }
      if let conversation = newest.conversation_id { content.threadIdentifier = conversation }
      var tap: [String: String] = [:]
      if let value = newest.space_id { tap["space_id"] = value }
      if let value = newest.conversation_id { tap["conversation_id"] = value }
      if let value = newest.message_id { tap["message_id"] = value }
      if let value = newest.event_id { tap["event_id"] = value }
      if let value = newest.channel_name { tap["channel_name"] = value }
      if let value = newest.actor_name { tap["actor_name"] = value }
      content.userInfo = ["body": tap]
    }.resume()
  }

  /// iOS is about to give up on the extension: show what there is.
  override func serviceExtensionTimeWillExpire() {
    finish()
  }

  private func finish() {
    guard let handler = contentHandler, let content else { return }
    contentHandler = nil
    handler(content)
    WidgetCenter.shared.reloadAllTimelines()
  }
}

/// `GET /api/v1/push/pending`, the fields used here.
private struct Pending: Decodable {
  let silent: Bool
  let items: [Item]

  struct Item: Decodable {
    let title: String
    let body: String
    let space_id: String?
    let conversation_id: String?
    let message_id: String?
    let event_id: String?
    let channel_name: String?
    let actor_name: String?
  }
}

/// The items the app wrote with expo-secure-store under the service `ruchoir.push`, in the keychain
/// group it shares with this extension. expo-secure-store stores the key as data in the account and
/// suffixes the service with `:no-auth`.
private enum SharedKeychain {
  static func read(_ key: String) -> String? {
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
}

/// The words the extension says by itself, in the app's six languages.
private enum Fallback {
  private static var language: String {
    let preferred = Locale.preferredLanguages.first ?? "en"
    return String(preferred.prefix(2))
  }

  static func newActivity() -> String {
    switch language {
    case "fr": return "Nouvelle activité"
    case "es": return "Nueva actividad"
    case "de": return "Neue Aktivität"
    case "it": return "Nuova attività"
    case "pl": return "Nowa aktywność"
    default: return "New activity"
    }
  }

  static func more(_ count: Int) -> String {
    switch language {
    case "fr": return "et \(count) de plus"
    case "es": return "y \(count) más"
    case "de": return "und \(count) weitere"
    case "it": return "e altri \(count)"
    case "pl": return "i \(count) więcej"
    default: return "and \(count) more"
    }
  }
}
