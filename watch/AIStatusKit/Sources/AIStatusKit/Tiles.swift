import CoreGraphics
import Foundation

// The watch shows one glanceable screen that splits itself by the number of
// sessions. Everything here is plain logic (no SwiftUI) so it can be checked
// on a Mac: which arrangement, which cards get a tile, where each tile goes,
// and the tap-to-clear state machine.

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

/// The tiles to draw: the most important cards (watch order, see `WatchOrdering`)
/// up to four, plus how many did not fit.
public struct TilePlan<Item> {
    public let arrangement: TileArrangement
    /// Most important first: top to bottom, and left to right within a grid row.
    public let tiles: [Item]
    /// Sessions not shown (the "+N" badge); 0 when everything fits.
    public let overflow: Int

    /// `ordered` must already be in importance order (StatusModel.cards is).
    public init(ordered: [Item]) {
        arrangement = TileArrangement(tileCount: ordered.count)
        tiles = Array(ordered.prefix(TileArrangement.maxTiles))
        overflow = max(0, ordered.count - TileArrangement.maxTiles)
    }
}

extension TilePlan where Item == SessionCard {
    /// Sorts with `WatchOrdering` first: waiting (longest waiting first), then
    /// done (finished longest ago first), then running.
    public init(cards: [SessionCard]) {
        self.init(ordered: WatchOrdering.sorted(cards))
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

extension CardPresentation {
    /// Finished (including interrupted / failed): the only tiles a tap can clear.
    public var isFinished: Bool { tone == .done || tone == .failed }
}

/// Tap-to-clear on the tiles (there is no detail screen):
/// - running / waiting tiles ignore taps;
/// - a finished tile with `dismissPolicy == .swipe` (short task) clears on the first tap;
/// - a finished tile with `.confirm` (long task) is "armed" by the first tap and
///   shows "tap again"; a second tap within `timeout` clears it, otherwise it
///   reverts. Arming another tile disarms the previous one.
public struct TapToClear: Equatable, Sendable {
    public static let defaultTimeout: TimeInterval = 3

    public enum Outcome: Equatable, Sendable {
        /// Nothing happens (running / waiting tile).
        case ignored
        /// Call the dismiss API for this id now.
        case clear(String)
        /// Show "tap again" on this tile until `timeout` passes.
        case armed(String)
    }

    public let timeout: TimeInterval
    public private(set) var armedID: String?
    public private(set) var armedAt: Date?

    public init(timeout: TimeInterval = TapToClear.defaultTimeout) {
        self.timeout = timeout
    }

    public mutating func tap(_ tile: CardPresentation, now: Date) -> Outcome {
        guard tile.isFinished else { return .ignored }
        if tile.dismissPolicy == .swipe {
            if armedID == tile.id { disarm() }
            return .clear(tile.id)
        }
        if isArmed(tile.id, now: now) {
            disarm()
            return .clear(tile.id)
        }
        armedID = tile.id
        armedAt = now
        return .armed(tile.id)
    }

    public func isArmed(_ id: String, now: Date) -> Bool {
        guard armedID == id, let armedAt else { return false }
        return now.timeIntervalSince(armedAt) < timeout
    }

    /// When the armed tile should revert, if any.
    public var expiresAt: Date? { armedAt?.addingTimeInterval(timeout) }

    /// Revert once the timeout has passed. Returns true if something changed.
    @discardableResult
    public mutating func expire(now: Date) -> Bool {
        guard let id = armedID, !isArmed(id, now: now) else { return false }
        disarm()
        return true
    }

    /// Drop the armed state when that tile is gone or no longer finished
    /// (cleared elsewhere, or a new prompt started it again).
    @discardableResult
    public mutating func reconcile(with tiles: [CardPresentation]) -> Bool {
        guard let id = armedID else { return false }
        if tiles.contains(where: { $0.id == id && $0.isFinished }) { return false }
        disarm()
        return true
    }

    public mutating func disarm() {
        armedID = nil
        armedAt = nil
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
