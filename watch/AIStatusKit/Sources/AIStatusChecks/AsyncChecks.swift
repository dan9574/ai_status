import AIStatusKit
import Foundation

let snapA = Snapshot(serverTime: 1_000, sessions: [card("claude:a", .running, started: 900)])
let snapB = Snapshot(serverTime: 2_000, sessions: [card("claude:a", .done, started: 900, finished: 1_900)])

func runFeedChecks() async {
    var cfg = FeedConfig()
    cfg.pollInterval = 5
    cfg.firstSnapshotTimeout = 8

    await asyncSuite("feed: SSE healthy") {
        let t = FakeTransport(stream: .deliver([snapA, snapB], thenFail: false), poll: .success(snapA))
        let ev = await collect(sessionFeed(transport: t, config: cfg, sleep: fastSleeper)) { snapshotSources($0).count >= 2 }
        expectEqual(states(ev), [.connecting, .live], "connecting -> live")
        expectEqual(snapshotSources(ev), [.stream, .stream], "both snapshots via stream")
        expectEqual(t.counts.polls, 0, "no polling while SSE is up")
    }

    await asyncSuite("feed: SSE down, polling works") {
        let t = FakeTransport(stream: .failImmediately(.http(status: 404, message: nil)), poll: .success(snapA))
        let ev = await collect(sessionFeed(transport: t, config: cfg, sleep: fastSleeper)) { snapshotSources($0).count >= 6 }
        expectEqual(states(ev).first, .connecting, "starts connecting")
        check(states(ev).contains(.polling), "falls back to polling: \(states(ev))")
        check(!states(ev).contains { if case .unreachable = $0 { return true } else { return false } }, "never unreachable while polls succeed")
        check(snapshotSources(ev).allSatisfy { $0 == .poll }, "snapshots via poll")
        check(t.counts.streams >= 2, "SSE retried (\(t.counts.streams) opens)")
    }

    await asyncSuite("feed: Mac unreachable, then recovers") {
        let t = FakeTransport(stream: .failImmediately(.network("Connection refused")), poll: .failure(.network("Connection refused")))
        let stream = sessionFeed(transport: t, config: cfg, sleep: fastSleeper)
        let recorder = EventRecorder()
        let consumer = Task {
            for await e in stream { await recorder.add(e) }
        }
        try await waitUntil { await recorder.states().contains(.unreachable("Connection refused")) }
        expectEqual(await recorder.states(), [.connecting, .unreachable("Connection refused")], "connecting -> unreachable")
        let opensWhileDown = t.counts.streams
        t.set(stream: .deliver([snapB], thenFail: false), poll: .success(snapB))
        try await waitUntil { await recorder.states().last == .live }
        check(opensWhileDown >= 1, "kept retrying while down")
        expectEqual(await recorder.states().last, .live, "recovers to live")
        consumer.cancel()
    }

    await asyncSuite("feed: SSE connects but never sends (buffering proxy)") {
        let t = FakeTransport(stream: .hang, poll: .success(snapA))
        let ev = await collect(sessionFeed(transport: t, config: cfg, sleep: fastSleeper)) { snapshotSources($0).count >= 2 }
        check(states(ev).contains(.polling), "first-snapshot timeout => polling: \(states(ev))")
        check(snapshotSources(ev).contains(.poll), "data still arrives via polling")
    }

    await asyncSuite("feed: stream drops after delivering") {
        let t = FakeTransport(stream: .deliver([snapA], thenFail: true), poll: .success(snapB))
        let ev = await collect(sessionFeed(transport: t, config: cfg, sleep: fastSleeper)) { snapshotSources($0).count >= 5 }
        let st = states(ev)
        check(st.starts(with: [.connecting, .live]), "live first: \(st)")
        check(st.contains(.polling), "polls right after a drop")
        check(snapshotSources(ev).contains(.poll) && snapshotSources(ev).contains(.stream), "mix of stream and poll snapshots")
        check(t.counts.streams >= 2, "reconnects SSE quickly after a working stream dropped")
    }

    await asyncSuite("feed: polling-only mode") {
        var c = cfg
        c.useStream = false
        let t = FakeTransport(stream: .deliver([snapA], thenFail: false), poll: .success(snapA))
        let ev = await collect(sessionFeed(transport: t, config: c, sleep: fastSleeper)) { snapshotSources($0).count >= 3 }
        expectEqual(t.counts.streams, 0, "no SSE when disabled")
        expectEqual(snapshotSources(ev), [.poll, .poll, .poll], "polls")
    }

    await asyncSuite("feed: cancellation stops all requests") {
        let t = FakeTransport(stream: .failImmediately(.timedOut), poll: .success(snapA))
        let ev = await collect(sessionFeed(transport: t, config: cfg, sleep: fastSleeper)) { snapshotSources($0).count >= 2 }
        check(!ev.isEmpty, "got events")
        let before = t.counts
        try await Task.sleep(nanoseconds: 100_000_000)
        let after = t.counts
        check(before.streams == after.streams && before.polls == after.polls, "no requests after the consumer stopped (\(before) vs \(after))")
    }
}

actor EventRecorder {
    var events: [FeedEvent] = []
    func add(_ e: FeedEvent) { events.append(e) }
    func states() -> [ConnectionState] { AIStatusChecks.states(events) }
}

struct Timeout: Error {}

func waitUntil(timeout: TimeInterval = 3, _ cond: () async -> Bool) async throws {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await cond() { return }
        try await Task.sleep(nanoseconds: 5_000_000)
    }
    check(false, "timed out waiting for condition")
    throw Timeout()
}

