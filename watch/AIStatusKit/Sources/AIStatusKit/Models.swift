import Foundation

// JSON shape of the aistatusd API (see README.md "API" and src/store.js `view()`).
// All timestamps are Unix epoch milliseconds measured on the Mac. Decoding is
// deliberately tolerant: unknown enum strings and missing optional fields never
// fail the whole snapshot.

/// Which coding agent a card belongs to.
public enum AgentTool: Hashable, Sendable, Codable {
    case claude
    case codex
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "claude": self = .claude
        case "codex": self = .codex
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .claude: return "claude"
        case .codex: return "codex"
        case .other(let s): return s
        }
    }

    public var displayName: String {
        switch self {
        case .claude: return "Claude"
        case .codex: return "Codex"
        case .other(let s): return s.prefix(1).uppercased() + s.dropFirst()
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

public enum SessionStatus: Hashable, Sendable, Codable {
    case running
    case waiting
    case done
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "running": self = .running
        case "waiting": self = .waiting
        case "done": self = .done
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .running: return "running"
        case .waiting: return "waiting"
        case .done: return "done"
        case .other(let s): return s
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// How a card may be cleared. Anything unknown is treated as `.confirm` (the safe choice).
public enum DismissPolicy: String, Sendable, Codable {
    case swipe
    case confirm

    public init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DismissPolicy(rawValue: raw) ?? .confirm
    }
}

public enum WaitingReason: Hashable, Sendable, Codable {
    case permission
    case question
    case input
    case other(String)

    public init(rawValue: String) {
        switch rawValue {
        case "permission": self = .permission
        case "question": self = .question
        case "input": self = .input
        default: self = .other(rawValue)
        }
    }

    public var rawValue: String {
        switch self {
        case .permission: return "permission"
        case .question: return "question"
        case .input: return "input"
        case .other(let s): return s
        }
    }

    public init(from decoder: Decoder) throws {
        self.init(rawValue: try decoder.singleValueContainer().decode(String.self))
    }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        try c.encode(rawValue)
    }
}

/// One card, exactly as served by `GET /sessions` (timestamps still in server epoch ms).
public struct SessionCard: Identifiable, Hashable, Sendable, Codable {
    public var id: String
    public var tool: AgentTool
    public var sessionId: String
    public var project: String?
    public var cwd: String?
    public var status: SessionStatus
    public var startedAt: Int64?
    public var startedAtApprox: Bool
    public var finishedAt: Int64?
    public var runDurationMs: Int64?
    public var waitingSince: Int64?
    public var waitingReason: WaitingReason?
    public var lastMessage: String?
    public var dismissPolicy: DismissPolicy
    public var interrupted: Bool
    public var error: String?
    public var ended: Bool
    public var updatedAt: Int64?
    /// Computer the session runs on (daemon >= phase 3; nil from older daemons).
    public var machine: String?

    public init(
        id: String, tool: AgentTool, sessionId: String, project: String? = nil, cwd: String? = nil,
        status: SessionStatus, startedAt: Int64? = nil, startedAtApprox: Bool = false,
        finishedAt: Int64? = nil, runDurationMs: Int64? = nil, waitingSince: Int64? = nil,
        waitingReason: WaitingReason? = nil, lastMessage: String? = nil,
        dismissPolicy: DismissPolicy = .confirm, interrupted: Bool = false, error: String? = nil,
        ended: Bool = false, updatedAt: Int64? = nil, machine: String? = nil
    ) {
        self.id = id
        self.tool = tool
        self.sessionId = sessionId
        self.project = project
        self.cwd = cwd
        self.status = status
        self.startedAt = startedAt
        self.startedAtApprox = startedAtApprox
        self.finishedAt = finishedAt
        self.runDurationMs = runDurationMs
        self.waitingSince = waitingSince
        self.waitingReason = waitingReason
        self.lastMessage = lastMessage
        self.dismissPolicy = dismissPolicy
        self.interrupted = interrupted
        self.error = error
        self.ended = ended
        self.updatedAt = updatedAt
        self.machine = machine
    }

    private enum CodingKeys: String, CodingKey {
        case id, tool, sessionId, project, cwd, status, startedAt, startedAtApprox, finishedAt, runDurationMs
        case waitingSince, waitingReason, lastMessage, dismissPolicy, interrupted, error, ended, updatedAt, machine
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        tool = try c.decodeIfPresent(AgentTool.self, forKey: .tool) ?? .other("unknown")
        sessionId = try c.decodeIfPresent(String.self, forKey: .sessionId) ?? id
        project = try c.decodeIfPresent(String.self, forKey: .project)
        cwd = try c.decodeIfPresent(String.self, forKey: .cwd)
        status = try c.decodeIfPresent(SessionStatus.self, forKey: .status) ?? .other("unknown")
        startedAt = try c.decodeMillisIfPresent(forKey: .startedAt)
        startedAtApprox = try c.decodeIfPresent(Bool.self, forKey: .startedAtApprox) ?? false
        finishedAt = try c.decodeMillisIfPresent(forKey: .finishedAt)
        runDurationMs = try c.decodeMillisIfPresent(forKey: .runDurationMs)
        waitingSince = try c.decodeMillisIfPresent(forKey: .waitingSince)
        waitingReason = try c.decodeIfPresent(WaitingReason.self, forKey: .waitingReason)
        lastMessage = try c.decodeIfPresent(String.self, forKey: .lastMessage)
        dismissPolicy = try c.decodeIfPresent(DismissPolicy.self, forKey: .dismissPolicy) ?? .confirm
        interrupted = try c.decodeIfPresent(Bool.self, forKey: .interrupted) ?? false
        // `error` is a string today; accept anything non-null without failing.
        if let s = try? c.decodeIfPresent(String.self, forKey: .error) {
            error = s
        } else if c.contains(.error), (try? c.decodeNil(forKey: .error)) == false {
            error = "error"
        } else {
            error = nil
        }
        ended = try c.decodeIfPresent(Bool.self, forKey: .ended) ?? false
        updatedAt = try c.decodeMillisIfPresent(forKey: .updatedAt)
        // Optional and tolerant: absent, null or non-string => nil.
        machine = (try? c.decodeIfPresent(String.self, forKey: .machine)) ?? nil
    }

    /// Human name for the card: project, else last path component of cwd, else
    /// the computer it runs on (the cloud hub stores no project names by
    /// default), else a short session id.
    public var displayProject: String {
        if let p = project, !p.isEmpty { return p }
        if let cwd, let last = cwd.split(separator: "/").last { return String(last) }
        if let m = machine, !m.isEmpty { return m }
        return String(sessionId.prefix(8))
    }
}

/// Body of `GET /sessions` and of every SSE `snapshot` event.
public struct Snapshot: Hashable, Sendable, Codable {
    public var version: Int
    public var serverTime: Int64
    public var swipeThresholdSec: Int?
    public var sessions: [SessionCard]

    public init(version: Int = 1, serverTime: Int64, swipeThresholdSec: Int? = nil, sessions: [SessionCard]) {
        self.version = version
        self.serverTime = serverTime
        self.swipeThresholdSec = swipeThresholdSec
        self.sessions = sessions
    }

    private enum CodingKeys: String, CodingKey { case version, serverTime, swipeThresholdSec, sessions }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        version = try c.decodeIfPresent(Int.self, forKey: .version) ?? 1
        serverTime = try c.decodeMillis(forKey: .serverTime)
        swipeThresholdSec = try? c.decodeIfPresent(Int.self, forKey: .swipeThresholdSec)
        // One malformed card must not hide all the others.
        let lossy = try c.decodeIfPresent([Lossy<SessionCard>].self, forKey: .sessions) ?? []
        sessions = lossy.compactMap(\.value)
    }

    public static func decode(_ data: Data) throws -> Snapshot {
        try JSONDecoder().decode(Snapshot.self, from: data)
    }
}

