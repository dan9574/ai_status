import AIStatusKit
import Foundation

func runDecodingChecks() {
    suite("decode real daemon fixtures") {
        let empty = try Snapshot.decode(fixture("sessions-empty.json"))
        expectEqual(empty.sessions.count, 0, "empty snapshot has no sessions")
        check(empty.serverTime > 1_700_000_000_000, "serverTime is epoch ms")
        expectEqual(empty.version, 1, "version")

        let mixed = try Snapshot.decode(fixture("sessions-mixed.json"))
        expectEqual(mixed.sessions.count, 8, "mixed fixture card count")
        expectEqual(mixed.swipeThresholdSec, 2, "swipeThresholdSec")
        let by = Dictionary(uniqueKeysWithValues: mixed.sessions.map { ($0.project ?? "", $0) })
        expectEqual(by["proj-wait"]?.status, .waiting, "proj-wait waiting")
        expectEqual(by["proj-wait"]?.waitingReason, .permission, "proj-wait waits for permission")
        check(by["proj-wait"]?.waitingSince != nil, "waitingSince present")
        expectEqual(by["proj-cxq"]?.tool, .codex, "codex tool decoded")
        expectEqual(by["proj-run"]?.status, .running, "proj-run running")
        check(by["proj-run"]?.finishedAt == nil && by["proj-run"]?.runDurationMs == nil, "running has null finishedAt/runDurationMs")
        expectEqual(by["proj-approx"]?.startedAtApprox, true, "startedAtApprox")
        expectEqual(by["proj-approx"]?.lastMessage, nil, "null lastMessage")
        expectEqual(by["beta-service"]?.status, .done, "beta-service done")
        expectEqual(by["beta-service"]?.dismissPolicy, .confirm, "long run => confirm")
        check((by["beta-service"]?.runDurationMs ?? 0) >= 2000, "runDurationMs decoded")
        expectEqual(by["proj-quick"]?.dismissPolicy, .swipe, "short run => swipe")
        expectEqual(by["proj-cxi"]?.interrupted, true, "codex interrupted")
        expectEqual(by["proj-fail"]?.error, "rate_limit", "error string")
        expectEqual(by["proj-quick"]?.cwd, "/Users/demo/projects/proj-quick", "cwd")
        check(mixed.sessions.allSatisfy { $0.id == "\($0.tool.rawValue):\($0.sessionId)" }, "id = tool:sessionId")
        check(mixed.sessions.allSatisfy { $0.updatedAt != nil }, "updatedAt present")

        let after = try Snapshot.decode(fixture("sessions-after-dismiss.json"))
        expectEqual(after.sessions.count, 7, "after dismiss: one fewer")
        check(!after.sessions.contains { $0.project == "proj-quick" }, "dismissed card gone")

        let ok = try JSONDecoder().decode(DismissResponse.self, from: fixture("dismiss-ok.json"))
        check(ok.ok && ok.dismissed?.project == "proj-quick", "dismiss response decodes with card")
        let nf = try JSONDecoder().decode(APIErrorBody.self, from: fixture("dismiss-404.json"))
        check(nf.error.contains("no such session"), "404 error body")
        let un = try JSONDecoder().decode(APIErrorBody.self, from: fixture("unauthorized.json"))
        expectEqual(un.error, "unauthorized", "401 error body")
        let h = try JSONDecoder().decode(Health.self, from: fixture("health.json"))
        check(h.ok && h.name == "aistatusd" && h.sessions == 7, "health decodes")

        // Round trip through our own encoder keeps everything.
        let re = try JSONDecoder().decode([SessionCard].self, from: JSONEncoder().encode(mixed.sessions))
        expectEqual(re, mixed.sessions, "SessionCard encode/decode round trip")
    }

    suite("tolerant decoding") {
        let json = """
        {"serverTime": 1.7910512507e12, "sessions": [
          {"id":"gemini:1","tool":"gemini","sessionId":"1","status":"thinking","dismissPolicy":"maybe","startedAt":1791051250000.0},
          {"id":"claude:2","tool":"claude","status":"done","error":{"code":5},"finishedAt":1791051250000},
          {"tool":"claude","status":"running"},
          {"id":"codex:3","tool":"codex","sessionId":"3","status":"waiting","waitingReason":"telepathy","cwd":"/a/b/repo","extra":[1,2]}
        ]}
        """
        let s = try Snapshot.decode(Data(json.utf8))
        expectEqual(s.serverTime, 1_791_051_250_700, "float serverTime accepted")
        expectEqual(s.version, 1, "missing version defaults to 1")
        expectEqual(s.sessions.count, 3, "card without id skipped, others kept")
        expectEqual(s.sessions[0].tool, .other("gemini"), "unknown tool kept")
        expectEqual(s.sessions[0].status, .other("thinking"), "unknown status kept")
        expectEqual(s.sessions[0].dismissPolicy, .confirm, "unknown policy => confirm")
        expectEqual(s.sessions[0].startedAt, 1_791_051_250_000, "float ms accepted")
        expectEqual(s.sessions[1].error, "error", "non-string error tolerated")
        expectEqual(s.sessions[1].sessionId, "claude:2", "missing sessionId falls back to id")
        expectEqual(s.sessions[2].waitingReason, .other("telepathy"), "unknown waiting reason")
        expectEqual(s.sessions[2].displayProject, "repo", "displayProject from cwd")
        check((try? Snapshot.decode(Data("{\"sessions\":[]}".utf8))) == nil, "missing serverTime is an error")
    }

    suite("machine field (multi-host daemon)") {
        let json = """
        {"version":1,"serverTime":1791051250000,"sessions":[
          {"id":"codex@WIN-PC:abc","tool":"codex","sessionId":"abc","machine":"WIN-PC","project":"winproj","status":"running","startedAt":1791051240000,"activeSubagents":1},
          {"id":"codex:abc","tool":"codex","sessionId":"abc","machine":"my-mac","status":"done","finishedAt":1791051250000},
          {"id":"claude:x","tool":"claude","sessionId":"x","status":"running"},
          {"id":"claude:y","tool":"claude","sessionId":"y","machine":null,"status":"running"},
          {"id":"claude:z","tool":"claude","sessionId":"z","machine":42,"status":"running"}
        ]}
        """
        let s = try Snapshot.decode(Data(json.utf8))
        expectEqual(s.sessions.count, 5, "all cards decode (unknown activeSubagents ignored)")
        expectEqual(s.sessions[0].machine, "WIN-PC", "remote machine decoded")
        expectEqual(s.sessions[0].id, "codex@WIN-PC:abc", "remote id kept verbatim")
        expectEqual(s.sessions[1].machine, "my-mac", "local machine decoded")
        check(s.sessions[0].id != s.sessions[1].id, "same sessionId on two machines => distinct ids")
        expectEqual(s.sessions[2].machine, nil, "older daemon: no machine")
        expectEqual(s.sessions[3].machine, nil, "null machine")
        expectEqual(s.sessions[4].machine, nil, "non-string machine tolerated")
        let re = try JSONDecoder().decode([SessionCard].self, from: JSONEncoder().encode(s.sessions))
        expectEqual(re, s.sessions, "round trip keeps machine")
        check(DaemonEndpoint(host: "mac.local")?.dismissURL(id: "codex@WIN-PC:abc")?.absoluteString.hasSuffix("/sessions/codex%40WIN-PC%3Aabc/dismiss") == true, "remote id percent-encoded for dismiss")
    }
}

