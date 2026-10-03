import CoreGraphics
import Foundation

// The watch shows one glanceable screen that splits itself by the number of
// sessions. Everything here is plain logic (no SwiftUI) so it can be checked
// on a Mac: which arrangement, which cards get a tile, where each tile goes,
// what each tile says, and the swipe-to-delete state machine.

/// How the screen is cut.
public enum TileArrangement: Equatable, Sendable {
    /// No sessions: quiet empty state.
    case empty
    /// One session fills the screen.
    case single
    /// 2 or 3 sessions: horizontal cuts, stacked top to bottom.
    case rows(Int)
    /// 4 or more sessions: 2×2 grid (the rest are counted in a "+N" badge).
    case grid

    public static let maxTiles = 4

    public init(tileCount: Int) {
        switch tileCount {
        case ..<1: self = .empty
        case 1: self = .single
        case 2, 3: self = .rows(tileCount)
        default: self = .grid
        }
    }

    public var rows: Int {
        switch self {
        case .empty: return 0
        case .single: return 1
        case .rows(let n): return n
        case .grid: return 2
        }
    }

    public var columns: Int {
        switch self {
        case .empty: return 0
        case .single, .rows: return 1
        case .grid: return 2
        }
    }

    public var capacity: Int { rows * columns }
}

/// The tiles to draw: the first four sessions in stable order (see
/// `SessionOrder`), plus how many did not fit.
public struct TilePlan<Item> {
    public let arrangement: TileArrangement
    /// Top to bottom, and left to right within a grid row.
    public let tiles: [Item]
    /// Sessions not shown (the "+N" badge); 0 when everything fits.
    public let overflow: Int

    /// `ordered` must already be in tile order (StatusModel.cards is).
    public init(ordered: [Item]) {
        arrangement = TileArrangement(tileCount: ordered.count)
        tiles = Array(ordered.prefix(TileArrangement.maxTiles))
        overflow = max(0, ordered.count - TileArrangement.maxTiles)
    }
}

extension TilePlan where Item == SessionCard {
    /// Orders with `order` first (by default: start time, oldest first).
    public init(cards: [SessionCard], order: SessionOrder = SessionOrder()) {
        self.init(ordered: order.sorted(cards))
    }
}

/// One tile's place on screen. `frame` is the painted area (edge to edge, the
/// outer tiles reach into the system's safe-area insets); `content` is where
/// text may go (inside the safe area, away from the clock).
public struct TileSlot: Equatable, Sendable {
    public var frame: CGRect
    public var content: CGRect

    public init(frame: CGRect, content: CGRect) {
        self.frame = frame
        self.content = content
    }
}

/// Safe-area insets, in points (SwiftUI's EdgeInsets without the SwiftUI import).
public struct TileInsets: Equatable, Sendable {
    public var top: CGFloat
    public var leading: CGFloat
    public var bottom: CGFloat
    public var trailing: CGFloat

    public init(top: CGFloat = 0, leading: CGFloat = 0, bottom: CGFloat = 0, trailing: CGFloat = 0) {
        self.top = top
        self.leading = leading
        self.bottom = bottom
        self.trailing = trailing
    }

    public static let zero = TileInsets()
}

public enum TileGeometry {
    /// Thin black divider between tiles.
    public static let gap: CGFloat = 2

    /// Cut the safe area into equal cells (so every tile gets the same room for
    /// text), then stretch the outermost cells to the screen edges so colour
    /// fills the whole display. Row-major, matching `TilePlan.tiles`.
    public static func slots(
        for arrangement: TileArrangement, in size: CGSize, insets: TileInsets = .zero, gap: CGFloat = TileGeometry.gap
    ) -> [TileSlot] {
        let rows = arrangement.rows, cols = arrangement.columns
        guard rows > 0, cols > 0, size.width > 0, size.height > 0 else { return [] }
        let safe = CGRect(
            x: insets.leading, y: insets.top,
            width: max(0, size.width - insets.leading - insets.trailing),
            height: max(0, size.height - insets.top - insets.bottom)
        )
        let cellW = max(0, (safe.width - gap * CGFloat(cols - 1)) / CGFloat(cols))
        let cellH = max(0, (safe.height - gap * CGFloat(rows - 1)) / CGFloat(rows))
        var out: [TileSlot] = []
        for r in 0..<rows {
            for c in 0..<cols {
                let content = CGRect(
                    x: safe.minX + CGFloat(c) * (cellW + gap),
                    y: safe.minY + CGFloat(r) * (cellH + gap),
                    width: cellW, height: cellH
                )
                let minX = c == 0 ? 0 : content.minX
                let maxX = c == cols - 1 ? size.width : content.maxX
                let minY = r == 0 ? 0 : content.minY
                let maxY = r == rows - 1 ? size.height : content.maxY
                out.append(TileSlot(frame: CGRect(x: minX, y: minY, width: maxX - minX, height: maxY - minY), content: content))
            }
        }
        return out
    }
}

