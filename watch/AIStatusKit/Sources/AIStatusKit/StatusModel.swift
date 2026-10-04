import Combine
import Foundation

/// A status change worth a haptic while the app is in the foreground.
public enum Transition: Equatable, Sendable {
    case becameWaiting(id: String)
    case becameDone(id: String)

    /// Waiting needs the user; it wins over done when both happen at once.
    public var priority: Int {
        switch self {
        case .becameWaiting: return 2
        case .becameDone: return 1
        }
    }

    /// Compare the previous status of every card with the new snapshot. The first
    /// snapshot (no previous state) never produces transitions, so opening the app
    /// does not buzz for things that were already there.
    public static func between(previous: [String: SessionStatus]?, current: [SessionCard]) -> [Transition] {
        guard let previous else { return [] }
        var out: [Transition] = []
        for c in current {
            let before = previous[c.id]
            guard before != c.status else { continue }
            switch c.status {
            case .waiting: out.append(.becameWaiting(id: c.id))
            case .done: out.append(.becameDone(id: c.id))
            default: break
            }
        }
        return out
    }
}

/// The watch app's single source of truth. Owns the feed task, applies snapshots,
/// keeps the clock offset, keeps cards in a stable order (`SessionOrder`), and
/// performs dismissals optimistically.
@MainActor
public final class StatusModel: ObservableObject {
    /// Visible cards in stable start order (pending dismissals hidden).
    @Published public private(set) var cards: [SessionCard] = []
    @Published public private(set) var connection: ConnectionState = .connecting
    /// Local time the last snapshot arrived.
    @Published public private(set) var lastUpdate: Date?
    @Published public private(set) var clock = ClockSync()
    /// Short message for a failed user action (e.g. dismiss), cleared by the UI.
    @Published public var transientError: String?
    @Published public private(set) var endpoint: DaemonEndpoint?
    /// The server offers no event stream (cloud hub): updates come from polling
    /// every `pollInterval`, which is normal there and shown as fine. Learned
    /// from the first `/events` answer; reset when the endpoint changes.
    @Published public private(set) var streamUnavailable = false
    /// Seconds between polls while there is no stream (Settings > Refresh).
    public private(set) var pollInterval: TimeInterval

    /// Called with the most important transition of each snapshot (for haptics).
    public var onTransition: ((Transition) -> Void)?
    /// Called when the widget-relevant summary changes.
    public var onSummaryChange: ((SharedSnapshot) -> Void)?

    public var presentations: [CardPresentation] {
        cards.map { CardPresentation(card: $0, clock: clock) }
    }

    public var counts: StatusCounts { StatusCounts(cards: cards) }

    public var hasData: Bool { lastUpdate != nil }

    private var serverCards: [SessionCard] = []
    /// id -> `updatedAt` of the card when the user cleared it. Hidden until the
    /// server stops reporting that exact version of the card.
    private var pendingDismiss: [String: Int64?] = [:]
    private var previousStatus: [String: SessionStatus]?
    private var order = SessionOrder()
    private var lastSummary: SharedSnapshot?
    private var feedTask: Task<Void, Never>?
    private var transport: DaemonTransport?
    private let makeTransport: (DaemonEndpoint) -> DaemonTransport
    private var feedConfig: FeedConfig
    private let sleeper: Sleeper
    private let now: () -> Date

    public init(
        feedConfig: FeedConfig = FeedConfig(),
        sleeper: @escaping Sleeper = realSleeper,
        now: @escaping () -> Date = Date.init,
        makeTransport: @escaping (DaemonEndpoint) -> DaemonTransport = { URLSessionTransport(endpoint: $0) }
    ) {
        self.feedConfig = feedConfig
        self.pollInterval = feedConfig.pollInterval
        self.sleeper = sleeper
        self.now = now
        self.makeTransport = makeTransport
    }

    public var isRunning: Bool { feedTask != nil }

    /// Updates arrive by polling only (no stream offered, or SSE disabled).
    public var pollingOnly: Bool { streamUnavailable || !feedConfig.useStream }

    /// What the UI should show: polling is the normal mode when there is no
    /// stream, so it is shown like a live connection (no indicator).
    public var displayConnection: ConnectionState {
        if pollingOnly, connection == .polling { return .live }
        return connection
    }

    /// Whether to stop networking while the app is inactive (wrist down /
    /// Always On): a poll costs a request each time (on the cloud hub: a billed
    /// function invocation), an idle SSE connection costs nothing.
    public var pausesWhenInactive: Bool { pollingOnly || connection == .polling }

    /// Change the poll interval (1...600 s); restarts a running feed.
    public func setPollInterval(_ seconds: TimeInterval) {
        let v = min(600, max(1, seconds.isFinite ? seconds : 5))
        guard v != pollInterval else { return }
        pollInterval = v
        if isRunning {
            stop()
            start(endpoint: endpoint)
        }
    }

