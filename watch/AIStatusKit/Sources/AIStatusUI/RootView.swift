import AIStatusKit
import SwiftUI

/// The whole app UI. The watch app's `@main` just hosts this view; everything
/// else (scene-phase driven networking, haptics, widget hand-off) lives here so
/// it can be type-checked on macOS.
public struct AIStatusRootView: View {
    @StateObject private var model: StatusModel
    @AppStorage(SettingsKeys.host) private var host = BuildDefaults.host
    @AppStorage(SettingsKeys.port) private var port = DaemonEndpoint.defaultPort
    @AppStorage(SettingsKeys.token) private var token = ""
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false
    @State private var path: [String] = []

    private let sharedStore: SharedSnapshotStore
    private let onWidgetDataChanged: () -> Void

    @MainActor
    public init(
        model: StatusModel? = nil,
        sharedStore: SharedSnapshotStore = .fromMainBundle(),
        onWidgetDataChanged: @escaping () -> Void = {}
    ) {
        _model = StateObject(wrappedValue: model ?? StatusModel())
        self.sharedStore = sharedStore
        self.onWidgetDataChanged = onWidgetDataChanged
    }

    private var leadingPlacement: ToolbarItemPlacement {
        #if os(watchOS)
        .topBarLeading
        #else
        .navigation
        #endif
    }

    private var trailingPlacement: ToolbarItemPlacement {
        #if os(watchOS)
        .topBarTrailing
        #else
        .automatic
        #endif
    }

    private var endpoint: DaemonEndpoint? {
        DaemonEndpoint(host: host, port: port, token: token)
    }

    public var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationDestination(for: String.self) { id in
                    SessionDetailView(model: model, id: id)
                }
                .navigationDestination(isPresented: $showSettings) {
                    SettingsView()
                }
                .toolbar {
                    if endpoint != nil {
                        ToolbarItem(placement: leadingPlacement) {
                            Circle()
                                .fill(model.connection.indicatorColor)
                                .frame(width: 7, height: 7)
                                .accessibilityLabel(model.connection.shortLabel)
                        }
                    }
                    ToolbarItem(placement: trailingPlacement) {
                        Button {
                            showSettings = true
                        } label: {
                            Image(systemName: "gearshape")
                        }
                        .accessibilityLabel("Settings")
                    }
                }
        }
        .onAppear {
            model.onTransition = { Haptics.play(for: $0) }
            let store = sharedStore
            let reload = onWidgetDataChanged
            model.onSummaryChange = { summary in
                store.save(summary)
                reload()
            }
            if scenePhase != .background { model.start(endpoint: endpoint) }
        }
        .onChange(of: scenePhase) { _, phase in
            // Network only while the app is on screen; .inactive (wrist down,
            // Always-On) keeps the connection so raising the wrist is instant.
            if phase == .background { model.stop() } else { model.start(endpoint: endpoint) }
        }
        .onChange(of: endpoint) { _, new in
            path = []
            model.start(endpoint: new)
        }
        .alert(
            model.transientError ?? "",
            isPresented: Binding(get: { model.transientError != nil }, set: { if !$0 { model.transientError = nil } })
        ) {
            Button("OK", role: .cancel) { model.transientError = nil }
        }
    }

    @ViewBuilder
    private var content: some View {
        if let endpoint {
            switch model.connection {
            case .unreachable(let reason):
                UnreachableView(
                    reason: reason,
                    host: endpoint.baseURLString,
                    lastUpdate: model.lastUpdate,
                    lastCounts: model.hasData ? model.counts : nil,
                    retry: { model.restart() },
                    openSettings: { showSettings = true }
                )
            case .connecting where !model.hasData:
                ConnectingView(host: endpoint.host)
            default:
                sessions
            }
        } else {
            NotConfiguredView(openSettings: { showSettings = true })
        }
    }

    @ViewBuilder
    private var sessions: some View {
        let items = model.presentations
        switch items.count {
        case 0:
            EmptySessionsView(connection: model.connection)
        case 1:
            SingleSessionView(model: model, p: items[0])
        default:
            SessionListView(model: model, items: items)
                .navigationTitle("\(items.count) sessions")
        }
    }
}
