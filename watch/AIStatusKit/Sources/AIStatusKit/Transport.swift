import Foundation

/// A decoded snapshot together with the local times of the request, for `ClockSync`.
public struct TimedSnapshot: Sendable {
    public var snapshot: Snapshot
    public var sentAt: Date
    public var receivedAt: Date

    public init(snapshot: Snapshot, sentAt: Date, receivedAt: Date) {
        self.snapshot = snapshot
        self.sentAt = sentAt
        self.receivedAt = receivedAt
    }
}

public enum DaemonError: Error, Equatable, Sendable, LocalizedError {
    case invalidEndpoint
    case unauthorized
    case notFound
    case http(status: Int, message: String?)
    case decoding(String)
    case streamEnded
    case timedOut
    case network(String)

    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint: return "Host not set"
        case .unauthorized: return "Wrong or missing token"
        case .notFound: return "Not found"
        case .http(let s, let m): return "HTTP \(s)" + (m.map { ": \($0)" } ?? "")
        case .decoding(let m): return "Bad response: \(m)"
        case .streamEnded: return "Stream closed"
        case .timedOut: return "Timed out"
        case .network(let m): return m
        }
    }

    static func from(_ error: Error) -> DaemonError {
        if let e = error as? DaemonError { return e }
        if let u = error as? URLError {
            switch u.code {
            case .timedOut: return .timedOut
            case .cannotFindHost, .dnsLookupFailed: return .network("Host not found")
            case .cannotConnectToHost: return .network("Connection refused (daemon not running?)")
            case .notConnectedToInternet, .networkConnectionLost: return .network("No network")
            case .appTransportSecurityRequiresSecureConnection: return .network("Blocked by App Transport Security")
            default: return .network(u.localizedDescription)
            }
        }
        return .network(error.localizedDescription)
    }
}

/// What the feed and the view model need from the daemon. The real one is
/// `URLSessionTransport`; tests use a scripted fake.
public protocol DaemonTransport: Sendable {
    func fetchSnapshot() async throws -> TimedSnapshot
    /// SSE: one element per `snapshot` event. Ends (or throws) when the connection drops.
    func snapshotStream() -> AsyncThrowingStream<TimedSnapshot, Error>
    /// Returns normally on success and when the card is already gone (404).
    func dismiss(id: String) async throws
    func health() async throws -> Health
}

public final class URLSessionTransport: DaemonTransport, @unchecked Sendable {
    public let endpoint: DaemonEndpoint
    let session: URLSession
    /// Timeout for plain requests.
    public var requestTimeout: TimeInterval = 8
    /// Idle timeout for the SSE stream. The daemon pings every 15 s, so silence
    /// longer than this means the connection is dead.
    public var streamIdleTimeout: TimeInterval = 40

    public init(endpoint: DaemonEndpoint, session: URLSession? = nil) {
        self.endpoint = endpoint
        if let session {
            self.session = session
        } else {
            let cfg = URLSessionConfiguration.ephemeral
            cfg.waitsForConnectivity = false
            cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
            cfg.timeoutIntervalForRequest = 40
            cfg.httpMaximumConnectionsPerHost = 4
            self.session = URLSession(configuration: cfg)
        }
    }

    private func check(_ response: URLResponse, body: Data?) throws {
        guard let http = response as? HTTPURLResponse else { throw DaemonError.decoding("not HTTP") }
        switch http.statusCode {
        case 200..<300: return
        case 401: throw DaemonError.unauthorized
        case 404: throw DaemonError.notFound
        default:
            let msg = body.flatMap { try? JSONDecoder().decode(APIErrorBody.self, from: $0).error }
            throw DaemonError.http(status: http.statusCode, message: msg)
        }
    }

    public func fetchSnapshot() async throws -> TimedSnapshot {
        guard let url = endpoint.sessionsURL else { throw DaemonError.invalidEndpoint }
        let sent = Date()
        do {
            let (data, resp) = try await session.data(for: endpoint.request(url, timeout: requestTimeout))
            let received = Date()
            try check(resp, body: data)
            do {
                return TimedSnapshot(snapshot: try Snapshot.decode(data), sentAt: sent, receivedAt: received)
            } catch {
                throw DaemonError.decoding(String(describing: error))
            }
        } catch {
            throw DaemonError.from(error)
        }
    }

    public func health() async throws -> Health {
        guard let url = endpoint.healthURL else { throw DaemonError.invalidEndpoint }
        do {
            let (data, resp) = try await session.data(for: endpoint.request(url, timeout: requestTimeout))
            try check(resp, body: data)
            return try JSONDecoder().decode(Health.self, from: data)
        } catch {
            throw DaemonError.from(error)
        }
    }

    public func dismiss(id: String) async throws {
        guard let url = endpoint.dismissURL(id: id) else { throw DaemonError.invalidEndpoint }
        var req = endpoint.request(url, method: "POST", timeout: requestTimeout)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = Data("{}".utf8)
        do {
            let (data, resp) = try await session.data(for: req)
            try check(resp, body: data)
        } catch DaemonError.notFound {
            return // already gone: that is what we wanted
        } catch {
            throw DaemonError.from(error)
        }
    }

    public func snapshotStream() -> AsyncThrowingStream<TimedSnapshot, Error> {
        let endpoint = self.endpoint
        let session = self.session
        let idle = streamIdleTimeout
        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    guard let url = endpoint.eventsURL else { throw DaemonError.invalidEndpoint }
                    var req = endpoint.request(url, timeout: idle)
                    req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                    let (bytes, resp) = try await session.bytes(for: req)
                    try self.check(resp, body: nil)
                    var parser = SSEParser()
                    for try await byte in bytes {
                        guard let event = parser.push(byte) else { continue }
                        guard event.event == "snapshot" || event.event == "message" else { continue }
                        let received = Date()
                        do {
                            let snap = try Snapshot.decode(Data(event.data.utf8))
                            continuation.yield(TimedSnapshot(snapshot: snap, sentAt: received, receivedAt: received))
                        } catch {
                            throw DaemonError.decoding(String(describing: error))
                        }
                    }
                    continuation.finish(throwing: DaemonError.streamEnded)
                } catch is CancellationError {
                    continuation.finish()
                } catch {
                    if Task.isCancelled { continuation.finish() } else { continuation.finish(throwing: DaemonError.from(error)) }
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
