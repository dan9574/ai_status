import Foundation

public enum ConnectionState: Equatable, Sendable {
    /// Nothing received yet on this run of the feed.
    case connecting
    /// SSE stream is up; updates are pushed.
    case live
    /// SSE is down but `GET /sessions` works; updates arrive every `pollInterval`.
    case polling
    /// Neither works. The string is a short reason for the UI.
    case unreachable(String)

    public var isReachable: Bool {
        switch self {
        case .live, .polling: return true
        case .connecting, .unreachable: return false
        }
    }
}

public enum FeedSource: Sendable, Equatable { case stream, poll }

public enum FeedEvent: Sendable {
    case state(ConnectionState)
    case snapshot(TimedSnapshot, FeedSource)
}

/// Exponential backoff with jitter: base · factor^attempt, capped, ±jitter.
public struct Backoff: Equatable, Sendable {
    public var base: TimeInterval
    public var factor: Double
    public var max: TimeInterval
    public var jitter: Double

    public init(base: TimeInterval = 1, factor: Double = 2, max: TimeInterval = 30, jitter: Double = 0.2) {
        self.base = base
        self.factor = factor
        self.max = max
        self.jitter = jitter
    }

    /// `attempt` 0 is the first retry after a connection that was working.
    /// `unit` in [0, 1) picks the jitter (0.5 = none).
    public func delay(attempt: Int, unit: Double = Double.random(in: 0..<1)) -> TimeInterval {
        let raw = base * pow(factor, Double(Swift.max(0, Swift.min(attempt, 30))))
        let capped = Swift.min(raw, max)
        let j = 1 + jitter * (unit * 2 - 1)
        return Swift.max(0, capped * j)
    }
}

public struct FeedConfig: Sendable {
    public var backoff = Backoff()
    /// Poll interval while SSE is down.
    public var pollInterval: TimeInterval = 5
    /// An SSE connection must deliver its initial snapshot within this time
    /// (the daemon sends one immediately); otherwise it is abandoned. Also bounds
    /// how long an unresolvable host can stall the first attempt.
    public var firstSnapshotTimeout: TimeInterval = 8
    /// Consecutive failed polls before reporting `.unreachable`.
    public var unreachableAfterFailures = 2
    /// Disable SSE entirely (polling only). Useful if a network path buffers streams.
    public var useStream = true

    public init() {}
}

public typealias Sleeper = @Sendable (TimeInterval) async throws -> Void

public let realSleeper: Sleeper = { seconds in
    guard seconds > 0 else { return }
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
}

private final class Flag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    func set() { lock.lock(); value = true; lock.unlock() }
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
}

/// Connection loop for one endpoint while the app is in the foreground:
///
/// 1. open SSE (`GET /events`); every snapshot is forwarded, state `.live`;
/// 2. when the stream fails or ends: poll `GET /sessions` right away and then
///    every `pollInterval` (state `.polling`, or `.unreachable` after repeated
///    failures) until the backoff delay has elapsed;
/// 3. go to 1. Backoff grows only while SSE keeps failing without delivering
///    anything; one delivered snapshot resets it.
///
/// Cancel the consuming task to stop everything (open requests are cancelled).
public func sessionFeed(
    transport: DaemonTransport,
    config: FeedConfig = FeedConfig(),
    sleep: @escaping Sleeper = realSleeper,
    random: @escaping @Sendable () -> Double = { Double.random(in: 0..<1) }
) -> AsyncStream<FeedEvent> {
    AsyncStream { continuation in
        let task = Task {
            var lastState: ConnectionState?
            func setState(_ s: ConnectionState) {
                if s != lastState {
                    lastState = s
                    continuation.yield(.state(s))
                }
            }
            func describe(_ error: Error) -> String {
                (error as? DaemonError)?.errorDescription ?? error.localizedDescription
            }
            setState(.connecting)
            var sseFailures = 0 // consecutive SSE attempts that delivered nothing (drives backoff)
            var failures = 0 // consecutive failed attempts of any kind (drives .unreachable)
            var lastError = "Cannot reach Mac"
            func failed(_ error: Error) {
                failures += 1
                lastError = describe(error)
                if failures >= config.unreachableAfterFailures { setState(.unreachable(lastError)) }
            }

            while !Task.isCancelled {
                // 1. SSE
                if config.useStream {
                    let got = Flag()
                    var streamError: Error?
                    do {
                        try await withThrowingTaskGroup(of: Void.self) { group in
                            group.addTask {
                                for try await snap in transport.snapshotStream() {
                                    if !got.isSet {
                                        got.set()
                                        continuation.yield(.state(.live))
                                    }
                                    continuation.yield(.snapshot(snap, .stream))
                                }
                                if Task.isCancelled { throw CancellationError() }
                                throw DaemonError.streamEnded
                            }
                            group.addTask {
                                try await sleep(config.firstSnapshotTimeout)
                                if !got.isSet { throw DaemonError.timedOut }
                            }
                            for try await _ in group {}
                        }
                    } catch {
                        streamError = error
                    }
                    if Task.isCancelled { break }
                    if got.isSet {
                        lastState = .live
                        sseFailures = 0
                        failures = 0
                    } else {
                        sseFailures += 1
                        failed(streamError ?? DaemonError.streamEnded)
                    }
                }

                // 2. poll until it is time to retry SSE
                let window = config.useStream
                    ? config.backoff.delay(attempt: max(0, sseFailures - 1), unit: random())
                    : config.pollInterval
                var waited: TimeInterval = 0
                while !Task.isCancelled {
                    do {
                        let snap = try await transport.fetchSnapshot()
                        failures = 0
                        setState(.polling)
                        continuation.yield(.snapshot(snap, .poll))
                    } catch {
                        if Task.isCancelled { break }
                        failed(error)
                    }
                    let step = min(config.pollInterval, window - waited)
                    if step <= 0 { break }
                    do { try await sleep(step) } catch { break }
                    waited += step
                }
            }
            continuation.finish()
        }
        continuation.onTermination = { _ in task.cancel() }
    }
}
