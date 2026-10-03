import AIStatusKit
import Foundation

/// Minimal test harness (XCTest and Swift Testing are not available with the
/// Command Line Tools alone). `swift run AIStatusChecks` exits non-zero on failure.
final class Harness: @unchecked Sendable {
    static let shared = Harness()
    private let lock = NSLock()
    private(set) var passed = 0
    private(set) var failed = 0
    private(set) var failures: [String] = []
    var currentSuite = ""
    var verbose = ProcessInfo.processInfo.environment["VERBOSE"] != nil

    func check(_ cond: Bool, _ msg: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
        lock.lock()
        defer { lock.unlock() }
        if cond {
            passed += 1
            if verbose { print("  ok    \(msg())") }
        } else {
            failed += 1
            let m = "\(currentSuite): \(msg())  (\(file):\(line))"
            failures.append(m)
            print("  FAIL  \(m)")
        }
    }

    func equal<T: Equatable>(_ a: T, _ b: T, _ msg: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
        check(a == b, "\(msg()) — got \(a), expected \(b)", file: file, line: line)
    }
}

func suite(_ name: String, _ body: () throws -> Void) {
    Harness.shared.currentSuite = name
    let before = Harness.shared.passed + Harness.shared.failed
    do { try body() } catch { Harness.shared.check(false, "threw \(error)") }
    print("• \(name): \(Harness.shared.passed + Harness.shared.failed - before) checks")
}

func asyncSuite(_ name: String, _ body: () async throws -> Void) async {
    Harness.shared.currentSuite = name
    let before = Harness.shared.passed + Harness.shared.failed
    do { try await body() } catch { Harness.shared.check(false, "threw \(error)") }
    print("• \(name): \(Harness.shared.passed + Harness.shared.failed - before) checks")
}

func check(_ cond: Bool, _ msg: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
    Harness.shared.check(cond, msg(), file: file, line: line)
}

func expectEqual<T: Equatable>(_ a: T, _ b: T, _ msg: @autoclosure () -> String, file: StaticString = #fileID, line: UInt = #line) {
    Harness.shared.equal(a, b, msg(), file: file, line: line)
}

// MARK: fixtures

let fixturesDir = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    .appendingPathComponent("Fixtures")

func fixture(_ name: String) throws -> Data {
    try Data(contentsOf: fixturesDir.appendingPathComponent(name))
}

func timed(_ s: Snapshot, at date: Date = Date()) -> TimedSnapshot {
    TimedSnapshot(snapshot: s, sentAt: date, receivedAt: date)
}

// MARK: fake transport

final class FakeTransport: DaemonTransport, @unchecked Sendable {
    enum StreamMode { case deliver([Snapshot], thenFail: Bool), failImmediately(DaemonError), hang }
    private let lock = NSLock()
    private var _streamMode: StreamMode
    private var _pollResult: Result<Snapshot, DaemonError>
    private var _dismissResult: Result<Void, DaemonError> = .success(())
    private(set) var streamOpens = 0
    private(set) var polls = 0
    private(set) var dismissed: [String] = []

    init(stream: StreamMode, poll: Result<Snapshot, DaemonError>) {
        _streamMode = stream
        _pollResult = poll
    }

    func set(stream: StreamMode? = nil, poll: Result<Snapshot, DaemonError>? = nil, dismiss: Result<Void, DaemonError>? = nil) {
        lock.lock()
        defer { lock.unlock() }
        if let stream { _streamMode = stream }
        if let poll { _pollResult = poll }
        if let dismiss { _dismissResult = dismiss }
    }

    var counts: (streams: Int, polls: Int) {
        lock.lock()
        defer { lock.unlock() }
        return (streamOpens, polls)
    }

    func fetchSnapshot() async throws -> TimedSnapshot {
        let r = lock.withLock { () -> Result<Snapshot, DaemonError> in
            polls += 1
            return _pollResult
        }
        return timed(try r.get())
    }

    func snapshotStream() -> AsyncThrowingStream<TimedSnapshot, Error> {
        lock.lock()
        streamOpens += 1
        let mode = _streamMode
        lock.unlock()
        return AsyncThrowingStream { c in
            switch mode {
            case .deliver(let snaps, let thenFail):
                for s in snaps { c.yield(timed(s)) }
                if thenFail { c.finish(throwing: DaemonError.streamEnded) }
            // else: stay open until cancelled
            case .failImmediately(let e):
                c.finish(throwing: e)
            case .hang:
                break
            }
        }
    }

    func dismiss(id: String) async throws {
        let r = lock.withLock { () -> Result<Void, DaemonError> in
            dismissed.append(id)
            return _dismissResult
        }
        try r.get()
    }

    func health() async throws -> Health {
        Health(ok: true, name: "fake", version: "0", serverTime: 0, sessions: 0)
    }
}

/// 1 "second" of feed time = 1 ms of real time.
let fastSleeper: Sleeper = { s in
    guard s > 0 else { return }
    try await Task.sleep(nanoseconds: UInt64(s * 1_000_000))
}

/// Collect feed events until `until` returns true or `timeout` (real seconds) passes.
func collect(_ stream: AsyncStream<FeedEvent>, timeout: TimeInterval = 3, until: @escaping ([FeedEvent]) -> Bool) async -> [FeedEvent] {
    await withTaskGroup(of: [FeedEvent]?.self) { group in
        group.addTask {
            var out: [FeedEvent] = []
            for await e in stream {
                out.append(e)
                if until(out) { break }
            }
            return out
        }
        group.addTask {
            try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
            return nil
        }
        var result: [FeedEvent] = []
        for await r in group {
            if let r { result = r }
            group.cancelAll()
            break
        }
        return result
    }
}

func states(_ events: [FeedEvent]) -> [ConnectionState] {
    events.compactMap { if case .state(let s) = $0 { return s } else { return nil } }
}

func snapshotSources(_ events: [FeedEvent]) -> [FeedSource] {
    events.compactMap { if case .snapshot(_, let src) = $0 { return src } else { return nil } }
}

func card(_ id: String, _ status: SessionStatus, started: Int64? = nil, finished: Int64? = nil, waiting: Int64? = nil, updated: Int64? = nil, policy: DismissPolicy = .confirm) -> SessionCard {
    SessionCard(
        id: id, tool: id.hasPrefix("codex") ? .codex : .claude, sessionId: String(id.split(separator: ":").last ?? ""),
        project: "p-" + String(id.split(separator: ":").last ?? ""), status: status, startedAt: started, finishedAt: finished,
        runDurationMs: (started != nil && finished != nil) ? finished! - started! : nil, waitingSince: waiting,
        dismissPolicy: policy, updatedAt: updated ?? finished ?? waiting ?? started
    )
}
