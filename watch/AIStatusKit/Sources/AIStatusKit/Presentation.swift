import Foundation

/// Stable tile order: every session keeps its place on the watch while it is
/// visible, so a glance can count finished tiles without tracking moves.
///
/// Sessions are ordered by when they started (oldest first, ties by id). The
/// daemon only reports the start of the *current* run (`startedAt` moves when a
/// new prompt starts), so the first start time seen for an id is remembered and
/// used for as long as the session stays on the daemon's list; a status change
/// or a new run never moves a tile. A session that disappears (cleared) and
/// comes back later is new and goes by its new start time.
public struct SessionOrder: Equatable, Sendable {
    private var keys: [String: Int64] = [:]

    public init() {}

    /// Best known start of a session: run start, else when it started waiting /
    /// finished / last changed; unknown sorts last.
    public static func startKey(_ c: SessionCard) -> Int64 {
        c.startedAt ?? c.waitingSince ?? c.finishedAt ?? c.updatedAt ?? .max
    }

    /// Remember the start of sessions seen for the first time and forget the ones
    /// the daemon no longer reports. Pass the full server list (including cards
    /// hidden by a pending dismiss, so a failed dismiss restores the tile in place).
    public mutating func update(with cards: [SessionCard]) {
        var next: [String: Int64] = [:]
        for c in cards { next[c.id] = keys[c.id] ?? next[c.id] ?? Self.startKey(c) }
        keys = next
    }

    public mutating func reset() {
        keys = [:]
    }

    public func key(_ c: SessionCard) -> Int64 {
        keys[c.id] ?? Self.startKey(c)
    }

    /// Oldest first; ties broken by id so the order is total.
    public func sorted(_ cards: [SessionCard]) -> [SessionCard] {
        cards.sorted { a, b in
            let ka = key(a), kb = key(b)
            if ka != kb { return ka < kb }
            return a.id < b.id
        }
    }
}

/// Everything a tile or the detail screen needs, with server timestamps already
/// converted to local `Date`s. Views count up from `timerStart` themselves, so
/// nothing has to poll to keep the clocks moving.
public struct CardPresentation: Identifiable, Hashable, Sendable {
    public enum Tone: Hashable, Sendable { case running, waiting, done, failed, unknown }

    public var id: String
    public var tool: AgentTool
    public var project: String
    public var tone: Tone
    /// Detail screen: "Running", "Needs approval", "Done", "Interrupted", …
    public var headline: String
    /// Start of the ticking timer: run start (running), waiting start (waiting),
    /// finish time (done). Nil only for unknown statuses.
    public var timerStart: Date?
    /// Static detail for the detail screen, e.g. "ran 4m 10s" for done cards.
    public var detail: String?
    public var message: String?
    /// The start time was reconstructed by the daemon (it missed the prompt).
    public var approximate: Bool

    public init(card: SessionCard, clock: ClockSync) {
        id = card.id
        tool = card.tool
        project = card.displayProject
        approximate = card.startedAtApprox
        message = card.lastMessage
        detail = nil
        timerStart = nil

        switch card.status {
        case .running:
            tone = .running
            headline = "Running"
            timerStart = clock.localDate(serverMs: card.startedAt ?? card.updatedAt)
            if approximate { detail = "start time approximate" }
        case .waiting:
            tone = .waiting
            switch card.waitingReason {
            case .permission?: headline = "Needs approval"
            case .question?: headline = "Has a question"
            default: headline = "Needs input"
            }
            timerStart = clock.localDate(serverMs: card.waitingSince ?? card.startedAt ?? card.updatedAt)
            if let started = card.startedAt, let since = card.waitingSince, since >= started {
                detail = "ran \(DurationFormat.short(ms: since - started)) before"
            }
        case .done:
            if card.error != nil {
                tone = .failed
                headline = "Failed"
            } else if card.interrupted {
                tone = .done
                headline = "Interrupted"
            } else {
                tone = .done
                headline = "Done"
            }
            timerStart = clock.localDate(serverMs: card.finishedAt ?? card.updatedAt)
            if let ms = card.runDurationMs {
                detail = (approximate ? "ran ~" : "ran ") + DurationFormat.short(ms: ms)
            } else {
                detail = "run time unknown"
            }
            if let err = card.error, message == nil { message = err }
        case .other(let raw):
            tone = .unknown
            headline = raw.capitalized
        }
    }
}

/// Counts shown by the widget / complication.
public struct StatusCounts: Hashable, Sendable, Codable {
    public var running: Int
    public var waiting: Int
    public var done: Int

    public init(running: Int = 0, waiting: Int = 0, done: Int = 0) {
        self.running = running
        self.waiting = waiting
        self.done = done
    }

    public init(cards: [SessionCard]) {
        self.init()
        for c in cards {
            switch c.status {
            case .running: running += 1
            case .waiting: waiting += 1
            case .done: done += 1
            case .other: break
            }
        }
    }

    public var total: Int { running + waiting + done }
}
