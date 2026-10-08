import AppKit
import SwiftUI
import UserNotifications

private let dashboardURL = URL(string: "https://roundhouse.ryan.green/")!
private let snapshotURL = URL(string: "http://127.0.0.1:8787/api/local-snapshot")!

struct QueueCounts: Decodable {
    let needsYou: Int
    let needsReview: Int?
    let active: Int
    let queued: Int
    let completed: Int
    let blocked: Int
    enum CodingKeys: String, CodingKey {
        case needsYou = "needs_you"
        case needsReview = "needs_review"
        case active, queued, completed, blocked
    }
    var review: Int { needsReview ?? needsYou }
}

struct QueueItem: Decodable, Identifiable {
    let id: String
    let title: String?
    let state: String?
    let project: String?
    let needsYou: Bool?
    let reviewRequired: Bool?
    let reviewReason: String?
    let displayState: String?
    let reason: String?
    let agentRole: String?
    let owningNode: String?
    let updatedAt: String?
    enum CodingKeys: String, CodingKey {
        case id, title, state, project, reason
        case needsYou = "needs_you"
        case reviewRequired = "review_required"
        case reviewReason = "review_reason"
        case displayState = "display_state"
        case agentRole = "agent_role"
        case owningNode = "owning_node"
        case updatedAt = "updated_at"
    }
    var needsAttention: Bool { needsYou == true || reviewRequired == true || state == "Blocked" }
    var status: String { displayState ?? state ?? "Unknown" }
}

struct Notice: Decodable {
    let id: String
    let kind: String
    let title: String
    let message: String
}

struct QueueSnapshot: Decodable {
    let items: [QueueItem]
    let counts: QueueCounts
    let notifications: [Notice]
    let cursor: String?
    let capturedAt: String?
    let projectionRevision: String?
    let snapshotError: String?
    enum CodingKeys: String, CodingKey {
        case items, counts, notifications, cursor
        case capturedAt = "captured_at"
        case projectionRevision = "projection_revision"
        case snapshotError = "snapshot_error"
    }
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        items = try values.decodeIfPresent([QueueItem].self, forKey: .items) ?? []
        counts = try values.decode(QueueCounts.self, forKey: .counts)
        notifications = try values.decodeIfPresent([Notice].self, forKey: .notifications) ?? []
        cursor = try values.decodeIfPresent(String.self, forKey: .cursor)
        capturedAt = try values.decodeIfPresent(String.self, forKey: .capturedAt)
        projectionRevision = try values.decodeIfPresent(String.self, forKey: .projectionRevision)
        snapshotError = try values.decodeIfPresent(String.self, forKey: .snapshotError)
    }
}

@MainActor final class DashboardModel: ObservableObject {
    @Published var snapshot: QueueSnapshot?
    @Published var error: String?
    @Published var isRefreshing = false
    @Published var updated = Date()

    func refresh() {
        guard !isRefreshing else { return }
        isRefreshing = true
        var components = URLComponents(url: snapshotURL, resolvingAgainstBaseURL: false)!
        if let cursor = UserDefaults.standard.string(forKey: "notificationCursor") {
            components.queryItems = [URLQueryItem(name: "after", value: cursor)]
        }
        URLSession.shared.dataTask(with: components.url!) { [weak self] data, response, requestError in
            let status = (response as? HTTPURLResponse)?.statusCode
            let decoded = data.flatMap { try? JSONDecoder().decode(QueueSnapshot.self, from: $0) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.isRefreshing = false
                guard let decoded, status == 200 else {
                    self.error = requestError == nil ? "Local service returned an unreadable response" : "Local service is unavailable"
                    return
                }
                self.snapshot = decoded
                self.error = decoded.snapshotError
                self.updated = Date()
                self.deliverNotifications(decoded)
            }
        }.resume()
    }

    var visibleItems: [QueueItem] {
        (snapshot?.items ?? []).sorted {
            let left = rank($0), right = rank($1)
            return left == right ? ($0.updatedAt ?? "") > ($1.updatedAt ?? "") : left < right
        }
    }

    private func rank(_ item: QueueItem) -> Int {
        if item.needsAttention { return 0 }
        if ["Decision", "Executing", "Verification", "Rework"].contains(item.state ?? "") { return 1 }
        if ["Depot", "Ready", "Imported Pending"].contains(item.state ?? "") { return 2 }
        return 3
    }

