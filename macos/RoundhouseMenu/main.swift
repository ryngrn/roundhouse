import AppKit
import SwiftUI

struct QueueItem: Decodable, Identifiable {
    let id: String
    let title: String?
    let state: String?
    let project: String?
    let needs_you: Bool?
    let display_state: String?
}
struct QueueCounts: Decodable {
    let needs_you: Int
    let active: Int
    let queued: Int
    let completed: Int
    let blocked: Int
}
struct QueueSnapshot: Decodable {
    let items: [QueueItem]
    let counts: QueueCounts
    let captured_at: String?
}
@MainActor final class DashboardModel: ObservableObject {
    @Published var snapshot: QueueSnapshot?
    @Published var error: String?
    @Published var updated = Date()
    private let endpoint = URL(string: "http://127.0.0.1:8787/api/local-snapshot")!
    func refresh() {
        URLSession.shared.dataTask(with: endpoint) { data, response, error in
            let snap = data.flatMap { try? JSONDecoder().decode(QueueSnapshot.self, from: $0) }
            DispatchQueue.main.async {
                if let snap, (response as? HTTPURLResponse)?.statusCode == 200 {
                    self.snapshot = snap
                    self.error = nil
                    self.updated = Date()
                } else {
                    self.error = "Local service unreachable"
                }
            }
        }.resume()
    }
    var attention: [QueueItem] {
        (snapshot?.items ?? []).filter { $0.needs_you == true || $0.state == "Blocked" }.sorted { ($0.needs_you == true ? 0 : 1) < ($1.needs_you == true ? 0 : 1) }
    }
}
struct StatTile: View {
    let count: Int
    let label: String
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(count)").font(.system(size: 25, weight: .semibold, design: .rounded))
            Text(label).font(.system(size: 11)).foregroundStyle(.secondary)
        }.frame(maxWidth: .infinity, alignment: .leading).padding(12)
            .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 12))
    }
}
struct DashboardView: View {
    @ObservedObject var model: DashboardModel
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack {
                Image(systemName: "tram.fill").font(.system(size: 20))
                VStack(alignment: .leading, spacing: 2) {
                    Text("Roundhouse").font(.system(size: 19, weight: .bold))
                    Text("Mac Studio · Hub").font(.caption).foregroundStyle(.secondary)
                }
                Spacer()
                Circle().fill(model.error == nil && model.snapshot != nil ? .green : .orange).frame(width: 8, height: 8)
                Text(model.error ?? "Connected").font(.caption).foregroundStyle(.secondary)
            }
            if let snapshot = model.snapshot {
                HStack(spacing: 8) {
                    StatTile(count: snapshot.counts.needs_you, label: "Needs you")
                    StatTile(count: snapshot.counts.active, label: "Running")
                    StatTile(count: snapshot.counts.queued, label: "Ready")
                }
                HStack {
                    Text("Needs attention").font(.headline)
                    Spacer()
                    Text("\(snapshot.counts.blocked) held up").font(.caption).foregroundStyle(.secondary)
                }
                if model.attention.isEmpty {
                    Text("Nothing needs attention right now.").foregroundStyle(.secondary).padding(.vertical, 12)
                } else {
                    ScrollView {
                        LazyVStack(spacing: 2) {
                            ForEach(Array(model.attention.prefix(8))) { item in
                                Button {
                                    NSWorkspace.shared.open(URL(string: "https://roundhouse.ryan.green/")!)
                                } label: {
                                    HStack(spacing: 10) {
                                        Image(systemName: item.needs_you == true ? "exclamationmark.circle.fill" : "pause.circle")
                                            .foregroundStyle(item.needs_you == true ? .orange : .secondary)
                                        VStack(alignment: .leading, spacing: 3) {
                                            Text(item.title ?? "Untitled").font(.system(size: 12, weight: .medium)).lineLimit(2)
                                            Text("\(item.project ?? "Unassigned") · \(item.display_state ?? item.state ?? "Unknown")")
                                                .font(.system(size: 10)).foregroundStyle(.secondary)
                                        }
                                        Spacer()
                                        Image(systemName: "chevron.right").foregroundStyle(.tertiary)
                                    }.padding(.vertical, 8).contentShape(Rectangle())
                                }.buttonStyle(.plain)
                                Divider()
                            }
                        }
                    }.frame(maxHeight: 245)
                }
                HStack {
                    Image(systemName: "checkmark.shield").foregroundStyle(.secondary)
                    Text("Completed \(snapshot.counts.completed)").font(.caption)
                    Spacer()
                    Text("Updated \(model.updated.formatted(date: .omitted, time: .shortened))").font(.caption2).foregroundStyle(.secondary)
                }
            } else {
                ProgressView("Connecting to local engine…").padding(.vertical, 32)
            }
            Divider()
            HStack(spacing: 8) {
                Button {
                    NSWorkspace.shared.open(URL(string: "https://roundhouse.ryan.green/")!)
                } label: {
                    Label("Open dashboard", systemImage: "rectangle.on.rectangle")
                }
                Spacer()
                Button { model.refresh() } label: { Image(systemName: "arrow.clockwise") }.help("Refresh now")
                Button { NSApp.terminate(nil) } label: { Image(systemName: "power") }.help("Quit Roundhouse Menu")
            }
        }
        .padding(18).frame(width: 420)
    }
}
@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
    let popover = NSPopover()
    let model = DashboardModel()
    var timer: Timer?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        if let button = item.button {
            button.image = NSImage(systemSymbolName: "tram.fill", accessibilityDescription: "Roundhouse")
            button.action = #selector(toggle)
            button.target = self
            button.toolTip = "Roundhouse Control Center"
        }
        popover.contentViewController = NSHostingController(rootView: DashboardView(model: model))
        popover.behavior = .transient
        model.refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in Task { @MainActor in self?.model.refresh() } }
    }
    @objc func toggle() {
        guard let button = item.button else { return }
        if popover.isShown { popover.performClose(nil) }
        else { model.refresh(); popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
    }
}
@main struct RoundhouseMenuApp {
    @MainActor static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
