import AppKit
import SwiftUI
import UserNotifications

private let dashboardURL = URL(string: "https://roundhouse.ryan.green/")!
private let snapshotURL = URL(string: "http://127.0.0.1:8787/api/local-snapshot")!
private let projectsURL = URL(string: "https://roundhouse.ryan.green/projects")!
private let cloudProjectsURL = URL(string: "https://roundhouse.ryan.green/api/menu-projects")!
private let menuSupport = FileManager.default.homeDirectoryForCurrentUser
    .appendingPathComponent("Library/Application Support/Roundhouse", isDirectory: true)

struct MenuConfiguration: Decodable {
    let role: String
    let apiToken: String?
    enum CodingKeys: String, CodingKey {
        case role
        case apiToken = "api_token"
    }
    var isController: Bool { role == "controller" }
    static func load() -> MenuConfiguration {
        let url = menuSupport.appendingPathComponent("menu-config.json")
        return (try? Data(contentsOf: url)).flatMap { try? JSONDecoder().decode(Self.self, from: $0) }
            ?? MenuConfiguration(role: "launcher", apiToken: nil)
    }
}

struct CloudProject: Identifiable, Codable, Hashable {
    let id: String
    let name: String
    let icon: String?
    // Optional cloud-supplied counts; nil means unavailable, never zero.
    let needs_input: Int?
    let running: Int?
    let queued: Int?
    let metrics_stale: Bool?
    var symbol: String {
        if let icon, !icon.isEmpty { return icon }
        let defaults: [String:String] = [
            "roundhouse":"🚂", "roundhouse-dashboard":"📊", "inclusion":"✨",
            "growthpath":"🌱", "imarchy":"🖥️", "kmac":"💻",
            "portfolio":"🎨", "ipad-monitor":"📱"
        ]
        return defaults[id] ?? "📁"
    }
    var page: URL? {
        guard id.range(of:"^[a-z0-9]+(?:-[a-z0-9]+)*$",options:.regularExpression) != nil else { return nil }
        return URL(string:"https://roundhouse.ryan.green/projects/" + id)
    }
}

struct CloudProjectDirectory: Codable {
    let projects: [CloudProject]
    let updated_at: String?
    let stale: Bool?
}


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
    var needsAttention: Bool { needsYou == true || reviewRequired == true }
    var humanReview: Bool { needsYou == true || reviewRequired == true }
    var running: Bool { ["Active", "Running", "In Progress", "Dispatched", "Executing"].contains(state ?? "") }
    var waiting: Bool { ["Queued", "Ready", "Pending", "Ready to Depart"].contains(state ?? "") && !humanReview }
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
    let projects: [String:CloudProject]
    enum CodingKeys: String, CodingKey {
        case items, counts, notifications, cursor
        case capturedAt = "captured_at"
        case projectionRevision = "projection_revision"
        case snapshotError = "snapshot_error"
        case projects
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
        projects = try values.decodeIfPresent([String:CloudProject].self, forKey: .projects) ?? [:]
    }
}

@MainActor final class DashboardModel: ObservableObject {
    @Published var snapshot: QueueSnapshot?
    @Published var error: String?
    @Published var isRefreshing = false
    @Published var updated = Date()
    @Published var projects: [CloudProject] = []
    @Published var cloudConnected = false
    @Published var cloudError: String?
    let configuration = MenuConfiguration.load()
    private var projectRefreshing = false

    init() {
        let cacheURL = menuSupport.appendingPathComponent("menu-projects-cache.json")
        if let data = try? Data(contentsOf: cacheURL),
           let value = try? JSONDecoder().decode(CloudProjectDirectory.self, from: data) {
            projects = value.projects
        }
    }

    private func cacheProjects() {
        try? FileManager.default.createDirectory(at: menuSupport, withIntermediateDirectories: true)
        let cache = CloudProjectDirectory(projects: projects, updated_at: nil, stale: true)
        if let encoded = try? JSONEncoder().encode(cache) {
            try? encoded.write(to: menuSupport.appendingPathComponent("menu-projects-cache.json"), options: .atomic)
        }
    }

