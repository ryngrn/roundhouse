import AppKit
import Foundation
import UserNotifications

struct Counts: Decodable {
    let needsYou: Int
    let active: Int
    let blocked: Int
    enum CodingKeys: String, CodingKey {
        case needsYou = "needs_you"
        case active, blocked
    }
}

struct Overview: Decodable { let counts: Counts }
struct Notice: Decodable {
    let id: String
    let kind: String
    let title: String
    let message: String
}
struct NoticePage: Decodable {
    let notifications: [Notice]
    let cursor: String?
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let health = NSMenuItem(title: "Roundhouse is starting…", action: nil, keyEquivalent: "")
    private let counts = NSMenuItem(title: "Needs You 0 · Active 0", action: nil, keyEquivalent: "")
    private var timer: Timer?
    private let base = URL(string: "http://roundhouse")!
    private let directBase = URL(string: "http://127.0.0.1:8787")!
    private var serviceDomain: String { "gui/\(getuid())" }
    private var serviceLabel: String { "\(serviceDomain)/io.roundhouse.service" }
    private var servicePlist: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/io.roundhouse.service.plist").path
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        item.button?.title = "R"
        item.button?.toolTip = "Roundhouse"
        let menu = NSMenu()
        health.isEnabled = false
        counts.isEnabled = false
        menu.addItem(health)
        menu.addItem(counts)
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Open Roundhouse", action: #selector(openRoundhouse), keyEquivalent: "o"))
        menu.addItem(NSMenuItem(title: "Start Service", action: #selector(startService), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Stop Service", action: #selector(stopService), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "Restart Service", action: #selector(restartService), keyEquivalent: "r"))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Quit", action: #selector(quit), keyEquivalent: "q"))
        for entry in menu.items { entry.target = self }
        item.menu = menu
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        poll()
        timer = Timer.scheduledTimer(withTimeInterval: 10, repeats: true) { [weak self] _ in self?.poll() }
    }

    private func poll() {
        URLSession.shared.dataTask(with: directBase.appendingPathComponent("api/overview")) { [weak self] data, response, error in
            guard let self else { return }
            guard let data, error == nil, (response as? HTTPURLResponse)?.statusCode == 200,
                  let overview = try? JSONDecoder().decode(Overview.self, from: data) else {
                DispatchQueue.main.async {
                    self.health.title = "● App service unavailable"
                    self.counts.title = "Counts unavailable"
                    self.item.button?.title = "R!"
                }
                return
            }
            URLSession.shared.dataTask(with: self.base.appendingPathComponent("health")) { _, frontResponse, frontError in
                let frontHealthy = frontError == nil && (frontResponse as? HTTPURLResponse)?.statusCode == 200
                DispatchQueue.main.async {
                    self.health.title = frontHealthy ? "● App and front door healthy" : "● Front door unavailable · app healthy"
                    self.counts.title = "Needs You \(overview.counts.needsYou) · Active \(overview.counts.active) · Blocked \(overview.counts.blocked)"
                    self.item.button?.title = !frontHealthy ? "R!" : overview.counts.needsYou > 0 || overview.counts.blocked > 0 ? "R•" : "R"
                }
            }.resume()
        }.resume()
        pollNotifications()
    }

    private func pollNotifications() {
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: "notificationCursor")
        let initialized = defaults.bool(forKey: "notificationsInitialized")
        var components = URLComponents(url: base.appendingPathComponent("api/notifications"), resolvingAgainstBaseURL: false)!
        if let previous { components.queryItems = [URLQueryItem(name: "after", value: previous)] }
        URLSession.shared.dataTask(with: components.url!) { data, _, _ in
            guard let data, let page = try? JSONDecoder().decode(NoticePage.self, from: data) else { return }
            if initialized {
                for notice in page.notifications where notice.kind == "needs_you" || notice.kind == "failure" || notice.kind == "completion" {
                    let content = UNMutableNotificationContent()
                    content.title = notice.title
                    content.body = notice.message
                    content.sound = notice.kind == "completion" ? nil : .default
                    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: notice.id, content: content, trigger: nil))
                }
            }
            if let cursor = page.cursor { defaults.set(cursor, forKey: "notificationCursor") }
            defaults.set(true, forKey: "notificationsInitialized")
        }.resume()
    }

    private func launchctl(_ arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        try? process.run()
    }

    @objc private func openRoundhouse() { NSWorkspace.shared.open(base) }
    @objc private func startService() { launchctl(["bootstrap", serviceDomain, servicePlist]) }
    @objc private func stopService() { launchctl(["bootout", serviceLabel]) }
    @objc private func restartService() {
        launchctl(["bootout", serviceLabel])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.startService() }
    }
    @objc private func quit() { NSApplication.shared.terminate(nil) }
}

let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.accessory)
application.run()