/// What a tile says on its second line: a status word and a counting timer,
/// `run · 12:34` / `ask · 0:41` / `done · 3:02` (`run 12:34` when compact).
public enum TileLabel {
    /// run (running), ask (waiting for approval / input), done (finished,
    /// interrupted or failed).
    public static func word(_ tone: CardPresentation.Tone) -> String {
        switch tone {
        case .running: return "run"
        case .waiting: return "ask"
        case .done, .failed: return "done"
        case .unknown: return "?"
        }
    }

    /// Full second line for `elapsed` seconds since `timerStart`. `compact` drops
    /// the dot (2×2 grid); `coarse` uses whole minutes (Always-On).
    public static func status(_ tone: CardPresentation.Tone, elapsed: TimeInterval?, compact: Bool = false, coarse: Bool = false) -> String {
        let w = word(tone)
        guard let elapsed else { return w }
        let time = coarse ? CoarseDuration.format(elapsed) : ElapsedClock.format(elapsed)
        return w + (compact ? " " : " · ") + time
    }
}

/// Stopwatch text, like SwiftUI's `.timer` style: 0:41 · 12:34 · 1:05:12, and
/// 1d 2h past a day (a seconds clock that long is noise).
public enum ElapsedClock {
    public static func format(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        let h = s / 3600, m = (s % 3600) / 60, sec = s % 60
        if h >= 24 { return "\(h / 24)d \(h % 24)h" }
        if h > 0 { return "\(h):\(pad(m)):\(pad(sec))" }
        return "\(m):\(pad(sec))"
    }

    private static func pad(_ v: Int) -> String { v < 10 ? "0\(v)" : "\(v)" }
}

/// Swipe left on a tile to reveal a trash button on its right; tap the trash to
/// delete the session. The only way to delete from the watch.
/// - One tile open at a time: dragging another tile closes the open one.
/// - Swiping right, tapping anywhere else, or `timeout` seconds without touching
///   it closes the open tile. A tap that closes a tile does nothing else.
/// - Tapping a tile while nothing is open asks for its detail screen.
/// Also tracks the live drag so the tile offset can be computed (and checked)
/// without SwiftUI.
public struct SwipeReveal: Equatable, Sendable {
    public static let defaultTimeout: TimeInterval = 4

    public enum TapOutcome: Equatable, Sendable {
        /// Show this session's detail screen.
        case showDetail(String)
        /// The tap only closed the open tile.
        case closed
        /// Delete this session now (optimistic dismiss).
        case delete(String)
        /// Nothing to do (e.g. a stale trash tap after the tile closed).
        case ignored
    }

    public let timeout: TimeInterval
    /// The tile showing its trash button.
    public private(set) var openID: String?
    /// When it opened (closes `timeout` after).
    public private(set) var openedAt: Date?
    /// Tile under the finger and its horizontal drag so far.
    public private(set) var dragID: String?
    public private(set) var dragX: CGFloat = 0
    /// When the last drag ended: a tap reported for the same touch is ignored.
    public private(set) var dragEndedAt: Date?
    public static let tapAfterDragGrace: TimeInterval = 0.35

    public init(timeout: TimeInterval = SwipeReveal.defaultTimeout) {
        self.timeout = timeout
    }

    /// Width of the trash button for a tile of `tileWidth` points: half a narrow
    /// grid tile, at most 60 pt on a full-width tile.
    public static func revealWidth(tileWidth: CGFloat) -> CGFloat {
        max(0, min(60, (tileWidth * 0.5).rounded()))
    }

