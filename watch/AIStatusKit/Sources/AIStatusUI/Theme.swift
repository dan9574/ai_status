import AIStatusKit
import SwiftUI

extension AgentTool {
    /// Tiny tool marker on a tile: Claude = sparkle, Codex = </>. Monochrome so
    /// it reads on every tile colour; the shape alone tells them apart.
    var tileSymbol: String {
        switch self {
        case .claude: return "sparkle"
        case .codex: return "chevron.left.forwardslash.chevron.right"
        case .other: return "cpu"
        }
    }
}

/// Colours of one tile. Running = grey (calm), done = green, waiting = orange.
/// With Always-On (luminance reduced) the fills drop to dark shades and the text
/// takes the hue, so the screen stays readable without lighting up the wrist.
struct TileStyle {
    var fill: Color
    var text: Color
    var secondary: Color

    static func of(_ tone: CardPresentation.Tone, dimmed: Bool) -> TileStyle {
        switch (tone, dimmed) {
        case (.waiting, false):
            return TileStyle(fill: Color(red: 1.0, green: 0.58, blue: 0.0), text: .black, secondary: .black.opacity(0.6))
        case (.waiting, true):
            return TileStyle(fill: Color(red: 0.30, green: 0.16, blue: 0.0), text: Color(red: 1.0, green: 0.72, blue: 0.4), secondary: Color(red: 1.0, green: 0.72, blue: 0.4).opacity(0.7))
        case (.done, false), (.failed, false):
            return TileStyle(fill: Color(red: 0.19, green: 0.78, blue: 0.35), text: .black, secondary: .black.opacity(0.6))
        case (.done, true), (.failed, true):
            return TileStyle(fill: Color(red: 0.0, green: 0.22, blue: 0.08), text: Color(red: 0.5, green: 0.92, blue: 0.6), secondary: Color(red: 0.5, green: 0.92, blue: 0.6).opacity(0.7))
        case (_, false):
            return TileStyle(fill: Color(white: 0.24), text: .white, secondary: .white.opacity(0.6))
        case (_, true):
            return TileStyle(fill: Color(white: 0.11), text: .white.opacity(0.75), secondary: .white.opacity(0.5))
        }
    }

    /// A long-task done tile after the first tap ("tap again to clear").
    static func armed(dimmed: Bool) -> TileStyle {
        dimmed
            ? TileStyle(fill: Color(red: 0.0, green: 0.12, blue: 0.04), text: .white.opacity(0.8), secondary: .white.opacity(0.6))
            : TileStyle(fill: Color(red: 0.05, green: 0.36, blue: 0.15), text: .white, secondary: .white.opacity(0.75))
    }
}

extension ConnectionState {
    /// Small indicator over the tiles; nil when everything is fine. Reconnecting
    /// after a wrist raise (.connecting with data on screen) is not worth a mark.
    var indicatorColor: Color? {
        switch self {
        case .live, .connecting: return nil
        case .polling: return .yellow
        case .unreachable: return .red
        }
    }

    var shortLabel: String {
        switch self {
        case .live: return "Live"
        case .polling: return "Polling"
        case .connecting: return "Connecting"
        case .unreachable: return "Offline"
        }
    }
}
