// The iPhone's Notification Service Extension (ADR 0006).
//
// The relay's push carries nothing but a placeholder ("Ruchoir", "…") and `mutable-content`, so iOS
// hands it here before showing it. The push does not say which instance sent it, so the extension
// asks every instance the phone is signed in to what is waiting (ADR 0007), at once, with the
// addresses and session tokens the app shares in its keychain group (`push/phone.ts`), and shows the
// newest item of all instead: its title and text, its conversation as the thread, and what the app
// needs to open it on a tap, its instance included (under `body`, where expo-notifications reads a
// remote notification's data). When no instance can be reached, or nothing is waiting any more, it
// says only "New activity". It also asks each instance how many notifications are unread, and puts
// the total on the app's icon, as the bell counts them.
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

    let accounts = SharedKeychain.accounts()
    guard !accounts.isEmpty else {
      finish()
      return
    }
    // Every instance at once; the newest item of those that answered is shown once all are in.
    let group = DispatchGroup()
    let answers = Answers()
    for account in accounts {
      guard let url = URL(string: account.server + "/api/v1/push/pending") else { continue }
      var asking = URLRequest(url: url, timeoutInterval: 20)
      asking.setValue("Bearer " + account.token, forHTTPHeaderField: "Authorization")
      asking.setValue("application/json", forHTTPHeaderField: "Accept")
      group.enter()
      URLSession.shared.dataTask(with: asking) { data, response, _ in
        defer { group.leave() }
        guard
          let http = response as? HTTPURLResponse, http.statusCode == 200,
          let data,
          let pending = try? JSONDecoder().decode(Pending.self, from: data)
        else { return }
        answers.add(account.server, pending)
      }.resume()
      // The icon's count: this instance's unread notifications.
      guard let inbox = URL(string: account.server + "/api/v1/notifications?unread=true&limit=1") else { continue }
      var counting = URLRequest(url: inbox, timeoutInterval: 20)
      counting.setValue("Bearer " + account.token, forHTTPHeaderField: "Authorization")
      counting.setValue("application/json", forHTTPHeaderField: "Accept")
      group.enter()
      URLSession.shared.dataTask(with: counting) { data, response, _ in
        defer { group.leave() }
        guard
          let http = response as? HTTPURLResponse, http.statusCode == 200,
          let data,
          let feed = try? JSONDecoder().decode(Feed.self, from: data)
        else { return }
        answers.count(feed.unread_count)
      }.resume()
    }
    group.notify(queue: .global()) { [weak self] in
      defer { self?.finish() }
      guard let self, let content = self.content else { return }
      if let unread = answers.unread { content.badge = NSNumber(value: unread) }
      let answered = answers.all
      let items = answered.flatMap { answer in answer.pending.items.map { (server: answer.server, item: $0) } }
      guard let newest = items.max(by: { $0.item.created_at < $1.item.created_at }) else { return }
      let item = newest.item
      content.title = item.title
      content.body = items.count > 1 ? item.body + "\n" + Fallback.more(items.count - 1) : item.body
      if answered.allSatisfy({ $0.pending.silent }) { content.sound = nil }
      if let conversation = item.conversation_id { content.threadIdentifier = conversation }
      var tap: [String: String] = ["server": newest.server]
      if let value = item.space_id { tap["space_id"] = value }
      if let value = item.conversation_id { tap["conversation_id"] = value }
      if let value = item.message_id { tap["message_id"] = value }
      if let value = item.event_id { tap["event_id"] = value }
      if let value = item.channel_name { tap["channel_name"] = value }
      if let value = item.actor_name { tap["actor_name"] = value }
      content.userInfo = ["body": tap]
    }
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
    let created_at: String
  }
}

/// `GET /api/v1/notifications?unread=true&limit=1`, the field used here.
private struct Feed: Decodable {
  let unread_count: Int
}

/// What the instances answered, gathered from URLSession's queue behind a lock.
private final class Answers: @unchecked Sendable {
  private let lock = NSLock()
  private var list: [(server: String, pending: Pending)] = []
  private var counted: Int?

  func count(_ unread: Int) {
    lock.lock()
    counted = (counted ?? 0) + unread
    lock.unlock()
  }

  /// The unread total of the instances that answered; nil when none did (the icon keeps its count).
  var unread: Int? {
    lock.lock()
    defer { lock.unlock() }
    return counted
  }

  func add(_ server: String, _ pending: Pending) {
    lock.lock()
    list.append((server, pending))
    lock.unlock()
  }

  var all: [(server: String, pending: Pending)] {
    lock.lock()
    defer { lock.unlock() }
    return list
  }
}

/// A signed-in instance as the app hands it over.
private struct SharedAccount: Decodable {
  let server: String
  let token: String
}

/// The items the app wrote with expo-secure-store under the service `ruchoir.push`, in the keychain
/// group it shares with this extension. expo-secure-store stores the key as data in the account and
/// suffixes the service with `:no-auth`.
private enum SharedKeychain {
  /// Every signed-in instance (`push.accounts`); an entry that is not an `https://` address is left out.
  static func accounts() -> [SharedAccount] {
    guard let json = read("push.accounts"), let data = json.data(using: .utf8),
      let list = try? JSONDecoder().decode([SharedAccount].self, from: data)
    else { return [] }
    return list.filter { $0.server.hasPrefix("https://") }
  }

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
