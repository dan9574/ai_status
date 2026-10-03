import AIStatusKit
import SwiftUI

/// Sample data for SwiftUI previews and for the macOS render smoke test.
public enum SampleData {
    public static func snapshot(now: Date = Date()) -> Snapshot {
        let t = Int64(now.timeIntervalSince1970 * 1000)
        return Snapshot(serverTime: t, swipeThresholdSec: 60, sessions: [
            SessionCard(id: "claude:w", tool: .claude, sessionId: "w", project: "ai_status", status: .waiting,
                        startedAt: t - 340_000, waitingSince: t - 41_000, waitingReason: .permission,
                        lastMessage: "Claude needs your permission to use Bash", updatedAt: t - 41_000),
            SessionCard(id: "codex:r", tool: .codex, sessionId: "r", project: "billing-service", status: .running,
                        startedAt: t - 754_000, lastMessage: "add pagination to the invoices endpoint", updatedAt: t - 5_000),
            SessionCard(id: "claude:d", tool: .claude, sessionId: "d", project: "dotfiles", status: .done,
                        startedAt: t - 200_000, finishedAt: t - 182_000, runDurationMs: 18_000,
                        lastMessage: "It matches ISO-8601 dates.", dismissPolicy: .swipe, updatedAt: t - 182_000),
            SessionCard(id: "codex:f", tool: .codex, sessionId: "f", project: "infra", status: .done,
                        startedAt: t - 1_900_000, finishedAt: t - 600_000, runDurationMs: 1_300_000,
                        lastMessage: "API rate limit reached", dismissPolicy: .confirm, error: "rate_limit", updatedAt: t - 600_000),
        ])
    }

    public static func presentations(now: Date = Date()) -> [CardPresentation] {
        let s = snapshot(now: now)
        var clock = ClockSync()
        clock.record(serverTimeMs: s.serverTime, sentAt: now, receivedAt: now)
        return WatchOrdering.sorted(s.sessions).map { CardPresentation(card: $0, clock: clock) }
    }
}

/// Every screen of the app with sample data, as plain views (no List/NavigationStack),
/// so they can be rendered off-screen on a Mac and inspected.
@MainActor
public enum ScreenCatalog {
    public static func screens(now: Date = Date()) -> [(name: String, view: AnyView)] {
        let items = SampleData.presentations(now: now)
        var out: [(String, AnyView)] = []
        for p in items {
            out.append(("single-\(p.id.replacingOccurrences(of: ":", with: "-"))", AnyView(
                VStack(alignment: .leading, spacing: 8) {
                    SessionCardView(p, size: .large)
                        .padding(10)
                        .background(CardBackground(tone: p.tone))
                    ClearButton(p: p) {}
                }
            )))
        }
        out.append(("list", AnyView(
            VStack(spacing: 6) {
                ForEach(items) { p in
                    SessionCardView(p, size: .compact)
                        .padding(8)
                        .background(CardBackground(tone: p.tone))
                }
            }
        )))
        out.append(("empty", AnyView(EmptySessionsView(connection: .live))))
        out.append(("unreachable", AnyView(UnreachableView(
            reason: "Connection refused (daemon not running?)", host: "http://daniels-macbook-air.local:7778",
            lastUpdate: now.addingTimeInterval(-300), lastCounts: StatusCounts(running: 1, waiting: 1, done: 2),
            retry: {}, openSettings: {}, scrolls: false
        ))))
        out.append(("connecting", AnyView(ConnectingView(host: "daniels-macbook-air.local"))))
        out.append(("not-configured", AnyView(NotConfiguredView(openSettings: {}, scrolls: false))))
        out.append(("widget-rectangular", AnyView(StatusCountsWidgetView(snapshot: SharedSnapshot(
            savedAt: now, counts: StatusCounts(running: 1, waiting: 1, done: 2), reachable: true, waitingProjects: ["ai_status"]
        )))))
        out.append(("widget-empty", AnyView(StatusCountsWidgetView(snapshot: nil))))
        return out
    }
}

#if DEBUG
struct SessionCards_Previews: PreviewProvider {
    static var previews: some View {
        ForEach(ScreenCatalog.screens(), id: \.name) { item in
            item.view.previewDisplayName(item.name)
        }
    }
}
#endif
