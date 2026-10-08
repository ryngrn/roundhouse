import AppKit
import Foundation
import UserNotifications

struct Counts: Decodable {
    let needsYou: Int
    let active: Int
    let queued: Int
    let completed: Int
    let blocked: Int
    let needsReview: Int?
    enum CodingKeys: String, CodingKey {
        case needsYou = "needs_you"
        case needsReview = "needs_review"
        case active, queued, completed, blocked
    }
}

struct Notice: Decodable {
    let id: String
    let kind: String
    let title: String
    let message: String
}
struct LocalSnapshot: Decodable {
    let counts: Counts
    let notifications: [Notice]
    let cursor: String?
    let capturedAt: String?
    let projectionRevision: String?
    let snapshotError: String?
    enum CodingKeys: String, CodingKey {
        case counts, notifications, cursor
        case capturedAt = "captured_at"
        case projectionRevision = "projection_revision"
        case snapshotError = "snapshot_error"
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let health = NSMenuItem(title: "Roundhouse is starting…", action: nil, keyEquivalent: "")
    private let counts = NSMenuItem(title: "Projection counts unavailable", action: nil, keyEquivalent: "")
    private var timer: Timer?
    private let dashboard = URL(string: "https://roundhouse.ryan.green/")!
    private let directBase = URL(string: "http://127.0.0.1:8787")!
    private var serviceDomain: String { "gui/\(getuid())" }
    private var serviceLabel: String { "\(serviceDomain)/io.roundhouse.service" }
    private var servicePlist: String {
        FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/io.roundhouse.service.plist").path
    }
    private lazy var lightStatusImage = loadStatusImage(named: "status-light")
    private lazy var darkStatusImage = loadStatusImage(named: "status-dark")

    func applicationDidFinishLaunching(_ notification: Notification) {
        applyStatusIcon()
        item.button?.title = ""
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

    private func loadStatusImage(named name: String) -> NSImage? {
        guard let url = Bundle.main.url(forResource: name, withExtension: "svg"),
              let image = NSImage(contentsOf: url) else { return nil }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = false
        return image
    }

    private func applyStatusIcon() {
        let appearance = item.button?.effectiveAppearance ?? NSApp.effectiveAppearance
        let match = appearance.bestMatch(from: [.darkAqua, .aqua])
        item.button?.image = match == .darkAqua ? darkStatusImage : lightStatusImage
        item.button?.imageScaling = .scaleProportionallyDown
        item.button?.imagePosition = .imageLeft
    }

    private func poll() {
        DispatchQueue.main.async { self.applyStatusIcon() }
        let defaults = UserDefaults.standard
        let previous = defaults.string(forKey: "notificationCursor")
        var components = URLComponents(url: directBase.appendingPathComponent("api/local-snapshot"), resolvingAgainstBaseURL: false)!
        if let previous { components.queryItems = [URLQueryItem(name: "after", value: previous)] }
        URLSession.shared.dataTask(with: components.url!) { [weak self] data, response, error in
            guard let self else { return }
            guard let data, error == nil, (response as? HTTPURLResponse)?.statusCode == 200,
                  let snapshot = try? JSONDecoder().decode(LocalSnapshot.self, from: data) else {
                DispatchQueue.main.async {
                    self.health.title = "● App service unavailable"
                    self.counts.title = "Counts unavailable"
                    self.applyStatusIcon()
                    self.item.button?.title = "!"
                }
                return
            }
            DispatchQueue.main.async {
                let review = snapshot.counts.needsReview ?? snapshot.counts.needsYou
                let revision = snapshot.projectionRevision.map { String($0.prefix(8)) } ?? "unknown"
                if let snapshotError = snapshot.snapshotError, !snapshotError.isEmpty {
                    self.health.title = "● Stale projection \(revision) · \(snapshotError)"
                    self.counts.title = "Stale · review \(review) · ready \(snapshot.counts.queued) · executing \(snapshot.counts.active) · completed \(snapshot.counts.completed) · blocked \(snapshot.counts.blocked)"
                    self.item.button?.title = "!"
                } else {
                    self.health.title = "● Authoritative projection \(revision)"
                    self.counts.title = "Review \(review) · Ready \(snapshot.counts.queued) · Executing \(snapshot.counts.active) · Completed \(snapshot.counts.completed) · Blocked \(snapshot.counts.blocked)"
                    self.item.button?.title = review > 0 || snapshot.counts.blocked > 0 ? "•" : ""
                }
                self.applyStatusIcon()
            }
            self.deliverNotifications(snapshot)
        }.resume()
    }

    private func deliverNotifications(_ page: LocalSnapshot) {
        let defaults = UserDefaults.standard
        let initialized = defaults.bool(forKey: "notificationsInitialized")
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
    }

    private func launchctl(_ arguments: [String]) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/launchctl")
        process.arguments = arguments
        try? process.run()
    }

    @objc private func openRoundhouse() { NSWorkspace.shared.open(dashboard) }
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