    private func deliverNotifications(_ page: QueueSnapshot) {
        let defaults = UserDefaults.standard
        if defaults.bool(forKey: "notificationsInitialized") {
            for notice in page.notifications where ["needs_you", "failure", "completion"].contains(notice.kind) {
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
}

private enum Palette {
    static let canvas = Color(red: 0.035, green: 0.035, blue: 0.040)
    static let surface = Color(red: 0.055, green: 0.055, blue: 0.064)
    static let raised = Color(red: 0.073, green: 0.073, blue: 0.084)
    static let border = Color.white.opacity(0.075)
    static let text = Color.white.opacity(0.92)
    static let muted = Color.white.opacity(0.48)
    static let accent = Color(red: 0.42, green: 0.52, blue: 0.98)
    static let moving = Color(red: 0.42, green: 0.64, blue: 0.94)
    static let signal = Color(red: 0.78, green: 0.65, blue: 0.39)
    static let held = Color(red: 0.82, green: 0.39, blue: 0.40)
    static let reached = Color(red: 0.39, green: 0.68, blue: 0.53)
}

struct MetricTile: View {
    let value: Int
    let label: String
    let color: Color
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(value)").font(.system(size: 19, weight: .semibold, design: .rounded)).foregroundStyle(Palette.text).monospacedDigit()
            HStack(spacing: 4) {
                Circle().fill(color.opacity(0.85)).frame(width: 4, height: 4)
                Text(label).font(.system(size: 8.5, weight: .medium)).foregroundStyle(Palette.muted).lineLimit(1)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 9).padding(.vertical, 9)
    }
}

struct WorkRow: View {
    let item: QueueItem
    private var color: Color {
        if item.needsAttention { return item.state == "Blocked" ? Palette.held : Palette.signal }
        if ["Decision", "Executing", "Verification", "Rework"].contains(item.state ?? "") { return Palette.moving }
        if ["Shipped", "Archived", "Reconciled", "Imported History"].contains(item.state ?? "") { return Palette.reached }
        return Palette.accent
    }
    var body: some View {
        Button { NSWorkspace.shared.open(dashboardURL) } label: {
            HStack(spacing: 10) {
                Circle().fill(color.opacity(0.9)).frame(width: 6, height: 6)
                VStack(alignment: .leading, spacing: 4) {
                    Text(item.title ?? "Untitled work").font(.system(size: 11.5, weight: .medium)).foregroundStyle(Palette.text).lineLimit(1)
                    HStack(spacing: 5) {
                        Text(item.project ?? "Unassigned"); Text("·"); Text(item.status)
                        if let role = item.agentRole, !role.isEmpty { Text("·"); Text(role) }
                    }.font(.system(size: 9, weight: .regular)).foregroundStyle(Palette.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Palette.muted.opacity(0.5))
            }.padding(.horizontal, 12).padding(.vertical, 7).contentShape(Rectangle())
        }.buttonStyle(.plain)
    }
}

struct DashboardView: View {
    @ObservedObject var model: DashboardModel
    let serviceAction: (String) -> Void
    let quit: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Palette.border)
            if let snapshot = model.snapshot {
                ScrollView {
                    VStack(alignment: .leading, spacing: 13) { metrics(snapshot.counts); work(snapshot) }.padding(12)
                }
            } else {
                VStack(spacing: 13) {
                    ProgressView().controlSize(.small).tint(Palette.accent)
                    Text("Connecting to the local engine…").foregroundStyle(Palette.muted)
                }.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            footer
        }.frame(width: 390, height: 530).background(Palette.canvas).preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "train.side.front.car").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text)
            VStack(alignment: .leading, spacing: 2) {
                Text("Roundhouse").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
                Text("Mac Studio · Local").font(.system(size: 9, weight: .regular)).foregroundStyle(Palette.muted)
            }
            Spacer()
            HStack(spacing: 6) {
                Circle().fill(model.error == nil && model.snapshot != nil ? Palette.reached : Palette.held).frame(width: 7, height: 7)
                Text(model.error == nil && model.snapshot != nil ? "Connected" : "Offline").font(.system(size: 9, weight: .medium)).foregroundStyle(Palette.muted)
            }
        }.padding(.horizontal, 14).padding(.vertical, 11).background(Palette.surface)
    }

    private func metrics(_ counts: QueueCounts) -> some View {
        VStack(alignment: .leading, spacing: 7) {
            Text("Overview").font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.muted)
            HStack(spacing: 0) {
                MetricTile(value: counts.review, label: "Review", color: Palette.signal)
                Divider().overlay(Palette.border)
                MetricTile(value: counts.active, label: "Active", color: Palette.moving)
                Divider().overlay(Palette.border)
                MetricTile(value: counts.queued, label: "Ready", color: Palette.accent)
                Divider().overlay(Palette.border)
                MetricTile(value: counts.completed, label: "Done", color: Palette.reached)
                Divider().overlay(Palette.border)
                MetricTile(value: counts.blocked, label: "Held", color: Palette.held)
            }
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 8))
            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Palette.border))
        }
    }

    private func work(_ snapshot: QueueSnapshot) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text("Priority work").font(.system(size: 12, weight: .semibold)).foregroundStyle(Palette.text)
                Spacer(); Text("\(snapshot.items.count) total").font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
            VStack(spacing: 0) {
                if model.visibleItems.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "checkmark.seal.fill").font(.title2).foregroundStyle(Palette.reached)
                        Text("The tracks are clear").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
                        Text("Nothing needs attention right now.").font(.system(size: 10)).foregroundStyle(Palette.muted)
                    }.frame(maxWidth: .infinity).padding(.vertical, 28)
                } else {
                    ForEach(Array(model.visibleItems.prefix(9).enumerated()), id: \.element.id) { index, item in
                        if index > 0 { Divider().overlay(Palette.border) }
                        WorkRow(item: item)
                    }
                }
            }.background(Palette.surface, in: RoundedRectangle(cornerRadius: 10)).overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.border))
            if let error = model.error {
                Label(error, systemImage: "exclamationmark.triangle.fill").font(.system(size: 10, weight: .medium)).foregroundStyle(Palette.held)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 9) {
            Button { NSWorkspace.shared.open(dashboardURL) } label: { Label("Open dashboard", systemImage: "rectangle.on.rectangle") }
                .buttonStyle(.bordered).tint(Palette.text)
            Spacer()
            Text("Updated \(model.updated.formatted(date: .omitted, time: .shortened))").font(.system(size: 9)).foregroundStyle(Palette.muted)
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless).foregroundStyle(Palette.text).help("Refresh now")
            Menu {
                Button("Start local service") { serviceAction("start") }
                Button("Stop local service") { serviceAction("stop") }
                Button("Restart local service") { serviceAction("restart") }
                Divider(); Button("Quit Roundhouse Menu") { quit() }
            } label: { Image(systemName: "ellipsis.circle") }
            .menuStyle(.borderlessButton).frame(width: 20).foregroundStyle(Palette.text)
        }.padding(.horizontal, 14).padding(.vertical, 9).background(Palette.surface).overlay(alignment: .top) { Divider().overlay(Palette.border) }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let popover = NSPopover()
    private let model = DashboardModel()
    private var timer: Timer?
    private var serviceDomain: String { "gui/\(getuid())" }
    private var serviceLabel: String { "\(serviceDomain)/io.roundhouse.service" }
    private var servicePlist: String { FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/LaunchAgents/io.roundhouse.service.plist").path }

    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if let button = statusItem.button {
            button.image = statusImage() ?? NSImage(systemSymbolName: "tram.fill", accessibilityDescription: "Roundhouse")
            button.imagePosition = .imageOnly
            button.imageScaling = .scaleProportionallyDown
            button.title = ""
            button.action = #selector(togglePopover); button.target = self; button.toolTip = "Roundhouse Control Room"
        }
        popover.behavior = .transient
        popover.animates = true
        popover.contentSize = NSSize(width: 390, height: 530)
        popover.contentViewController = NSHostingController(rootView: DashboardView(
            model: model,
            serviceAction: { [weak self] action in self?.controlService(action) },
            quit: { NSApp.terminate(nil) }
        ))
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        model.refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 15, repeats: true) { [weak self] _ in Task { @MainActor in self?.model.refresh() } }
    }

    private func statusImage() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "status-light", withExtension: "svg"),
              let image = NSImage(contentsOf: url) else { return nil }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        return image
    }

    @objc private func togglePopover() {
        guard let button = statusItem.button else { return }
        if popover.isShown { popover.performClose(nil) }
        else {
            model.refresh(); popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func controlService(_ action: String) {
        switch action {
        case "start": launchctl(["bootstrap", serviceDomain, servicePlist])
        case "stop": launchctl(["bootout", serviceLabel])
        case "restart":
            launchctl(["bootout", serviceLabel])
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in
                guard let self else { return }
                self.launchctl(["bootstrap", self.serviceDomain, self.servicePlist])
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.model.refresh() }
            }
        default: break
        }
    }
    private func launchctl(_ arguments: [String]) {
        let process = Process(); process.executableURL = URL(fileURLWithPath: "/bin/launchctl"); process.arguments = arguments; try? process.run()
    }
}

@main struct RoundhouseMenuApp {
    @MainActor static func main() {
        let app = NSApplication.shared; let delegate = AppDelegate(); app.delegate = delegate; app.run()
    }
}