/// `GET /health`.
public struct Health: Hashable, Sendable, Codable {
    public var ok: Bool
    public var name: String?
    public var version: String?
    public var serverTime: Int64?
    public var sessions: Int?

    public init(ok: Bool, name: String? = nil, version: String? = nil, serverTime: Int64? = nil, sessions: Int? = nil) {
        self.ok = ok
        self.name = name
        self.version = version
        self.serverTime = serverTime
        self.sessions = sessions
    }
}

/// `POST /sessions/:id/dismiss` success body.
public struct DismissResponse: Sendable, Decodable {
    public var ok: Bool
    public var dismissed: SessionCard?
}

/// `{"error": "..."}` bodies.
public struct APIErrorBody: Sendable, Decodable {
    public var error: String
}

struct Lossy<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: Decoder) throws {
        value = try? T(from: decoder)
    }
}

extension KeyedDecodingContainer {
    /// Epoch-ms timestamps are integers, but accept a JSON double too (e.g. 1.79e12).
    func decodeMillisIfPresent(forKey key: Key) throws -> Int64? {
        guard contains(key), try !decodeNil(forKey: key) else { return nil }
        if let i = try? decode(Int64.self, forKey: key) { return i }
        if let d = try? decode(Double.self, forKey: key), d.isFinite { return Int64(d.rounded()) }
        return nil
    }

    func decodeMillis(forKey key: Key) throws -> Int64 {
        if let v = try decodeMillisIfPresent(forKey: key) { return v }
        throw DecodingError.dataCorruptedError(forKey: key, in: self, debugDescription: "expected epoch milliseconds")
    }
}
