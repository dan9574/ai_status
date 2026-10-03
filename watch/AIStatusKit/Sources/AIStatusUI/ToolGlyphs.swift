import AIStatusKit
import SwiftUI

// Monochrome tool marks drawn as SwiftUI shapes (vector, crisp at any size,
// tinted with the tile's text colour). Full-colour app icons do not read at
// ~14 pt on a dark tinted tile, so these are simple template glyphs evoking each:
//   Claude: the radiating starburst of its app / menu-bar icon;
//   Codex:  the scalloped cloud with a ">_" prompt from the Codex icon shipped
//           inside the ChatGPT desktop app.
// Personal, non-distributed build.

/// Claude: rays of slightly uneven length and weight around a solid centre,
/// like the menu-bar starburst.
struct ClaudeBurst: Shape {
    /// (angle in degrees from 12 o'clock, length as a fraction of the radius, width as a fraction of the size)
    static let rays: [(angle: Double, length: Double, width: Double)] = [
        (0, 1.00, 0.125), (32, 0.80, 0.11), (63, 0.97, 0.125), (95, 0.78, 0.11),
        (127, 0.95, 0.125), (160, 0.82, 0.11), (192, 1.00, 0.125), (224, 0.78, 0.11),
        (256, 0.96, 0.125), (288, 0.80, 0.11), (322, 0.94, 0.125),
    ]

    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let c = CGPoint(x: rect.midX, y: rect.midY)
        var out = Path()
        for ray in Self.rays {
            let w = side * ray.width
            // Round caps stick out by w/2: keep the tips inside the rect.
            let r = (side / 2 - w / 2) * ray.length
            let a = ray.angle * .pi / 180
            var line = Path()
            line.move(to: c)
            line.addLine(to: CGPoint(x: c.x + r * sin(a), y: c.y - r * cos(a)))
            out.addPath(line.strokedPath(StrokeStyle(lineWidth: w, lineCap: .round)))
        }
        let hub = side * 0.09
        out.addEllipse(in: CGRect(x: c.x - hub, y: c.y - hub, width: hub * 2, height: hub * 2))
        return out
    }
}

/// Codex: a scalloped cloud (a ring of overlapping lobes around a disc).
struct CodexCloud: Shape {
    static let lobes = 8

    func path(in rect: CGRect) -> Path {
        let side = min(rect.width, rect.height)
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let lobe = side * 0.17           // lobe radius
        let ring = side / 2 - lobe       // lobe centres sit on this circle
        let disc = side * 0.40           // fills the notches between lobes: shallow scallops
        var out = Path()
        // All circles wind the same way, so the default non-zero fill draws their union.
        out.addEllipse(in: CGRect(x: c.x - disc, y: c.y - disc, width: disc * 2, height: disc * 2))
        for i in 0..<Self.lobes {
            let a = (Double(i) / Double(Self.lobes) + 1 / 16) * 2 * .pi
            let p = CGPoint(x: c.x + ring * cos(a), y: c.y + ring * sin(a))
            out.addEllipse(in: CGRect(x: p.x - lobe, y: p.y - lobe, width: lobe * 2, height: lobe * 2))
        }
        return out
    }
}

/// The ">_" prompt cut out of the Codex cloud.
struct CodexPrompt: Shape {
    func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height)
        let o = CGPoint(x: rect.midX - s / 2, y: rect.midY - s / 2)
        func pt(_ x: Double, _ y: Double) -> CGPoint { CGPoint(x: o.x + s * x, y: o.y + s * y) }
        var chevron = Path()
        chevron.move(to: pt(0.28, 0.31))
        chevron.addLine(to: pt(0.46, 0.50))
        chevron.addLine(to: pt(0.28, 0.69))
        var underscore = Path()
        underscore.move(to: pt(0.55, 0.69))
        underscore.addLine(to: pt(0.74, 0.69))
        let style = StrokeStyle(lineWidth: s * 0.12, lineCap: .round, lineJoin: .round)
        var out = chevron.strokedPath(style)
        out.addPath(underscore.strokedPath(style))
        return out
    }
}

/// A tool's mark at `size` points, drawn in the current foreground style.
struct ToolGlyph: View {
    let tool: AgentTool
    let size: CGFloat

    var body: some View {
        Group {
            switch tool {
            case .claude:
                ClaudeBurst().fill(.foreground)
            case .codex:
                CodexCloud().fill(.foreground)
                    .mask {
                        Rectangle()
                            .overlay { CodexPrompt().fill(.black).blendMode(.destinationOut) }
                            .compositingGroup()
                    }
            case .other:
                Image(systemName: "cpu").resizable().scaledToFit()
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}