func runSSEChecks() {
    suite("SSE parser on captured /events stream") {
        let raw = try fixture("events-stream.txt")
        var p = SSEParser()
        let events = p.push(contentsOf: raw)
        expectEqual(events.count, 25, "snapshot events in capture")
        check(events.allSatisfy { $0.event == "snapshot" }, "all events are 'snapshot'")
        expectEqual(p.retryMs, 2000, "retry field")
        expectEqual(p.commentCount, 1, ": ping comment seen")
        let snaps = try events.map { try Snapshot.decode(Data($0.data.utf8)) }
        check(zip(snaps, snaps.dropFirst()).allSatisfy { $0.serverTime <= $1.serverTime }, "serverTime monotonic")
        let after = try Snapshot.decode(fixture("sessions-after-dismiss.json"))
        expectEqual(snaps.last?.sessions.map(\.id), after.sessions.map(\.id), "last pushed snapshot == GET /sessions after dismiss")
        let mixed = try Snapshot.decode(fixture("sessions-mixed.json"))
        check(snaps.contains { $0.sessions.map(\.id) == mixed.sessions.map(\.id) }, "a pushed snapshot matches GET /sessions (mixed)")

        // Chunking must not matter: feed in random-size chunks, with CRLF line endings too.
        var rng = SplitMix(seed: 42)
        for variant in 0..<3 {
            var bytes = [UInt8](raw)
            if variant == 1 { bytes = Array(String(decoding: bytes, as: UTF8.self).replacingOccurrences(of: "\n", with: "\r\n").utf8) }
            if variant == 2 { bytes = Array(String(decoding: bytes, as: UTF8.self).replacingOccurrences(of: "\n", with: "\r").utf8) }
            var q = SSEParser()
            var got: [SSEEvent] = []
            var i = 0
            while i < bytes.count {
                let n = Int(rng.next() % 97) + 1
                got += q.push(contentsOf: bytes[i..<min(bytes.count, i + n)])
                i += n
            }
            expectEqual(got, events, "same events with random chunks (variant \(variant))")
        }
    }

    suite("SSE parser edge cases") {
        func parse(_ s: String) -> [SSEEvent] {
            var p = SSEParser()
            return p.push(contentsOf: Array(s.utf8))
        }
        expectEqual(parse("data: a\ndata: b\n\n"), [SSEEvent(data: "a\nb")], "multi-line data joined")
        expectEqual(parse("data:no-space\n\n"), [SSEEvent(data: "no-space")], "no space after colon")
        expectEqual(parse("data:  two\n\n"), [SSEEvent(data: " two")], "only one leading space stripped")
        expectEqual(parse("event: x\n\n"), [], "event without data is not dispatched")
        expectEqual(parse("data: a\n"), [], "no blank line yet => no dispatch")
        expectEqual(parse(": hello\n\n"), [], "comment only")
        expectEqual(parse("\u{FEFF}data: bom\n\n"), [SSEEvent(data: "bom")], "BOM skipped")
        expectEqual(parse("data\n\n"), [SSEEvent(data: "")], "field without colon")
        expectEqual(parse("event: snapshot\ndata: 1\n\ndata: 2\n\n"), [SSEEvent(event: "snapshot", data: "1"), SSEEvent(data: "2")], "event type resets after dispatch")
        expectEqual(parse("id: 7\ndata: x\n\n").first?.id, "7", "id field")
        var p = SSEParser()
        _ = p.push(contentsOf: Array("retry: 12a\n\nretry: 500\n\n".utf8))
        expectEqual(p.retryMs, 500, "non-numeric retry ignored")
        expectEqual(parse("data: 中文 ✓\n\n"), [SSEEvent(data: "中文 ✓")], "UTF-8 data")
        // multibyte char split across chunks
        var q = SSEParser()
        let bytes = Array("data: é\n\n".utf8)
        var out: [SSEEvent] = []
        for b in bytes { if let e = q.push(b) { out.append(e) } }
        expectEqual(out, [SSEEvent(data: "é")], "byte-at-a-time UTF-8")
    }
}

