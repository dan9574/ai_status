import AIStatusKit
import Foundation

/// Records every request URLSessionTransport makes and answers from fixtures,
/// so the real request-building code (URL, scheme, Bearer header) is exercised.
final class RecordingURLProtocol: URLProtocol {
    private static let lock = NSLock()
    nonisolated(unsafe) private static var _requests: [URLRequest] = []

    static var requests: [URLRequest] {
        lock.lock(); defer { lock.unlock() }
        return _requests
    }

    static func reset() {
        lock.lock(); _requests = []; lock.unlock()
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.lock.lock(); Self._requests.append(request); Self.lock.unlock()
        let path = request.url?.path ?? ""
        var type = "application/json"
        let body: Data
        // Match the last segment: endpoints may have a base path (cloud hub).
        let route = path.hasSuffix("/dismiss") ? "dismiss" : String(path.split(separator: "/").last ?? "")
        switch route {
        case "sessions": body = (try? fixture("sessions-mixed.json")) ?? Data()
        case "health": body = (try? fixture("health.json")) ?? Data()
        case "events":
            type = "text/event-stream"
            let json = (try? fixture("sessions-empty.json")).flatMap { String(data: $0, encoding: .utf8) } ?? "{}"
            let oneLine = json.replacingOccurrences(of: "\n", with: "")
            body = Data("event: snapshot\ndata: \(oneLine)\n\n".utf8)
        default: body = (try? fixture("dismiss-ok.json")) ?? Data()
        }
        let resp = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": type])!
        client?.urlProtocol(self, didReceive: resp, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: body)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

func runTransportChecks() async {
    await asyncSuite("transport: https endpoint sends the Bearer token on every request (incl. SSE)") {
        RecordingURLProtocol.reset()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        let session = URLSession(configuration: cfg)
        let ep = DaemonEndpoint(host: "https://dummy-host.example.ts.net", token: "dummy-token-0123456789")!
        let t = URLSessionTransport(endpoint: ep, session: session)

        _ = try await t.health()
        _ = try await t.fetchSnapshot()
        try await t.dismiss(id: "codex@WIN:abc")
        var frames = 0
        for try await _ in t.snapshotStream() {
            frames += 1
            break
        }
        expectEqual(frames, 1, "SSE snapshot decoded")

        let reqs = RecordingURLProtocol.requests
        expectEqual(reqs.map { $0.url?.path ?? "" }, ["/health", "/sessions", "/sessions/codex@WIN:abc/dismiss", "/events"], "all four request kinds made")
        for r in reqs {
            let what = "\(r.httpMethod ?? "?") \(r.url?.absoluteString ?? "nil")"
            expectEqual(r.url?.scheme, "https", "https: \(what)")
            expectEqual(r.url?.host, "dummy-host.example.ts.net", "host: \(what)")
            expectEqual(r.url?.port, nil, "no explicit port (443): \(what)")
            expectEqual(r.value(forHTTPHeaderField: "Authorization"), "Bearer dummy-token-0123456789", "Bearer token: \(what)")
            check(r.url?.query == nil, "token never in the query: \(what)")
        }
        expectEqual(reqs.last?.value(forHTTPHeaderField: "Accept"), "text/event-stream", "SSE Accept header")
        expectEqual(reqs.first { $0.url?.path.hasSuffix("/dismiss") == true }?.httpMethod, "POST", "dismiss is a POST")
    }

    await asyncSuite("transport: base URL with a path (cloud hub): every request under the path") {
        RecordingURLProtocol.reset()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        let ep = DaemonEndpoint(host: "https://abcdefgh.supabase.co/functions/v1/aistatus", token: "dummy-token-0123456789")!
        let t = URLSessionTransport(endpoint: ep, session: URLSession(configuration: cfg))
        _ = try await t.health()
        let snap = try await t.fetchSnapshot()
        try await t.dismiss(id: "codex@WIN:abc")
        expectEqual(snap.snapshot.sessions.count, 8, "decoded")
        let reqs = RecordingURLProtocol.requests
        expectEqual(reqs.map { $0.url?.path ?? "" }, ["/functions/v1/aistatus/health", "/functions/v1/aistatus/sessions", "/functions/v1/aistatus/sessions/codex@WIN:abc/dismiss"], "paths under the base path")
        check(reqs.allSatisfy { $0.url?.host == "abcdefgh.supabase.co" && $0.value(forHTTPHeaderField: "Authorization") == "Bearer dummy-token-0123456789" }, "host + Bearer on every request")
    }

    await asyncSuite("transport: no token => no Authorization header") {
        RecordingURLProtocol.reset()
        let cfg = URLSessionConfiguration.ephemeral
        cfg.protocolClasses = [RecordingURLProtocol.self]
        let t = URLSessionTransport(endpoint: DaemonEndpoint(host: "mymac.local")!, session: URLSession(configuration: cfg))
        _ = try await t.fetchSnapshot()
        let r = RecordingURLProtocol.requests.first
        expectEqual(r?.url?.absoluteString, "http://mymac.local:7778/sessions", "plain http LAN URL unchanged")
        expectEqual(r?.value(forHTTPHeaderField: "Authorization"), nil, "no Authorization header")
    }
}
