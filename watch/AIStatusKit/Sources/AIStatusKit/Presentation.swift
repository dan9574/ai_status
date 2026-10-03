import Foundation

/// Watch ordering: waiting first (longest-waiting first), then done (oldest
/// finished first, i.e. the one idling longest), then running (longest-running
/// first), anything unknown last. Ties fall back to start time, then id, so the
/// order is total and stable across snapshots.
///
/// Note this intentionally differs from the daemon's own order
/// (waiting → running → done): on the wrist, finished work needs action, running
/// work does not.
public enum WatchOrdering {
    public static func rank(_ s: SessionStatus) -> Int {
        switch s {
        case .waiting: return 0
        case .done: return 1
        case .running: return 2
        case .other: return 3
        }
    }

    static func key(_ c: SessionCard) -> Int64 {
        switch c.status {
        case .waiting: return c.waitingSince ?? c.startedAt ?? c.updatedAt ?? .max
        case .done: return c.finishedAt ?? c.updatedAt ?? .max
        case .running: return c.startedAt ?? c.updatedAt ?? .max
        case .other: return c.updatedAt ?? .max
        }
    }

    public static func sorted(_ cards: [SessionCard]) -> [SessionCard] {
        cards.sorted { a, b in
            let ra = rank(a.status), rb = rank(b.status)
            if ra != rb { return ra < rb }
            let ka = key(a), kb = key(b)
            if ka != kb { return ka < kb }
            let sa = a.startedAt ?? .max, sb = b.startedAt ?? .max
            if sa != sb { return sa < sb }
            return a.id < b.id
        }
    }
}

/// Everything a card view needs, with server timestamps already converted to
/// local `Date`s. Views render the dates with `Text(date, style: .timer)`, so
/// nothing has to poll to keep the clocks moving.
public struct CardPresentation: Identifiable, Hashable, Sendable {
    public enum Tone: Hashable, Sendable { case running, waiting, done, failed, unknown }

    public var id: String
    public var tool: AgentTool
    public var project: String
    public var tone: Tone
    /// "Running", "Needs approval", "Done", "Interrupted", …
    public var headline: String
    /// Label shown before the ticking timer ("for", "waiting", "idle").
    public var timerLabel: String?
    /// Start of the ticking timer (counts up from this local date), if any.
    public var timerStart: Date?
    /// Static detail, e.g. "ran 4m 10s" for done cards.
    public var detail: String?
    public var message: String?
    public var dismissPolicy: DismissPolicy
    /// The start time was reconstructed by the daemon (it missed the prompt).
    public var approximate: Bool

    public init(card: SessionCard, clock: ClockSync) {
        id = card.id
        tool = card.tool
        project = card.displayProject
        dismissPolicy = card.dismissPolicy
        approximate = card.startedAtApprox
        message = card.lastMessage
        detail = nil
        timerLabel = nil
        timerStart = nil

        switch card.status {
        case .running:
            tone = .running
            headline = "Running"
            timerLabel = approximate ? "for ~" : "for"
            timerStart = clock.localDate(serverMs: card.startedAt ?? card.updatedAt)
        case .waiting:
            tone = .waiting
            switch card.waitingReason {
            case .permission?: headline = "Needs approval"
            case .question?: headline = "Has a question"
            default: headline = "Needs input"
            }
            timerLabel = "waiting"
            timerStart = clock.localDate(serverMs: card.waitingSince ?? card.updatedAt)
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
            timerLabel = "idle"
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