    func refreshProjects() {
        guard !projectRefreshing else { return }
        guard let token = configuration.apiToken, token.count >= 48 else {
            cloudError = configuration.isController ? "Using Studio project directory" : "Using saved project directory"
            return
        }
        projectRefreshing = true
        var request = URLRequest(url: cloudProjectsURL)
        request.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        request.timeoutInterval = 12
        URLSession.shared.dataTask(with: request) { [weak self] data, response, requestError in
            let status = (response as? HTTPURLResponse)?.statusCode
            let decoded = data.flatMap { try? JSONDecoder().decode(CloudProjectDirectory.self, from: $0) }
            DispatchQueue.main.async {
                guard let self else { return }
                self.projectRefreshing = false
                guard status == 200, let decoded else {
                    self.cloudConnected = false
                    self.cloudError = requestError == nil ? "Cloud directory unavailable; showing saved projects" : "Network offline; showing saved projects"
                    return
                }
                self.projects = decoded.projects
                self.cloudConnected = true
                self.cloudError = decoded.stale == true ? "Studio data delayed · directory may be stale" : nil
                self.updated = Date()
                try? FileManager.default.createDirectory(at: menuSupport, withIntermediateDirectories: true)
                if let encoded = try? JSONEncoder().encode(decoded) {
                    try? encoded.write(to: menuSupport.appendingPathComponent("menu-projects-cache.json"), options: .atomic)
                }
            }
        }.resume()
    }

