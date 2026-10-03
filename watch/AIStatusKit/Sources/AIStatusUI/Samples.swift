import AIStatusKit
import SwiftUI

/// Sample data for SwiftUI previews and the off-screen renders (watch/previews).
public enum SampleData {
    /// Six sessions in mixed states. Taking the first n gives a mixed set for
    /// every tile count: running, + waiting, + done (short), + running, + done (long), + running.
    public static func snapshot(count: Int = 6, now: Date = Date()) -> Snapshot {
        let t = Int64(now.timeIntervalSince1970 * 1000)
        let pool = [
            SessionCard(id: "claude:a", tool: .claude, sessionId: "a", project: "ai_status", status: .running,
                        startedAt: t - 754_000, updatedAt: t - 5_000),
            SessionCard(id: "codex:b", tool: .codex, sessionId: "b", project: "billing-service", status: .waiting,
                        startedAt: t - 900_000, waitingSince: t - 41_000, waitingReason: .permission, updatedAt: t - 41_000),
            SessionCard(id: "claude:d", tool: .claude, sessionId: "d", project: "dotfiles", status: .done,
                        startedAt: t - 200_000, finishedAt: t - 182_000, runDurationMs: 18_000,
                        dismissPolicy: .swipe, updatedAt: t - 182_000),
            SessionCard(id: "codex:i", tool: .codex, sessionId: "i", project: "infra-terraform", status: .running,
                        startedAt: t - 3_912_000, updatedAt: t - 2_000),
            SessionCard(id: "codex:p", tool: .codex, sessionId: "p", project: "photos-app", status: .done,
                        startedAt: t - 2_550_000, finishedAt: t - 1_250_000, runDurationMs: 1_300_000,
                        dismissPolicy: .confirm, updatedAt: t - 1_250_000),
            SessionCard(id: "claude:n", tool: .claude, sessionId: "n", project: "notes", status: .running,
                        startedAt: t - 95_000, updatedAt: t - 1_000),
        ]
        return Snapshot(serverTime: t, swipeThresholdSec: 60, sessions: Array(pool.prefix(count)))
    }

    /// The first `count` sample sessions in watch order, ready for tiles.
    public static func presentations(count: Int = 6, now: Date = Date()) -> [CardPresentation] {
        let s = snapshot(count: count, now: now)
        var clock = ClockSync()
        clock.record(serverTimeMs: s.serverTime, sentAt: now, receivedAt: now)
        return WatchOrdering.sorted(s.sessions).map { CardPresentation(card: $0, clock: clock) }
    }
}

/// Apple Watch SE display sizes in points, with the system clock's safe-area
/// inset and an approximate display corner radius (used only for renders).
public struct WatchDisplay: Sendable {
    public let name: String
    public let size: CGSize
    public let topInset: CGFloat
    public let cornerRadius: CGFloat

    public static let se40 = WatchDisplay(name: "40mm", size: CGSize(width: 162, height: 197), topInset: 28, cornerRadius: 28)
    public static let se44 = WatchDisplay(name: "44mm", size: CGSize(width: 184, height: 224), topInset: 31, cornerRadius: 33)
    public static let all = [se40, se44]

    public var insets: TileInsets { TileInsets(top: topInset) }
}

/// Every screen of the app with sample data, as plain views (no GeometryReader,
/// sheets or scroll views) so they can be rendered off-screen on a Mac. Each is
/// framed like the real display: rounded corners and a stand-in for the system
/// clock (watchOS draws the real one).
@MainActor
public enum ScreenCatalog {
    public static func screens(on display: WatchDisplay, now: Date = Date()) -> [(name: String, view: AnyView)] {
        func tiles(_ n: Int, connection: ConnectionState = .live, armed: String? = nil) -> AnyView {
            AnyView(TileBoard(items: SampleData.presentations(count: n, now: now), size: display.size,
                              insets: display.insets, connection: connection, armedID: armed))
        }
        func state<V: View>(_ v: V) -> AnyView {
            AnyView(v.padding(.top, display.topInset).frame(width: display.size.width, height: display.size.height))
        }
        var out: [(String, AnyView)] = [("tiles-0", state(EmptySessionsView(openSettings: {})))]
        for n in [1, 2, 3, 4, 6] { out.append(("tiles-\(n)", tiles(n))) }
        out.append(("tiles-6-tap-again", tiles(6, armed: "codex:p")))
        out.append(("tiles-3-offline", tiles(3, connection: .unreachable("Connection refused"))))
        out.append(("tiles-4-always-on", AnyView(tiles(4).environment(\.isLuminanceReduced, true))))
        out.append(("unreachable", state(UnreachableView(
            reason: "Connection refused (daemon not running?)", host: "daniels-macbook-air.local:7778",
            retry: {}, openSettings: {}
        ))))
        out.append(("connecting", state(ConnectingView(host: "daniels-macbook-air.local"))))
        out.append(("not-configured", state(NotConfiguredView(openSettings: {}))))
        return out.map { name, view in (name, AnyView(WatchFrame(display: display) { view })) }
    }

    /// The accessory widget (unchanged by the tile redesign), for the render check.
    public static func widgets(now: Date = Date()) -> [(name: String, view: AnyView)] {
        [
            ("widget-rectangular", AnyView(StatusCountsWidgetView(snapshot: SharedSnapshot(
                savedAt: now, counts: StatusCounts(running: 1, waiting: 1, done: 2), reachable: true, waitingProjects: ["ai_status"]
            )))),
            ("widget-empty", AnyView(StatusCountsWidgetView(snapshot: nil))),
        ]
    }
}

/// Display mask + fake "10:09" where watchOS draws the time.
struct WatchFrame<Content: View>: View {
    let display: WatchDisplay
    @ViewBuilder let content: () -> Content

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black
            content()
            Text("10:09")
                .font(.system(size: display.topInset * 0.55, weight: .semibold, design: .rounded))
                .foregroundStyle(.white)
                .frame(height: display.topInset)
                .padding(.trailing, display.cornerRadius * 0.5)
        }
        .frame(width: display.size.width, height: display.size.height)
        .clipShape(RoundedRectangle(cornerRadius: display.cornerRadius, style: .continuous))
        .environment(\.colorScheme, .dark)
    }
}

#if DEBUG
struct TileScreens_Previews: PreviewProvider {
    static var previews: some View {
        ForEach(ScreenCatalog.screens(on: .se40), id: \.name) { item in
            item.view.previewDisplayName(item.name)
        }
    }
}
#endif
