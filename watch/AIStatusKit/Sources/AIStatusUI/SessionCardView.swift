import AIStatusKit
import SwiftUI

/// Tool badge: coloured glyph + name.
struct ToolBadge: View {
    let tool: AgentTool
    var large = false

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: tool.symbol)
                .font(large ? .caption.weight(.bold) : .caption2.weight(.bold))
            Text(tool.displayName)
                .font(large ? .caption.weight(.semibold) : .caption2.weight(.semibold))
                .textCase(.uppercase)
        }
        .foregroundStyle(tool.color)
        .accessibilityElement(children: .combine)
    }
}

/// "for 12:34" / "idle 3:02" / "waiting 0:41", ticking by itself.
struct TimerLine: View {
    let label: String?
    let start: Date?
    var font: Font = .body

    var body: some View {
        if let start {
            HStack(spacing: 4) {
                if let label { Text(label).foregroundStyle(.secondary) }
                Text(start, style: .timer)
                    .monospacedDigit()
            }
            .font(font)
            .lineLimit(1)
        }
    }
}

/// One session. `.compact` for list rows, `.large` for the single-session screen and details.
public struct SessionCardView: View {
    public enum Size { case compact, large }

    let p: CardPresentation
    let size: Size

    public init(_ presentation: CardPresentation, size: Size = .compact) {
        self.p = presentation
        self.size = size
    }

    public var body: some View {
        VStack(alignment: .leading, spacing: size == .large ? 4 : 2) {
            HStack {
                ToolBadge(tool: p.tool, large: size == .large)
                Spacer(minLength: 2)
                if p.tone == .waiting {
                    Image(systemName: "hand.raised.fill")
                        .font(.caption2)
                        .foregroundStyle(.orange)
                }
            }
            Text(p.project)
                .font(size == .large ? .title3.weight(.bold) : .headline)
                .lineLimit(size == .large ? 2 : 1)
                .minimumScaleFactor(0.7)
            Label(p.headline, systemImage: p.tone.symbol)
                .font((size == .large ? Font.body : .footnote).weight(.semibold))
                .foregroundStyle(p.tone.color)
                .lineLimit(1)
            TimerLine(label: p.timerLabel, start: p.timerStart, font: size == .large ? .title2.weight(.medium) : .footnote)
            if let detail = p.detail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            if let msg = p.message, size == .large {
                Text(msg)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .padding(.top, 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// Rounded background used behind cards; waiting cards get a strong orange wash
/// and border so they stand out at a glance.
struct CardBackground: View {
    let tone: CardPresentation.Tone

    var body: some View {
        RoundedRectangle(cornerRadius: 14, style: .continuous)
            .fill(tone.color.opacity(tone == .waiting ? 0.38 : 0.16))
            .overlay(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .strokeBorder(tone.color.opacity(tone == .waiting ? 0.95 : 0), lineWidth: 2)
            )
    }
}
