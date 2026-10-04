import AIStatusKit
import SwiftUI

/// The whole app UI: one screen of session tiles (no navigation, no scrolling;
/// tapping a tile opens a one-screen detail sheet).
/// The watch app's `@main` just hosts this view; scene-phase driven networking,
/// haptics and the widget hand-off live here so they can be type-checked on macOS.
/// Settings open as a sheet on a long press anywhere, or from the empty /
/// unreachable / not-configured states.
public struct AIStatusRootView: View {
    @StateObject private var model: StatusModel
    @AppStorage(SettingsKeys.host) private var host = BuildDefaults.host
    @AppStorage(SettingsKeys.port) private var port = DaemonEndpoint.defaultPort
    @AppStorage(SettingsKeys.token) private var token = BuildDefaults.token
    @AppStorage(SettingsKeys.pollSeconds) private var pollSeconds = PollIntervals.default
    @Environment(\.scenePhase) private var scenePhase
    @State private var showSettings = false

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

    private var endpoint: DaemonEndpoint? {
        DaemonEndpoint(host: host, port: port, token: token)
    }

    public var body: some View {
        content
            .sheet(isPresented: $showSettings) {
                NavigationStack { SettingsView() }
            }
            .onAppear {
                model.onTransition = { Haptics.play(for: $0) }
                let store = sharedStore
                let reload = onWidgetDataChanged
                model.onSummaryChange = { summary in
                    store.save(summary)
                    reload()
                }
                model.setPollInterval(TimeInterval(pollSeconds))
                if scenePhase != .background { model.start(endpoint: endpoint) }
            }
            .onChange(of: scenePhase) { _, phase in
                // Network only while the app is on screen. .inactive (wrist down,
                // Always On) keeps an SSE connection so raising the wrist is
                // instant, but stops polling: each poll is a request (a billed
                // invocation on the cloud hub). Raising the wrist polls at once.
                switch phase {
                case .background: model.stop()
                case .inactive: if model.pausesWhenInactive { model.stop() } else { model.start(endpoint: endpoint) }
                default: model.start(endpoint: endpoint)
                }
            }
            .onChange(of: pollSeconds) { _, new in
                model.setPollInterval(TimeInterval(new))
            }
            .onChange(of: endpoint) { _, new in
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
        let openSettings = { showSettings = true }
        if let endpoint {
            if !model.cards.isEmpty {
                // Last known tiles stay up even while offline (a red mark says so).
                TileBoardView(model: model, openSettings: openSettings)
            } else {
                Group {
                    switch model.connection {
                    case .unreachable(let reason):
                        UnreachableView(reason: reason, host: endpoint.basePath.isEmpty ? "\(endpoint.host):\(endpoint.port)" : endpoint.host,
                                        retry: { model.restart() }, openSettings: openSettings)
                    case .connecting where !model.hasData:
                        ConnectingView(host: endpoint.host)
                    default:
                        EmptySessionsView(openSettings: openSettings)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .contentShape(Rectangle())
                .onLongPressGesture(perform: openSettings)
            }
        } else {
            NotConfiguredView(openSettings: openSettings)
        }
    }
}
