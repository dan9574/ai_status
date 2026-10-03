import AIStatusKit
import SwiftUI
import WidgetKit

/// Content of the accessory widget / complication: counts of running, waiting
/// and done sessions from the last snapshot the app saved. Modest by design:
/// it is only as fresh as the last time the app was open (background refresh is phase 3).
public struct StatusCountsWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let snapshot: SharedSnapshot?

    public init(snapshot: SharedSnapshot?) {
        self.snapshot = snapshot
    }

    private var counts: StatusCounts { snapshot?.counts ?? StatusCounts() }

    public var body: some View {
        switch family {
        #if os(watchOS)
        case .accessoryCircular:
            circular
        case .accessoryInline:
            inline
        case .accessoryCorner:
            corner
        #endif
        default:
            rectangular
        }
    }

    /// Waiting dominates: if anything waits, show that number in orange.
    @ViewBuilder
    private var circular: some View {
        #if os(watchOS)
        ZStack {
            AccessoryWidgetBackground()
            VStack(spacing: 0) {
                if counts.waiting > 0 {
                    Image(systemName: "hand.raised.fill").font(.caption2)
                    Text("\(counts.waiting)").font(.title3.weight(.bold)).widgetAccentable()
                } else {
                    Image(systemName: "sparkle").font(.caption2)
                    Text("\(counts.running)").font(.title3.weight(.bold))
                }
            }
            .foregroundStyle(counts.waiting > 0 ? Color.orange : Color.primary)
        }
        #else
        rectangular
        #endif
    }

    private var inline: some View {
        Text(snapshot == nil ? "AI: open app" : "AI ▶\(counts.running) ✋\(counts.waiting) ✓\(counts.done)")
    }

    @ViewBuilder
    private var corner: some View {
        #if os(watchOS)
        Text("\(counts.waiting > 0 ? counts.waiting : counts.running)")
            .font(.title2.weight(.bold))
            .foregroundStyle(counts.waiting > 0 ? Color.orange : Color.green)
            .widgetLabel {
                Text(counts.waiting > 0 ? "waiting" : "running")
            }
        #else
        rectangular
        #endif
    }

    private var rectangular: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 4) {
                Image(systemName: "sparkle")
                Text("AI sessions").font(.headline)
            }
            .widgetAccentable()
            if let snapshot {
                HStack(spacing: 8) {
                    count(counts.running, "play.fill", .green)
                    count(counts.waiting, "hand.raised.fill", .orange)
                    count(counts.done, "checkmark", .secondary)
                }
                .font(.body.weight(.semibold))
                Text(snapshot.reachable
                     ? "as of \(Text(snapshot.savedAt, style: .time))"
                     : "offline · \(Text(snapshot.savedAt, style: .time))")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            } else {
                Text("Open the app once").font(.caption2).foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func count(_ n: Int, _ symbol: String, _ color: Color) -> some View {
        HStack(spacing: 2) {
            Image(systemName: symbol).foregroundStyle(color)
            Text("\(n)").monospacedDigit()
        }
    }
}
