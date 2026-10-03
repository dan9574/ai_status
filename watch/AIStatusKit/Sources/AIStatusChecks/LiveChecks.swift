import AIStatusKit
import Foundation

/// Live checks against a real aistatusd (started by scripts/live-check.mjs with a
/// scratch HOME). Exercises the real URLSession SSE / polling / dismiss code paths.
/// Protocol with the orchestrator: print "RESTART_DAEMON" on its own line; the
/// orchestrator restarts the daemon (same port, same state file).
@MainActor
func runLiveChecks(host: String, port: Int, lanHost: String?, token: String?) async {
    let endpoint = DaemonEndpoint(host: host, port: port)!
    let transport = URLSessionTransport(endpoint: endpoint)

    func hook(_ payload: [String: Any]) async throws {
        var req = URLRequest(url: endpoint.url(path: "/hook/claude")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (_, resp) = try await URLSession.shared.data(for: req)
        check((resp as? HTTPURLResponse)?.statusCode == 200, "hook \(payload["hook_event_name"] ?? "") accepted")
    }

    await asyncSuite("live: plain requests") {
        let h = try await transport.health()
        check(h.ok && h.name == "aistatusd", "GET /health")
        let s = try await transport.fetchSnapshot()
        check(s.snapshot.serverTime > 0, "GET /sessions decodes (\(s.snapshot.sessions.count) cards)")
        try await transport.dismiss(id: "claude:does-not-exist")
        check(true, "dismiss of unknown id treated as already gone (404)")
    }

    let sid = "live-\(UUID().uuidString.prefix(8))"
    let cardId = "claude:\(sid)"
    let model = StatusModel()
    var transitions: [Transition] = []
    model.onTransition = { transitions.append($0) }

    await asyncSuite("live: SSE-driven view model") {
        model.start(endpoint: endpoint)
        try await waitUntil(timeout: 10) { model.connection == .live }
        check(true, "SSE connected (.live)")
        check(abs(model.clock.offset) < 2, "clock offset on same host ≈ 0 (\(model.clock.offset) s)")

        try await hook(["session_id": sid, "cwd": "/tmp/live-proj", "hook_event_name": "SessionStart", "source": "startup"])
        try await hook(["session_id": sid, "cwd": "/tmp/live-proj", "hook_event_name": "UserPromptSubmit", "prompt": "live check"])
        try await waitUntil(timeout: 5) { model.cards.contains { $0.id == cardId && $0.status == .running } }
        check(true, "pushed: running card appears")
        let running = model.presentations.first { $0.id == cardId }
        check(running?.timerStart.map { abs($0.timeIntervalSinceNow) < 5 } == true, "running timer anchored near now")

        try await hook(["session_id": sid, "cwd": "/tmp/live-proj", "hook_event_name": "Notification", "message": "Claude needs your permission to use Bash", "notification_type": "permission_prompt"])
        try await waitUntil(timeout: 5) { model.cards.first?.id == cardId && model.cards.first?.status == .waiting }
        check(true, "pushed: waiting card sorted first")
        check(transitions.contains(.becameWaiting(id: cardId)), "haptic transition: waiting")

        try await hook(["session_id": sid, "cwd": "/tmp/live-proj", "hook_event_name": "PostToolUse", "tool_name": "Bash"])
        try await hook(["session_id": sid, "cwd": "/tmp/live-proj", "hook_event_name": "Stop", "last_assistant_message": "All good."])
        try await waitUntil(timeout: 5) { model.cards.contains { $0.id == cardId && $0.status == .done } }
        check(true, "pushed: done card")
        check(transitions.contains(.becameDone(id: cardId)), "haptic transition: done")
        let done = model.cards.first { $0.id == cardId }!
        expectEqual(done.dismissPolicy, .swipe, "short run => swipe")
        expectEqual(done.lastMessage, "All good.", "last message")

        await model.dismiss(id: cardId)
        check(!model.cards.contains { $0.id == cardId }, "dismissed locally")
        let server = try await transport.fetchSnapshot()
        check(!server.snapshot.sessions.contains { $0.id == cardId }, "dismissed on the daemon")
        try await Task.sleep(nanoseconds: 300_000_000)
        check(!model.cards.contains { $0.id == cardId }, "stays dismissed after the pushed snapshot")
        check(model.transientError == nil, "no error")
    }

    await asyncSuite("live: reconnect after daemon restart") {
        // Leave a card so persistence across the restart is visible.
        try await hook(["session_id": sid, "cwd": "/tmp/live-proj", "hook_event_name": "UserPromptSubmit", "prompt": "second run"])
        try await waitUntil(timeout: 5) { model.cards.contains { $0.id == cardId && $0.status == .running } }
        print("RESTART_DAEMON")
        fflush(stdout)
        try await waitUntil(timeout: 10) { model.connection != .live }
        check(true, "noticed the daemon going away (\(model.connection))")
        try await waitUntil(timeout: 20) { model.connection == .live }
        check(true, "back to .live after restart")
        check(model.cards.contains { $0.id == cardId && $0.status == .running }, "card survived restart")
        model.stop()
    }

    await asyncSuite("live: polling-only feed") {
        var cfg = FeedConfig()
        cfg.useStream = false
        cfg.pollInterval = 0.5
        let polled = StatusModel(feedConfig: cfg)
        polled.start(endpoint: endpoint)
        try await waitUntil(timeout: 5) { polled.connection == .polling && polled.hasData }
        check(polled.cards.contains { $0.id == cardId }, "polling sees the same cards")
        await polled.dismiss(id: cardId)
        try await waitUntil(timeout: 5) { !polled.cards.contains { $0.id == cardId } }
        polled.stop()
    }

    if let lanHost, let token {
        await asyncSuite("live: token over LAN address") {
            let bad = URLSessionTransport(endpoint: DaemonEndpoint(host: lanHost, port: port)!)
            do {
                _ = try await bad.fetchSnapshot()
                check(false, "expected 401 without token")
            } catch {
                expectEqual(error as? DaemonError, .unauthorized, "no token => unauthorized")
            }
            let good = URLSessionTransport(endpoint: DaemonEndpoint(host: lanHost, port: port, token: token)!)
            let s = try await good.fetchSnapshot()
            check(s.snapshot.serverTime > 0, "Bearer token accepted from \(lanHost)")
            // SSE with token from the LAN address too.
            var it = good.snapshotStream().makeAsyncIterator()
            let first = try await it.next()
            check(first != nil, "SSE with token from LAN address")
            // and the model reports a bad token as unreachable with a clear reason
            let m = StatusModel()
            m.start(endpoint: DaemonEndpoint(host: lanHost, port: port, token: "wrong"))
            try await waitUntil(timeout: 10) { if case .unreachable = m.connection { return true } else { return false } }
            expectEqual(m.connection, .unreachable("Wrong or missing token"), "wrong token surfaced")
            m.stop()
        }
    } else {
        print("• live: token over LAN address: skipped (no LAN address)")
    }

    await asyncSuite("live: unreachable port") {
        let m = StatusModel()
        m.start(endpoint: DaemonEndpoint(host: "127.0.0.1", port: port + 1))
        try await waitUntil(timeout: 10) { if case .unreachable = m.connection { return true } else { return false } }
        check(true, "nothing listening => .unreachable (\(m.connection))")
        m.stop()
    }
}
