import Foundation

/// Where the daemon lives, built from the three settings the user can edit.
public struct DaemonEndpoint: Hashable, Sendable {
    public static let defaultPort = 7778
    public static let defaultHTTPSPort = 443

    public var host: String
    public var port: Int
    public var token: String?
    /// true for `https://…` hosts (e.g. a Tailscale Funnel URL); plain http otherwise.
    public var secure: Bool

    /// Returns nil when the host is empty or the port is out of range.
    /// The host is normalised with `normalizeHost`. A port in the host field wins
    /// over `port`; an `https://` host without a port uses 443 (the `port`
    /// setting is for the plain-http LAN daemon).
    public init?(host rawHost: String, port: Int = DaemonEndpoint.defaultPort, token: String? = nil) {
        var port = port
        guard let parsed = DaemonEndpoint.normalizeHost(rawHost) else { return nil }
        if let p = parsed.port {
            port = p
        } else if parsed.secure {
            port = DaemonEndpoint.defaultHTTPSPort
        }
        guard (1...65535).contains(port) else { return nil }
        self.host = parsed.host
        self.port = port
        self.secure = parsed.secure
        let t = token?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        self.token = t.isEmpty ? nil : t
    }

    /// Accepts what people actually type on a watch keyboard:
    ///  - "Daniels-MacBook-Air"      -> "Daniels-MacBook-Air.local" (bare name = Bonjour host)
    ///  - "daniels-macbook-air.local." -> trailing dot dropped
    ///  - "http://mac.local:7778/"   -> host "mac.local", port 7778
    ///  - "https://mac.tailnet.ts.net" -> host "mac.tailnet.ts.net", secure (port 443 unless given)
    ///  - "192.168.1.20", "mac.lan", "localhost" are kept as is
    ///  - "fe80::1" / "[fe80::1]:7778" IPv6 literals
    public static func normalizeHost(_ raw: String) -> (host: String, port: Int?, secure: Bool)? {
        var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        var secure = false
        for scheme in ["http://", "https://"] where s.lowercased().hasPrefix(scheme) {
            s.removeFirst(scheme.count)
            secure = scheme == "https://"
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
        return (s, port, secure)
    }

    var isIPv6Literal: Bool { host.contains(":") }

    public var scheme: String { secure ? "https" : "http" }

    /// The port is left out of URLs when it is the scheme's default (https on 443),
    /// so the Host header is exactly what the TLS proxy expects.
    var urlPort: Int? { secure && port == DaemonEndpoint.defaultHTTPSPort ? nil : port }

    /// "http://mac.local:7778", "https://mac.tailnet.ts.net"
    public var baseURLString: String {
        let h = isIPv6Literal ? "[\(host)]" : host
        return "\(scheme)://\(h)" + (urlPort.map { ":\($0)" } ?? "")
    }

    public func url(path: String) -> URL? {
        var c = URLComponents()
        c.scheme = scheme
        if isIPv6Literal {
            c.percentEncodedHost = "[\(host)]"
        } else {
            c.host = host
        }
        c.port = urlPort
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

    /// Every request (plain, dismiss and the SSE stream) goes through here, so the
    /// Bearer token is always sent when one is set.
    public func request(_ url: URL, method: String = "GET", timeout: TimeInterval) -> URLRequest {
        var r = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        r.httpMethod = method
        if let token { r.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return r
    }
}