struct SplitMix {
    var state: UInt64
    init(seed: UInt64) { state = seed }
    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

func runOrderingAndPresentationChecks() {
    suite("tile order on real daemon data") {
        let mixed = try Snapshot.decode(fixture("sessions-mixed.json"))
        let sorted = SessionOrder().sorted(mixed.sessions)
        let keys = sorted.map(SessionOrder.startKey)
        check(zip(keys, keys.dropFirst()).allSatisfy { $0 <= $1 }, "oldest start first: \(sorted.map(\.displayProject))")
        expectEqual(SessionOrder().sorted(mixed.sessions.reversed()).map(\.id), sorted.map(\.id), "order independent of input order")
    }

    suite("clock skew") {
        var c = ClockSync()
        expectEqual(c.offset, 0, "no samples => 0")
        let local = Date(timeIntervalSince1970: 1_000)
        // Mac clock is 90 s ahead of the watch.
        c.record(serverTimeMs: 1_090_000, sentAt: local, receivedAt: local)
        expectEqual(c.offset, 90, "offset from one sample")
        expectEqual(c.localDate(serverMs: 1_090_000), local, "server time maps to local now")
        // A poll with 2 s round trip: midpoint used.
        var d = ClockSync()
        d.record(serverTimeMs: 1_091_000, sentAt: local, receivedAt: local.addingTimeInterval(2))
        expectEqual(d.offset, 90, "midpoint of round trip")
        // Outlier rejected by median.
        for _ in 0..<3 { c.record(serverTimeMs: 1_090_000, sentAt: local, receivedAt: local) }
        c.record(serverTimeMs: 1_090_000, sentAt: local.addingTimeInterval(30), receivedAt: local.addingTimeInterval(30))
        expectEqual(c.offset, 90, "median ignores one delayed sample")
        for i in 0..<10 { c.record(serverTimeMs: 1_000_000 + Int64(i), sentAt: local, receivedAt: local) }
        expectEqual(c.samples.count, 5, "window bounded")
        check(abs(c.offset) < 0.01, "converges to new offset")
        c.reset()
        expectEqual(c.offset, 0, "reset")
    }

    suite("card presentation") {
        let mixed = try Snapshot.decode(fixture("sessions-mixed.json"))
        var clock = ClockSync()
        let receivedLocal = Date(timeIntervalSince1970: Double(mixed.serverTime) / 1000 - 120) // watch is 2 min behind
        clock.record(serverTimeMs: mixed.serverTime, sentAt: receivedLocal, receivedAt: receivedLocal)
        let p = Dictionary(uniqueKeysWithValues: mixed.sessions.map { ($0.displayProject, CardPresentation(card: $0, clock: clock)) })
        let run = mixed.sessions.first { $0.project == "proj-run" }!
        expectEqual(p["proj-run"]?.headline, "Running", "running headline")
        expectEqual(p["proj-run"]?.detail, nil, "running: no detail")
        let expectedStart = Date(timeIntervalSince1970: Double(run.startedAt!) / 1000 - 120)
        check(abs((p["proj-run"]?.timerStart ?? .distantPast).timeIntervalSince(expectedStart)) < 0.001, "running timer start corrected for skew")
        expectEqual(p["proj-approx"]?.detail, "start time approximate", "approximate start marked")
        expectEqual(p["proj-wait"]?.headline, "Needs approval", "permission => Needs approval")
        expectEqual(p["proj-wait"]?.tone, .waiting, "waiting tone")
        expectEqual(p["beta-service"]?.headline, "Done", "done headline")
        expectEqual(p["beta-service"]?.detail, "ran 2s", "done shows run duration")
        expectEqual(p["proj-cxi"]?.headline, "Interrupted", "interrupted headline")
        expectEqual(p["proj-fail"]?.headline, "Failed", "error headline")
        expectEqual(p["proj-fail"]?.tone, .failed, "failed tone")
        expectEqual(p["proj-cxq"]?.tool, .codex, "tool carried through")
        let q = CardPresentation(card: SessionCard(id: "claude:q", tool: .claude, sessionId: "q", status: .waiting, startedAt: 0, waitingSince: 65_000, waitingReason: .question), clock: ClockSync())
        expectEqual(q.headline, "Has a question", "question headline")
        expectEqual(q.detail, "ran 1m 05s before", "time before waiting")
        let unknownDur = CardPresentation(card: SessionCard(id: "claude:u", tool: .claude, sessionId: "u", status: .done, finishedAt: 5), clock: ClockSync())
        expectEqual(unknownDur.detail, "run time unknown", "done without start")
        expectEqual(StatusCounts(cards: mixed.sessions), StatusCounts(running: 2, waiting: 2, done: 4), "counts")
    }

    suite("duration format") {
        let cases: [(TimeInterval, String)] = [
            (0, "0s"), (42.9, "42s"), (60, "1m 00s"), (250, "4m 10s"), (599, "9m 59s"), (600, "10m"), (3599, "59m"),
            (3600, "1h 00m"), (3840, "1h 04m"), (86_399, "23h 59m"), (93_600, "1d 2h"), (-5, "0s"),
        ]
        for (s, want) in cases { expectEqual(DurationFormat.short(s), want, "format \(s)") }
        expectEqual(DurationFormat.short(ms: 2528), "2s", "ms overload")
    }
}

func runEndpointChecks() {
    suite("endpoint normalisation") {
        func h(_ s: String) -> String? { DaemonEndpoint.normalizeHost(s)?.host }
        expectEqual(h("Daniels-MacBook-Air"), "Daniels-MacBook-Air.local", "bare name gets .local")
        expectEqual(h("  mymac.local.  "), "mymac.local", "trim + trailing dot")
        expectEqual(h("http://mymac.local:7778/sessions"), "mymac.local", "scheme/path stripped")
        expectEqual(DaemonEndpoint.normalizeHost("http://mymac.local:9000")?.port, 9000, "port parsed from host field")
        expectEqual(h("192.168.1.20"), "192.168.1.20", "IPv4 kept")
        expectEqual(h("mac.lan"), "mac.lan", "dotted name kept")
        expectEqual(h("localhost"), "localhost", "localhost kept")
        expectEqual(h("Daniel s Mac"), "Daniel-s-Mac.local", "spaces become hyphens")
        expectEqual(h("fe80::1"), "fe80::1", "IPv6 kept")
        expectEqual(DaemonEndpoint.normalizeHost("[fe80::1]:8000")?.port, 8000, "bracketed IPv6 with port")
        check(DaemonEndpoint.normalizeHost("   ") == nil, "empty => nil")
        check(DaemonEndpoint(host: "") == nil, "no endpoint without host")
        check(DaemonEndpoint(host: "mac", port: 0) == nil, "port 0 rejected")
        check(DaemonEndpoint(host: "mac", port: 70000) == nil, "port too large rejected")

        let ep = DaemonEndpoint(host: "mymac", port: 7778, token: "  s3cret ")!
        expectEqual(ep.baseURLString, "http://mymac.local:7778", "base URL")
        expectEqual(ep.sessionsURL?.absoluteString, "http://mymac.local:7778/sessions", "sessions URL")
        expectEqual(ep.eventsURL?.absoluteString, "http://mymac.local:7778/events", "events URL")
        expectEqual(ep.dismissURL(id: "claude:2f1c-ab/x y")?.absoluteString, "http://mymac.local:7778/sessions/claude%3A2f1c-ab%2Fx%20y/dismiss", "dismiss id percent-encoded")
        expectEqual(ep.token, "s3cret", "token trimmed")
        expectEqual(DaemonEndpoint(host: "mymac", token: "  ")?.token, nil, "blank token => nil")
        let v6 = DaemonEndpoint(host: "fe80::1", port: 7778)!
        expectEqual(v6.baseURLString, "http://[fe80::1]:7778", "IPv6 base URL bracketed")
        expectEqual(v6.sessionsURL?.host, "fe80::1", "IPv6 URL host")
        check(v6.sessionsURL?.absoluteString.contains("[fe80::1]") == true, "IPv6 URL string bracketed: \(v6.sessionsURL?.absoluteString ?? "nil")")
    }

    suite("endpoint: https base URL (public tunnel, e.g. Tailscale Funnel)") {
        let ep = DaemonEndpoint(host: "https://mac.tail1234.ts.net", port: 7778, token: "tok")!
        check(ep.secure, "https:// => secure")
        expectEqual(ep.host, "mac.tail1234.ts.net", "host without scheme")
        expectEqual(ep.port, 443, "https without a port => 443 (port setting ignored)")
        expectEqual(ep.scheme, "https", "scheme")
        expectEqual(ep.baseURLString, "https://mac.tail1234.ts.net", "base URL without :443")
        expectEqual(ep.sessionsURL?.absoluteString, "https://mac.tail1234.ts.net/sessions", "sessions URL")
        expectEqual(ep.eventsURL?.absoluteString, "https://mac.tail1234.ts.net/events", "events URL")
        expectEqual(ep.healthURL?.absoluteString, "https://mac.tail1234.ts.net/health", "health URL")
        expectEqual(ep.dismissURL(id: "codex@WIN:a")?.absoluteString, "https://mac.tail1234.ts.net/sessions/codex%40WIN%3Aa/dismiss", "dismiss URL")
        expectEqual(DaemonEndpoint(host: "  HTTPS://mac.tail1234.ts.net/  ")?.baseURLString, "https://mac.tail1234.ts.net", "case-insensitive scheme, trailing slash, spaces")
        expectEqual(DaemonEndpoint(host: "https://mac.tail1234.ts.net/sessions?x=1")?.sessionsURL?.absoluteString, "https://mac.tail1234.ts.net/sessions", "path/query stripped")
        let p8443 = DaemonEndpoint(host: "https://mac.tail1234.ts.net:8443")!
        expectEqual(p8443.port, 8443, "explicit https port kept")
        expectEqual(p8443.sessionsURL?.absoluteString, "https://mac.tail1234.ts.net:8443/sessions", "explicit port in URL")
        expectEqual(DaemonEndpoint(host: "https://mac.tail1234.ts.net:443")?.sessionsURL?.absoluteString, "https://mac.tail1234.ts.net/sessions", "explicit :443 dropped from URL")
        let http = DaemonEndpoint(host: "http://mymac.local", port: 7790)!
        check(!http.secure, "http:// stays plain http")
        expectEqual(http.port, 7790, "http:// without port keeps the port setting")
        check(!DaemonEndpoint(host: "mac.tail1234.ts.net")!.secure, "no scheme => plain http (LAN / tailnet)")
        expectEqual(DaemonEndpoint(host: "mac.tail1234.ts.net")!.port, 7778, "no scheme => port setting")
        expectEqual(DaemonEndpoint(host: "https://dummy.example.ts.net", token: "  t0k  ")?.token, "t0k", "token trimmed for https too")
        check(DaemonEndpoint(host: "https://") == nil, "scheme only => nil")
        check(DaemonEndpoint(host: "https://a.ts.net") != DaemonEndpoint(host: "http://a.ts.net", port: 443), "http and https endpoints differ (reconnect on change)")
        let v6 = DaemonEndpoint(host: "https://[fd7a::1]")!
        expectEqual(v6.sessionsURL?.absoluteString, "https://[fd7a::1]/sessions", "https IPv6")
    }

    suite("build-time defaults (Info.plist via xcconfig)") {
        let info: [String: Any] = ["AIStatusDefaultHost": " https://dummy.example.ts.net ", "AIStatusDefaultToken": "dummy-token-0123456789"]
        expectEqual(BuildDefaults.host(in: info), "https://dummy.example.ts.net", "host read and trimmed")
        expectEqual(BuildDefaults.token(in: info), "dummy-token-0123456789", "token read")
        let unexpanded: [String: Any] = ["AIStatusDefaultHost": "$(AISTATUS_DEFAULT_HOST)", "AIStatusDefaultToken": "$(AISTATUS_DEFAULT_TOKEN)"]
        expectEqual(BuildDefaults.host(in: unexpanded), "", "unexpanded host => empty")
        expectEqual(BuildDefaults.token(in: unexpanded), "", "unexpanded token => empty")
        expectEqual(BuildDefaults.token(in: ["AIStatusDefaultToken": ""]), "", "empty token")
        expectEqual(BuildDefaults.host(in: nil), "", "no Info.plist")
        expectEqual(BuildDefaults.token(in: [:]), "", "missing key")
        let ep = DaemonEndpoint(host: BuildDefaults.host(in: info), port: DaemonEndpoint.defaultPort, token: BuildDefaults.token(in: info))
        expectEqual(ep?.baseURLString, "https://dummy.example.ts.net", "build defaults make an https endpoint")
        expectEqual(ep?.token, "dummy-token-0123456789", "with the built-in token")
        // The xcconfig escape used by scripts/generate.sh: "/" -> "/$()" ("//" is a comment in xcconfig).
        expectEqual("https:/$()/$()dummy.example.ts.net".replacingOccurrences(of: "$()", with: ""), "https://dummy.example.ts.net", "escape round-trips")
    }

    suite("backoff") {
        let b = Backoff()
        expectEqual((0..<7).map { b.delay(attempt: $0, unit: 0.5) }, [1, 2, 4, 8, 16, 30, 30], "exponential, capped at 30 s")
        check(b.delay(attempt: 3, unit: 0) >= 8 * 0.8 - 1e-9 && b.delay(attempt: 3, unit: 0.999_999) <= 8 * 1.2, "±20 % jitter")
        expectEqual(b.delay(attempt: 1000, unit: 0.5), 30, "huge attempt stays capped")
    }

    suite("transitions (haptics)") {
        let r = card("claude:a", .running, started: 1)
        let w = card("claude:a", .waiting, started: 1, waiting: 2)
        let d = card("claude:a", .done, started: 1, finished: 3)
        expectEqual(Transition.between(previous: nil, current: [w]), [], "first snapshot is silent")
        expectEqual(Transition.between(previous: ["claude:a": .running], current: [w]), [.becameWaiting(id: "claude:a")], "running -> waiting")
        expectEqual(Transition.between(previous: ["claude:a": .waiting], current: [d]), [.becameDone(id: "claude:a")], "waiting -> done")
        expectEqual(Transition.between(previous: ["claude:a": .done], current: [d]), [], "unchanged is silent")
        expectEqual(Transition.between(previous: ["claude:a": .done], current: [r]), [], "done -> running is silent")
        expectEqual(Transition.between(previous: [:], current: [d]), [.becameDone(id: "claude:a")], "new card that is already done")
        check(Transition.becameWaiting(id: "").priority > Transition.becameDone(id: "").priority, "waiting outranks done")
    }

    suite("shared snapshot store (widget hand-off)") {
        let suiteName = "aistatus.checks.\(ProcessInfo.processInfo.processIdentifier)"
        let store = SharedSnapshotStore(suiteName: suiteName)
        check(store.usesAppGroup, "named suite used")
        store.clear()
        check(store.load() == nil, "empty initially")
        let s = SharedSnapshot(savedAt: Date(timeIntervalSince1970: 1_000), counts: StatusCounts(running: 1, waiting: 2, done: 3), reachable: true, waitingProjects: ["a"], host: "m.local")
        store.save(s)
        expectEqual(store.load(), s, "round trip")
        var t = s
        t.savedAt = Date()
        check(t.sameContent(as: s), "savedAt ignored for change detection")
        t.counts.done = 0
        check(!t.sameContent(as: s), "count change detected")
        store.clear()
        UserDefaults().removePersistentDomain(forName: suiteName)
        check(!SharedSnapshotStore(suiteName: "group.$(BUNDLE_ID_PREFIX).aistatus").usesAppGroup, "unexpanded build setting => fallback")
        check(!SharedSnapshotStore(suiteName: nil).usesAppGroup, "nil => fallback")
    }
}