    /// How far past fully open the tile may be pulled while dragging.
    public static let overshoot: CGFloat = 10

    /// Finger moved. Mostly vertical movement before a drag has begun is not a
    /// swipe and is ignored. Starting to drag a tile closes any other open tile.
    public mutating func dragChanged(_ id: String, dx: CGFloat, dy: CGFloat) {
        if dragID != id {
            guard abs(dx) > abs(dy) else { return }
            if let open = openID, open != id { close() }
            dragID = id
        }
        dragX = dx
    }

    /// Finger lifted. Opens when the tile would come to rest (using the predicted
    /// end of a flick) more than half-way open; otherwise closes. Returns whether
    /// the tile is now open.
    @discardableResult
    public mutating func dragEnded(_ id: String, predictedDX: CGFloat, revealWidth: CGFloat, now: Date) -> Bool {
        guard dragID == id else { return openID == id }
        let base: CGFloat = openID == id ? -revealWidth : 0
        dragID = nil
        dragX = 0
        dragEndedAt = now
        if revealWidth > 0, base + predictedDX < -revealWidth / 2 {
            openID = id
            openedAt = now
            return true
        }
        if openID == id { close() }
        return false
    }

    /// The system cancelled the touch (no end event): snap back to the resting
    /// position without opening or closing anything.
    public mutating func dragCancelled(_ id: String) {
        guard dragID == id else { return }
        dragID = nil
        dragX = 0
    }

    /// Horizontal offset of the tile's content (0 = closed, -revealWidth = open),
    /// following the finger during a drag, clamped to [-(revealWidth + overshoot), 0].
    public func offset(for id: String, revealWidth: CGFloat) -> CGFloat {
        let base: CGFloat = openID == id ? -revealWidth : 0
        guard dragID == id else { return base }
        return min(0, max(-(revealWidth + Self.overshoot), base + dragX))
    }

    public func isOpen(_ id: String) -> Bool { openID == id }

    /// Tap on a tile's body. Ignored while dragging or right after a drag (the
    /// same touch), so a swipe never also opens the detail screen.
    public mutating func tapTile(_ id: String, now: Date) -> TapOutcome {
        if dragID != nil { return .ignored }
        if let end = dragEndedAt, now.timeIntervalSince(end) < Self.tapAfterDragGrace { return .ignored }
        if openID != nil {
            close()
            return .closed
        }
        return .showDetail(id)
    }

    /// Tap on the trash button of `id`.
    public mutating func tapTrash(_ id: String) -> TapOutcome {
        guard openID == id else { return .ignored }
        close()
        return .delete(id)
    }

    /// Tap on the background / long press: close whatever is open.
    @discardableResult
    public mutating func close() -> Bool {
        let changed = openID != nil
        openID = nil
        openedAt = nil
        return changed
    }

    /// When the open tile closes by itself, if any.
    public var expiresAt: Date? { openedAt?.addingTimeInterval(timeout) }

    /// Close once `timeout` has passed (not while the finger is on it).
    @discardableResult
    public mutating func expire(now: Date) -> Bool {
        guard let openedAt, dragID != openID, now.timeIntervalSince(openedAt) >= timeout else { return false }
        return close()
    }

    /// Forget tiles that are no longer on screen (deleted elsewhere, pushed past
    /// the first four).
    @discardableResult
    public mutating func reconcile(visible ids: [String]) -> Bool {
        if let d = dragID, !ids.contains(d) {
            dragID = nil
            dragX = 0
        }
        guard let open = openID, !ids.contains(open) else { return false }
        return close()
    }
}

/// Minute-resolution durations for Always-On, where the screen refreshes about
/// once a minute and a seconds timer would sit frozen: <1m · 12m · 1h 05m · 2d 3h.
public enum CoarseDuration {
    public static func format(_ seconds: TimeInterval) -> String {
        let m = max(0, Int(seconds.rounded(.down))) / 60
        if m < 1 { return "<1m" }
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h " + (m % 60 < 10 ? "0" : "") + "\(m % 60)m" }
        return "\(h / 24)d \(h % 24)h"
    }
}
