import AIStatusKit
import SwiftUI

/// Sheet opened by tapping a tile. Follows the live session (timers keep
/// running, status updates); if the session goes away meanwhile it keeps
/// showing the last known state. Tap anywhere (or the system close button) to
/// go back.
struct SessionDetailSheet: View {
    @ObservedObject var model: StatusModel
    let target: DetailTarget
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        let p = model.presentations.first { $0.id == target.id } ?? target.snapshot
        SessionDetail(p: p)
            .contentShape(Rectangle())
            .onTapGesture { dismiss() }
    }
}

/// One non-scrolling screen about one session: tool, project, status with its
/// counting timer, how long it ran, and the last message if there is one.
struct SessionDetail: View {
    let p: CardPresentation
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        let style = TileStyle.of(p.tone, dimmed: dimmed)
        VStack(alignment: .leading, spacing: 3) {
            HStack(spacing: 5) {
                ToolGlyph(tool: p.tool, size: 14)
                Text(p.tool.displayName)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
            }
            Text(p.project)
                .font(.system(size: 19, weight: .bold, design: .rounded))
                .lineLimit(2)
                .minimumScaleFactor(0.7)
                .foregroundStyle(.white)
            TileStatusText(tone: p.tone, start: p.timerStart)
                .font(.system(size: 22, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.6)
            Text(summary)
                .font(.system(size: 12, weight: .medium, design: .rounded))
                .lineLimit(2)
                .opacity(0.85)
            if let message = p.message, !message.isEmpty {
                Text(message)
                    .font(.system(size: 12))
                    .lineLimit(4)
                    .foregroundStyle(.white.opacity(0.75))
                    .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .foregroundStyle(style.text)
        .padding(.horizontal, 10)
        .padding(.top, 2)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(style.fill.ignoresSafeArea())
        .accessibilityElement(children: .combine)
    }

    /// "Needs approval · ran 1m 05s before", "Done · ran 4m 10s", "Running".
    private var summary: String {
        [p.headline, p.detail].compactMap { $0 }.joined(separator: " · ")
    }
}