@MainActor
func runModelChecks() async {
    await asyncSuite("view model: snapshots, ordering, haptics, widget summary") {
        let mixed = try Snapshot.decode(fixture("sessions-mixed.json"))
        let fake = FakeTransport(stream: .deliver([mixed], thenFail: false), poll: .success(mixed))
        let model = StatusModel(sleeper: fastSleeper, makeTransport: { _ in fake })
        var transitions: [Transition] = []
        var summaries: [SharedSnapshot] = []
        model.onTransition = { transitions.append($0) }
        model.onSummaryChange = { summaries.append($0) }
        check(!model.hasData, "no data before start")
        model.start(endpoint: DaemonEndpoint(host: "mac"))
        try await waitUntil { model.hasData }
        expectEqual(model.connection, .live, "live")
        expectEqual(model.cards.first?.project, "proj-wait", "waiting card first")
        expectEqual(model.cards.count, 8, "all cards")
        expectEqual(model.counts, StatusCounts(running: 2, waiting: 2, done: 4), "counts")
        expectEqual(transitions, [], "first snapshot does not buzz")
        expectEqual(summaries.last?.counts, StatusCounts(running: 2, waiting: 2, done: 4), "widget summary published")
        expectEqual(summaries.last?.waitingProjects, ["proj-wait", "proj-cxq"], "waiting projects in summary")
        let summaryCount = summaries.count

        // Same content again: no new widget reload.
        var again = mixed
        again.serverTime += 1000
        model.ingest(timed(again))
        expectEqual(summaries.count, summaryCount, "unchanged counts do not reload the widget")

        // proj-run finishes, proj-approx starts waiting: one haptic, waiting wins.
        var next = mixed
        next.serverTime += 5000
        for i in next.sessions.indices {
            if next.sessions[i].project == "proj-run" {
                next.sessions[i].status = .done
                next.sessions[i].finishedAt = next.serverTime
                next.sessions[i].runDurationMs = 5000
            }
            if next.sessions[i].project == "proj-approx" {
                next.sessions[i].status = .waiting
                next.sessions[i].waitingSince = next.serverTime
            }
        }
        model.ingest(timed(next))
        expectEqual(transitions.count, 1, "one haptic per snapshot")
        if case .becameWaiting(let id)? = transitions.last { check(id.contains("approx1"), "haptic for the waiting card") } else { check(false, "expected becameWaiting, got \(transitions)") }
        expectEqual(model.cards.map(\.status).filter { $0 == .running }.count, 0, "no running cards left")
        model.stop()
        check(!model.isRunning, "stopped")
    }

    await asyncSuite("view model: dismiss is optimistic and survives stale snapshots") {
        let mixed = try Snapshot.decode(fixture("sessions-mixed.json"))
        let fake = FakeTransport(stream: .deliver([mixed], thenFail: false), poll: .success(mixed))
        let model = StatusModel(sleeper: fastSleeper, makeTransport: { _ in fake })
        model.start(endpoint: DaemonEndpoint(host: "mac"))
        try await waitUntil { model.hasData }
        let quick = model.cards.first { $0.project == "proj-quick" }!
        expectEqual(quick.dismissPolicy, .swipe, "quick card is swipeable")
        await model.dismiss(id: quick.id)
        expectEqual(fake.dismissed, [quick.id], "POST dismiss sent with full id")
        check(!model.cards.contains { $0.id == quick.id }, "hidden immediately")
        // A stale snapshot (sent before the server processed the dismiss) must not resurrect it.
        model.ingest(timed(mixed))
        check(!model.cards.contains { $0.id == quick.id }, "stale snapshot does not resurrect")
        // Server confirms (card absent).
        let after = try Snapshot.decode(fixture("sessions-after-dismiss.json"))
        model.ingest(timed(after))
        expectEqual(model.cards.count, 7, "server state after dismiss")
        // Same session later starts a new run: it must show again.
        var again = after
        var revived = quick
        revived.status = .running
        revived.finishedAt = nil
        revived.updatedAt = (quick.updatedAt ?? 0) + 10_000
        again.sessions.append(revived)
        model.ingest(timed(again))
        check(model.cards.contains { $0.id == quick.id }, "new activity shows the card again")

        // Failure path: card comes back, error surfaced.
        fake.set(dismiss: .failure(.network("No network")))
        let long = model.cards.first { $0.project == "beta-service" }!
        await model.dismiss(id: long.id)
        check(model.cards.contains { $0.id == long.id }, "failed dismiss restores the card")
        check(model.transientError?.contains("No network") == true, "error surfaced: \(model.transientError ?? "nil")")
        model.stop()
    }

    await asyncSuite("view model: unreachable keeps last data, endpoint change resets") {
        let mixed = try Snapshot.decode(fixture("sessions-mixed.json"))
        let fake = FakeTransport(stream: .deliver([mixed], thenFail: true), poll: .failure(.network("Connection refused")))
        let model = StatusModel(sleeper: fastSleeper, makeTransport: { _ in fake })
        model.start(endpoint: DaemonEndpoint(host: "mac"))
        try await waitUntil { model.hasData }
        fake.set(stream: .failImmediately(.network("Connection refused")))
        // Streams opened before the switch may still deliver once; wait until it settles.
        try await Task.sleep(nanoseconds: 100_000_000)
        try await waitUntil { if case .unreachable = model.connection { return true } else { return false } }
        try await Task.sleep(nanoseconds: 100_000_000)
        expectEqual(model.connection, .unreachable("Connection refused"), "unreachable state (stable)")
        expectEqual(model.cards.count, 8, "last cards kept (tiles stay up with an offline mark)")
        model.start(endpoint: DaemonEndpoint(host: "other-mac"))
        expectEqual(model.cards.count, 0, "endpoint change clears cards")
        check(!model.hasData, "endpoint change clears lastUpdate")
        model.stop()
        model.start(endpoint: nil)
        check(!model.isRunning, "nil endpoint => not running")
    }
}
