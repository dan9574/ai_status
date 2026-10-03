import AIStatusKit
import SwiftUI

extension Color {
    /// 0xRRGGBB, optionally scaled towards black (`brightness` 1 = as given).
    init(hex: UInt32, brightness: Double = 1) {
        self.init(
            red: Double((hex >> 16) & 0xFF) / 255 * brightness,
            green: Double((hex >> 8) & 0xFF) / 255 * brightness,
            blue: Double(hex & 0xFF) / 255 * brightness
        )
    }
}

/// Colours of one tile: a very dark tinted fill with lighter same-hue text.
/// Running = grey, waiting ("ask") = amber, done = green. In Always-On
/// (luminance reduced) both drop a little further.
struct TileStyle {
    var fill: Color
    var text: Color

    static func of(_ tone: CardPresentation.Tone, dimmed: Bool) -> TileStyle {
        let (fill, text): (UInt32, UInt32)
        switch tone {
        case .waiting: (fill, text) = (0x412402, 0xFAC775)
        case .done, .failed: (fill, text) = (0x173404, 0xC0DD97)
        case .running, .unknown: (fill, text) = (0x2C2C2A, 0xD3D1C7)
        }
        // Always-On: darker fill, slightly dimmer text, same hue.
        return TileStyle(fill: Color(hex: fill, brightness: dimmed ? 0.55 : 1),
                         text: Color(hex: text, brightness: dimmed ? 0.75 : 1))
    }

    /// The trash button revealed by swiping a tile left.
    static let trashFill = Color(hex: 0x791F1F)
    static let trashIcon = Color(hex: 0xF7C1C1)
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
