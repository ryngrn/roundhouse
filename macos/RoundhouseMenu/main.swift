import AppKit
import SwiftUI

private let dashboard = URL(string: "https://roundhouse.ryan.green/projects")!
private let health = URL(string: "http://127.0.0.1:8787/health")!

@MainActor final class Presence: ObservableObject {
    @Published var online = false
    @Published var lastChecked = Date()
    func refresh() {
        var request = URLRequest(url: health)
        request.timeoutInterval = 3
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            let available = (response as? HTTPURLResponse)?.statusCode == 200 && data != nil
            DispatchQueue.main.async {
                self?.online = available
                self?.lastChecked = Date()
            }
        }.resume()
    }
}

struct PresenceView: View {
    @ObservedObject var presence: Presence
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Image(systemName: presence.online ? "checkmark.circle.fill" : "exclamationmark.circle")
                    .foregroundColor(presence.online ? .green : .secondary)
                VStack(alignment: .leading, spacing: 3) {
                    Text("This Mac").font(.headline)
                    Text(presence.online ? "Roundhouse service reachable" : "Roundhouse service unavailable")
                        .font(.caption).foregroundColor(.secondary)
                }
            }
            Text("Agent capacity and availability will be reported by the new presence service. This indicator checks local connectivity only.")
                .font(.caption).foregroundColor(.secondary)
            Divider()
            HStack {
                Button("Open Roundhouse") { NSWorkspace.shared.open(dashboard) }
                Spacer()
                Button("Refresh") { presence.refresh() }
                Button("Quit") { NSApp.terminate(nil) }
            }
        }
        .padding(18)
        .frame(width: 340)
    }
}

@MainActor final class AppDelegate: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private var popover = NSPopover()
    private let presence = Presence()
    private var timer: Timer?
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        statusItem.button?.image = NSImage(systemSymbolName: "desktopcomputer", accessibilityDescription: "Roundhouse machine presence")
        statusItem.button?.target = self
        statusItem.button?.action = #selector(toggle)
        popover.behavior = .transient
        popover.contentSize = NSSize(width: 340, height: 165)
        popover.contentViewController = NSHostingController(rootView: PresenceView(presence: presence))
        presence.refresh()
        timer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.presence.refresh() }
        }
    }
    @objc private func toggle() {
        guard let button=statusItem.button else { return }
        if popover.isShown { popover.performClose(nil) }
        else { presence.refresh(); popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY) }
    }
}

@main struct RoundhouseMenu {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
