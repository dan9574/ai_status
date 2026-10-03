import AIStatusKit
import SwiftUI

extension AgentTool {
    /// Claude = clay orange with a sparkle, Codex = blue with a code glyph:
    /// distinguishable by colour *and* shape.
    public var color: Color {
        switch self {
        case .claude: return Color(red: 0.85, green: 0.47, blue: 0.34)
        case .codex: return Color(red: 0.36, green: 0.62, blue: 1.0)
        case .other: return .gray
        }
    }

    public var symbol: String {
        switch self {
        case .claude: return "sparkle"
        case .codex: return "chevron.left.forwardslash.chevron.right"
        case .other: return "cpu"
        }
    }
}

extension CardPresentation.Tone {
    public var color: Color {
        switch self {
        case .running: return .green
        case .waiting: return .orange
        case .done: return Color(red: 0.55, green: 0.6, blue: 0.7)
        case .failed: return .red
        case .unknown: return .gray
        }
    }

    public var symbol: String {
        switch self {
        case .running: return "play.circle.fill"
        case .waiting: return "exclamationmark.circle.fill"
        case .done: return "checkmark.circle.fill"
        case .failed: return "xmark.octagon.fill"
        case .unknown: return "questionmark.circle"
        }
    }
}

extension ConnectionState {
    var indicatorColor: Color {
        switch self {
        case .live: return .green
        case .polling: return .yellow
        case .connecting: return .gray
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