    /// Start (or keep) the feed for `endpoint`. Changing endpoint resets all state.
    public func start(endpoint newEndpoint: DaemonEndpoint?) {
        if newEndpoint != endpoint {
            stop()
            endpoint = newEndpoint
            serverCards = []
            cards = []
            pendingDismiss = [:]
            previousStatus = nil
            order.reset()
            lastUpdate = nil
            clock.reset()
            connection = .connecting
            streamUnavailable = false
        }
        guard feedTask == nil, let ep = endpoint else { return }
        let transport = makeTransport(ep)
        self.transport = transport
        if !hasData { connection = .connecting }
        var config = feedConfig
        config.pollInterval = pollInterval
        if streamUnavailable { config.useStream = false } // known: skip the /events attempt
        let stream = sessionFeed(transport: transport, config: config, sleep: sleeper)
        feedTask = Task { [weak self] in
            for await event in stream {
                guard let self, !Task.isCancelled else { break }
                self.handle(event)
            }
        }
    }

    /// Stop networking (app left the foreground). Cards stay for the next launch.
    public func stop() {
        feedTask?.cancel()
        feedTask = nil
    }

    /// Reconnect now, skipping any backoff (Retry button).
    public func restart() {
        stop()
        connection = .connecting
        start(endpoint: endpoint)
    }

    func handle(_ event: FeedEvent) {
        switch event {
        case .state(let s):
            if s != connection { connection = s }
            publishSummary()
        case .snapshot(let timed, _):
            ingest(timed)
        case .streamUnavailable:
            streamUnavailable = true
        }
    }

    /// Apply one snapshot (public for tests and previews).
    public func ingest(_ timed: TimedSnapshot) {
        clock.record(serverTimeMs: timed.snapshot.serverTime, sentAt: timed.sentAt, receivedAt: timed.receivedAt)
        let incoming = timed.snapshot.sessions
        // Forget pending dismissals the server has caught up with.
        for (id, version) in pendingDismiss {
            if let card = incoming.first(where: { $0.id == id }) {
                if let v = version, let u = card.updatedAt, u > v { pendingDismiss[id] = nil } // new activity
            } else if !inFlight.contains(id) {
                pendingDismiss[id] = nil
            }
        }
        let transitions = Transition.between(previous: previousStatus, current: incoming)
        previousStatus = Dictionary(incoming.map { ($0.id, $0.status) }, uniquingKeysWith: { a, _ in a })
        serverCards = incoming
        order.update(with: incoming)
        lastUpdate = now()
        recompute()
        if let top = transitions.filter({ id in !isHidden(id) }).max(by: { $0.priority < $1.priority }) {
            onTransition?(top)
        }
        publishSummary()
    }

    private func isHidden(_ t: Transition) -> Bool {
        switch t {
        case .becameWaiting(let id), .becameDone(let id): return pendingDismiss[id] != nil
        }
    }

    private var inFlight: Set<String> = []

    private func recompute() {
        let visible = serverCards.filter { pendingDismiss[$0.id] == nil }
        let ordered = order.sorted(visible)
        if ordered != cards { cards = ordered }
    }

    /// Clear a card: hide it immediately, then `POST /sessions/:id/dismiss`.
    /// On failure the card comes back (in the same place) and `transientError` is set.
    public func dismiss(id: String) async {
        guard let transport else { return }
        let version = serverCards.first(where: { $0.id == id })?.updatedAt
        pendingDismiss[id] = .some(version)
        inFlight.insert(id)
        recompute()
        publishSummary()
        do {
            try await transport.dismiss(id: id)
            inFlight.remove(id)
        } catch {
            inFlight.remove(id)
            pendingDismiss[id] = nil
            recompute()
            publishSummary()
            transientError = "Couldn't clear: " + ((error as? DaemonError)?.errorDescription ?? error.localizedDescription)
        }
    }

    /// Settings "Test connection".
    public static func test(endpoint: DaemonEndpoint, transport: DaemonTransport? = nil) async -> Result<Health, DaemonError> {
        let t = transport ?? URLSessionTransport(endpoint: endpoint)
        do {
            return .success(try await t.health())
        } catch {
            return .failure(DaemonError.from(error))
        }
    }

    private func publishSummary() {
        guard let onSummaryChange, hasData else { return }
        let summary = SharedSnapshot(
            savedAt: now(),
            counts: counts,
            reachable: connection.isReachable || connection == .connecting,
            waitingProjects: cards.filter { $0.status == .waiting }.map(\.displayProject),
            host: endpoint?.host
        )
        if let last = lastSummary, last.sameContent(as: summary) { return }
        lastSummary = summary
        onSummaryChange(summary)
    }
}
