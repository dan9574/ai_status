import Foundation

/// Where the daemon lives, built from the three settings the user can edit.
public struct DaemonEndpoint: Hashable, Sendable {
    public static let defaultPort = 7778

    public var host: String
    public var port: Int
    public var token: String?

    /// Returns nil when the host is empty or the port is out of range.
    /// The host is normalised with `normalizeHost`.
    public init?(host rawHost: String, port: Int = DaemonEndpoint.defaultPort, token: String? = nil) {
        var port = port
        guard let parsed = DaemonEndpoint.normalizeHost(rawHost) else { return nil }
        if let p = parsed.port { port = p }
        guard (1...65535).contains(port) else { return nil }
        self.host = parsed.host
        self.port = port
        let t = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.token = t.isEmpty ? nil : t
    }

    /// Accepts what people actually type on a watch keyboard:
    ///  - "Daniels-MacBook-Air"      -> "Daniels-MacBook-Air.local" (bare name = Bonjour host)
    ///  - "daniels-macbook-air.local." -> trailing dot dropped
    ///  - "http://mac.local:7778/"   -> host "mac.local", port 7778
    ///  - "192.168.1.20", "mac.lan", "localhost" are kept as is
    ///  - "fe80::1" / "[fe80::1]:7778" IPv6 literals
    public static func normalizeHost(_ raw: String) -> (host: String, port: Int?)? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        for scheme in ["http://", "https://"] where s.lowercased().hasPrefix(scheme) {
            s.removeFirst(scheme.count)
        }
        if let slash = s.firstIndex(of: "/") { s = String(s[..<slash]) }
        if let at = s.lastIndex(of: "@") { s = String(s[s.index(after: at)...]) } // user@host
        var port: Int?
        if s.hasPrefix("[") {
            // [v6]:port
            guard let close = s.firstIndex(of: "]") else { return nil }
            let rest = s[s.index(after: close)...]
            if rest.hasPrefix(":") { port = Int(rest.dropFirst()) }
            s = String(s[s.index(after: s.startIndex)..<close])
        } else if s.filter({ $0 == ":" }).count == 1, let colon = s.firstIndex(of: ":") {
            port = Int(s[s.index(after: colon)...])
            s = String(s[..<colon])
        }
        while s.hasSuffix(".") { s.removeLast() }
        s = s.replacingOccurrences(of: " ", with: "-") // watch keyboards like spaces; hostnames do not
        guard !s.isEmpty else { return nil }
        let isIPv6 = s.contains(":")
        let isIPv4 = s.split(separator: ".").count == 4 && s.split(separator: ".").allSatisfy { UInt8($0) != nil }
        if !isIPv6, !isIPv4, !s.contains("."), s.lowercased() != "localhost" {
            s += ".local"
        }
        return (s, port)
    }

    var isIPv6Literal: Bool { host.contains(":") }

    /// "http://mac.local:7778"
    public var baseURLString: String {
        "http://\(isIPv6Literal ? "[\(host)]" : host):\(port)"
    }

    public func url(path: String) -> URL? {
        var c = URLComponents()
        c.scheme = "http"
        if isIPv6Literal {
            c.percentEncodedHost = "[\(host)]"
        } else {
            c.host = host
        }
        c.port = port
        c.percentEncodedPath = path
        return c.url
    }

    public var sessionsURL: URL? { url(path: "/sessions") }
    public var eventsURL: URL? { url(path: "/events") }
    public var healthURL: URL? { url(path: "/health") }

    /// `POST /sessions/<id>/dismiss` with the id fully percent-encoded (`claude:…` -> `claude%3A…`).
    public func dismissURL(id: String) -> URL? {
        var allowed = CharacterSet.alphanumerics
        allowed.insert(charactersIn: "-._~")
        guard let enc = id.addingPercentEncoding(withAllowedCharacters: allowed) else { return nil }
        return url(path: "/sessions/\(enc)/dismiss")
    }

    func request(_ url: URL, method: String = "GET", timeout: TimeInterval) -> URLRequest {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = method
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return r
    }
}