    func refresh() {
        refreshProjects()
        guard configuration.isController else { return }
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
                if !decoded.projects.isEmpty && !self.cloudConnected {
                    self.projects = decoded.projects.values
                        .filter { $0.page != nil }
                        .sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
                    self.cacheProjects()
                }
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

private struct WindowDragSurface: NSViewRepresentable {
    final class DragView: NSView {
        override func mouseDown(with event: NSEvent) {
            window?.performDrag(with: event)
        }
        override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
        override var mouseDownCanMoveWindow: Bool { true }
    }
    func makeNSView(context: Context) -> DragView { DragView(frame: .zero) }
    func updateNSView(_ nsView: DragView, context: Context) {}
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

struct ProjectRow: View {
    let project: CloudProject
    let localItems: [QueueItem]?
    let activeUnattributed: Bool
    let stale: Bool

    private var review: Int? { localItems.map { $0.filter(\.humanReview).count } ?? project.needs_input }
    private var running: Int? {
        if let localItems {
            let count = localItems.filter(\.running).count
            return count == 0 && activeUnattributed ? nil : count
        }
        return project.running
    }
    private var queued: Int? { localItems.map { $0.filter(\.waiting).count } ?? project.queued }

    private func reviewInChat() {
        var prompt = "Help me review and unblock Roundhouse project \(project.name) (project ID: \(project.id)). Retrieve current unresolved human-review items from Roundhouse before proposing actions. Walk through them one at a time, identify the minimum decision needed, and only submit decisions through the existing guarded Roundhouse workflow with my approval. Never replay failed jobs automatically."
        if let items = localItems {
            let ids = items.filter(\.humanReview).prefix(20).map(\.id)
            if !ids.isEmpty { prompt += " Current locally observed review item IDs: " + ids.joined(separator: ", ") + ". Revalidate these identifiers against live state." }
        }
        var parts = URLComponents(string: "https://chatgpt.com/")!
        parts.queryItems = [URLQueryItem(name: "q", value: prompt)]
        if let url = parts.url { NSWorkspace.shared.open(url) }
    }

    var body: some View {
        HStack(spacing: 10) {
            Button {
                if let url = project.page { NSWorkspace.shared.open(url) }
            } label: {
                HStack(spacing: 10) {
                    Text(project.symbol).font(.system(size: 22)).frame(width: 28)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(project.name).font(.system(size: 12,weight:.medium))
                            .foregroundStyle(Palette.text).lineLimit(1)
                        HStack(spacing: 9) {
                            if let review {
                                Text("\(review) input").foregroundStyle(review > 0 ? Palette.signal : Palette.muted)
                            } else { Text("Input —").foregroundStyle(Palette.muted) }
                            Text("Run \(running.map(String.init) ?? "—")").foregroundStyle(Palette.muted)
                            Text("Queue \(queued.map(String.init) ?? "—")").foregroundStyle(Palette.muted)
                            if stale { Text("Stale").foregroundStyle(Palette.held) }
                        }.font(.system(size: 9))
                    }
                    Spacer(minLength: 1)
                }.contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(project.page == nil)
            .help("Open " + project.name + " in Roundhouse")
            if let review, review > 0 {
                Button(action: reviewInChat) {
                    Text("Review").font(.system(size: 10, weight: .semibold))
                }
                .buttonStyle(.bordered)
                .help("Review live blockers in ChatGPT")
            } else {
                Image(systemName: "arrow.up.right").font(.system(size: 9)).foregroundStyle(Palette.muted)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }
}

struct DashboardView: View {
    @ObservedObject var model: DashboardModel
    let isPinned: Bool
    let pin: () -> Void
    let close: () -> Void
    let serviceAction: (String) -> Void
    let quit: () -> Void
    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Palette.border)
            ScrollView {
                VStack(alignment: .leading, spacing: 13) {
                    if model.configuration.isController, let snapshot = model.snapshot { metrics(snapshot.counts) }
                    projectsSection
                }.padding(12)
            }
            footer
        }.frame(width: 390, height: 530).background(Palette.canvas).preferredColorScheme(.dark)
    }

    private var header: some View {
        HStack(spacing: 9) {
            Image(systemName: "train.side.front.car").font(.system(size: 14, weight: .semibold)).foregroundStyle(Palette.text)
            VStack(alignment: .leading, spacing: 2) {
                Text("Roundhouse").font(.system(size: 13, weight: .semibold)).foregroundStyle(Palette.text)
                Text(model.configuration.isController ? "Local hub + Cloud" : "Cloud project launcher").font(.system(size: 9, weight: .regular)).foregroundStyle(Palette.muted)
            }
            Spacer()
            HStack(spacing: 6) {
                Circle().fill(model.cloudConnected ? Palette.reached : Palette.held).frame(width: 7, height: 7)
                Text(model.cloudConnected ? "Cloud" : (model.projects.isEmpty ? "Offline" : "Saved")).font(.system(size: 9, weight: .medium)).foregroundStyle(Palette.muted)
            }
            Button(action: isPinned ? close : pin) {
                Image(systemName: isPinned ? "xmark" : "arrow.up.left.and.arrow.down.right")
                    .font(.system(size: 9, weight: .semibold))
                    .frame(width: 18, height: 18)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(Palette.muted)
            .help(isPinned ? "Close floating control room" : "Keep open as a floating control room")
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(Palette.surface)
        .overlay {
            if isPinned {
                HStack(spacing: 0) {
                    WindowDragSurface()
                        .contentShape(Rectangle())
                        .help("Drag the floating control room")
                    Color.clear.frame(width: 124)
                }
            }
        }
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

    private var projectsSection: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(alignment: .firstTextBaseline) {
                Text("Projects").font(.system(size: 12,weight:.semibold)).foregroundStyle(Palette.text)
                Spacer()
                if let items = model.configuration.isController ? model.snapshot?.items : nil {
                    let count = items.filter(\.humanReview).count
                    if count > 0 {
                        Button("Review \(count)") {
                            var parts = URLComponents(string: "https://chatgpt.com/")!
                            parts.queryItems = [URLQueryItem(name: "q", value: "Review my outstanding Roundhouse human decisions across all projects. Fetch live blockers, discuss each one with me, and submit approved resolutions only through the guarded decision workflow.")]
                            if let url = parts.url { NSWorkspace.shared.open(url) }
                        }
                        .buttonStyle(.bordered).font(.system(size: 10))
                    }
                }
                Text("\(model.projects.count) projects").font(.system(size: 10)).foregroundStyle(Palette.muted)
            }
            VStack(spacing: 0) {
                if model.projects.isEmpty {
                    VStack(spacing: 9) {
                        Image(systemName: "folder").font(.title3).foregroundStyle(Palette.muted)
                        Text("Projects aren't available yet").foregroundStyle(Palette.text)
                        Text("Use Open Projects while the cloud directory reconnects.")
                            .font(.system(size: 10)).foregroundStyle(Palette.muted).multilineTextAlignment(.center)
                    }.frame(maxWidth:.infinity).padding(.vertical, 28)
                } else {
                    ForEach(Array(model.projects.enumerated()), id: \.element.id) { index, project in
                        if index > 0 { Divider().overlay(Palette.border) }
                        ProjectRow(
                            project: project,
                            localItems: model.configuration.isController && model.snapshot?.snapshotError == nil
                                ? model.snapshot?.items.filter { $0.project == project.id }
                                : nil,
                            activeUnattributed: (model.snapshot?.counts.active ?? 0) > 0
                                && !(model.snapshot?.items.contains(where: { $0.running }) ?? false),
                            stale: (!model.cloudConnected && !model.configuration.isController)
                                || (model.configuration.isController && (model.snapshot == nil || model.snapshot?.snapshotError != nil))
                                || project.metrics_stale == true
                        )
                    }
                }
            }
            .background(Palette.surface, in: RoundedRectangle(cornerRadius: 10))
            .overlay(RoundedRectangle(cornerRadius: 10).stroke(Palette.border))
            if let error = model.cloudError {
                Label(error,systemImage:"info.circle").font(.system(size:10)).foregroundStyle(Palette.muted)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 9) {
            Button { NSWorkspace.shared.open(projectsURL) } label: { Label("All projects", systemImage: "folder") }
                .buttonStyle(.bordered).tint(Palette.text)
            Spacer()
            Text("Updated \(model.updated.formatted(date: .omitted, time: .shortened))").font(.system(size: 9)).foregroundStyle(Palette.muted)
            Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }.buttonStyle(.borderless).foregroundStyle(Palette.text).help("Refresh now")
            Menu {
                if model.configuration.isController {
                    Button("Start local service") { serviceAction("start") }
                    Button("Stop local service") { serviceAction("stop") }
                    Button("Restart local service") { serviceAction("restart") }
                    Divider()
                }
                Button("Quit Roundhouse Menu") { quit() }
            } label: { Image(systemName: "ellipsis.circle") }
            .menuStyle(.borderlessButton).frame(width: 20).foregroundStyle(Palette.text)
        }.padding(.horizontal, 14).padding(.vertical, 9).background(Palette.surface).overlay(alignment: .top) { Divider().overlay(Palette.border) }
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate, NSWindowDelegate {
    private let statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    private let popover = NSPopover()
    private let model = DashboardModel()
    private var floatingPanel: NSPanel?
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
        popover.contentViewController = dashboardController(isPinned: false)
        UNUserNotificationCenter.current().delegate = self
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
        model.refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in Task { @MainActor in self?.model.refresh() } }
    }

    private func statusImage() -> NSImage? {
        guard let url = Bundle.main.url(forResource: "status-light", withExtension: "svg"),
              let image = NSImage(contentsOf: url) else { return nil }
        image.size = NSSize(width: 18, height: 18)
        image.isTemplate = true
        return image
    }

    @objc private func togglePopover() {
        if let floatingPanel {
            model.refresh()
            floatingPanel.orderFrontRegardless()
            floatingPanel.makeKey()
            return
        }
        guard let button = statusItem.button else { return }
        if popover.isShown { popover.performClose(nil) }
        else {
            model.refresh(); popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
            popover.contentViewController?.view.window?.makeKey()
        }
    }

    private func dashboardController(isPinned: Bool) -> NSHostingController<DashboardView> {
        NSHostingController(rootView: DashboardView(
            model: model,
            isPinned: isPinned,
            pin: { [weak self] in self?.pinControlRoom() },
            close: { [weak self] in self?.closePinnedControlRoom() },
            serviceAction: { [weak self] action in self?.controlService(action) },
            quit: { NSApp.terminate(nil) }
        ))
    }

    private func pinControlRoom() {
        guard floatingPanel == nil else { return }
        let sourceFrame = popover.contentViewController?.view.window?.frame
        popover.performClose(nil)
        let panel = NSPanel(
            contentRect: NSRect(origin: sourceFrame?.origin ?? .zero, size: NSSize(width: 390, height: 530)),
            styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.delegate = self
        panel.isFloatingPanel = true
        panel.level = .floating
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.isMovableByWindowBackground = true
        panel.backgroundColor = .clear
        panel.isOpaque = false
        panel.setFrameAutosaveName("RoundhouseFloatingControlRoom")
        panel.contentViewController = dashboardController(isPinned: true)
        floatingPanel = panel
        model.refresh()
        panel.orderFrontRegardless()
        panel.makeKey()
    }

    private func closePinnedControlRoom() {
        floatingPanel?.close()
        floatingPanel = nil
    }

    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSPanel === floatingPanel else { return }
        floatingPanel = nil
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
