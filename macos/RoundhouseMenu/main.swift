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

struct Notice: Decodable {
    let id: String
    let kind: String
    let title: String
    let message: String
}
enum StatusIdentifier: Decodable, CustomStringConvertible {
    case string(String)
    case integer(Int)

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if let string = try? value.decode(String.self) { self = .string(string); return }
        self = .integer(try value.decode(Int.self))
    }

    var description: String {
        switch self {
        case .string(let value): return value
        case .integer(let value): return String(value)
        }
    }
}
struct ActiveJob: Decodable {
    let project: String
    let title: String
    let displayState: String
    let runtime: String
    let machine: String?
    let agent: String?
    let workspaceMode: String?
    let workingDirectory: String?
    let remoteRunID: StatusIdentifier?
    let owningNode: String?
    enum CodingKeys: String, CodingKey {
        case project, title, runtime, machine, agent
        case displayState = "display_state"
        case workspaceMode = "workspace_mode"
        case workingDirectory = "working_directory"
        case remoteRunID = "remote_run_id"
        case owningNode = "owning_node"
    }
}
struct LocalSnapshot: Decodable {
    let counts: Counts
    let activeJobs: [ActiveJob]
    let notifications: [Notice]
    let cursor: String?
    enum CodingKeys: String, CodingKey {
        case counts, notifications, cursor
        case activeJobs = "active_jobs"
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        counts = try values.decode(Counts.self, forKey: .counts)
        activeJobs = try values.decodeIfPresent([ActiveJob].self, forKey: .activeJobs) ?? []
        notifications = try values.decode([Notice].self, forKey: .notifications)
        cursor = try values.decodeIfPresent(String.self, forKey: .cursor)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
    private let health = NSMenuItem(title: "Roundhouse is starting…", action: nil, keyEquivalent: "")
    private let counts = NSMenuItem(title: "Needs a signal 0 · Chugging along 0", action: nil, keyEquivalent: "")
    private let activeJobsItem = NSMenuItem(title: "Chugging along… — 0 jobs", action: nil, keyEquivalent: "")
    private var timer: Timer?
    private let base = URL(string: "http://roundhouse")!
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
        menu.addItem(activeJobsItem)
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
            URLSession.shared.dataTask(with: self.base.appendingPathComponent("health")) { _, frontResponse, frontError in
                let frontHealthy = frontError == nil && (frontResponse as? HTTPURLResponse)?.statusCode == 200
                DispatchQueue.main.async {
                    self.health.title = frontHealthy ? "● App and front door healthy" : "● Front door unavailable · app healthy"
                    self.counts.title = "Needs a signal \(snapshot.counts.needsYou) · Chugging along \(snapshot.counts.active) · Held up \(snapshot.counts.blocked)"
                    self.updateActiveJobs(snapshot.activeJobs)
                    self.applyStatusIcon()
                    self.item.button?.title = !frontHealthy ? "!" : snapshot.counts.needsYou > 0 || snapshot.counts.blocked > 0 ? "•" : ""
                }
            }.resume()
            self.deliverNotifications(snapshot)
        }.resume()
    }

    private func updateActiveJobs(_ jobs: [ActiveJob]) {
        activeJobsItem.title = "Chugging along… — \(jobs.count) \(jobs.count == 1 ? "job" : "jobs")"
        let submenu = NSMenu()
        if jobs.isEmpty {
            let empty = NSMenuItem(title: "No jobs are chugging right now", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            submenu.addItem(empty)
        }
        for job in jobs {
            let jobItem = NSMenuItem(title: "\(job.project) — \(job.displayState)", action: nil, keyEquivalent: "")
            let details = NSMenu()
            addDetail(job.title, to: details)
            if job.runtime == "herdr" && job.workspaceMode == "machine_local" {
                addDetail("Machine-local execution on \(job.machine ?? "configured machine")", to: details)
            } else if job.runtime == "herdr" {
                addDetail("Remote execution on \(job.machine ?? "configured machine")", to: details)
            } else {
                addDetail(job.owningNode.map { "Local execution on \($0)" } ?? "Local execution", to: details)
            }
            if let agent = job.agent { addDetail("Agent: \(agent)", to: details) }
            if let directory = job.workingDirectory { addDetail("Directory: \(directory)", to: details) }
            if let run = job.remoteRunID { addDetail("Remote run: \(run)", to: details) }
            jobItem.submenu = details
            submenu.addItem(jobItem)
        }
        activeJobsItem.submenu = submenu
    }

    private func addDetail(_ title: String, to menu: NSMenu) {
        let detail = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        detail.isEnabled = false
        menu.addItem(detail)
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
