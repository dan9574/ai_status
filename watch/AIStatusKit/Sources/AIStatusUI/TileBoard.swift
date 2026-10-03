import AIStatusKit
import SwiftUI

/// The main screen: up to four session tiles filling the display edge to edge
/// (see `TileArrangement`). Owns the tap-to-clear state; everything it draws
/// comes from `TileBoard`, which is pure and can be rendered off-screen.
struct TileBoardView: View {
    @ObservedObject var model: StatusModel
    let openSettings: () -> Void
    @State private var taps = TapToClear()

    var body: some View {
        let items = model.presentations
        // Outer reader: the safe area (the system clock sits above it).
        // Inner reader: the whole display, so tile colour reaches every edge.
        GeometryReader { outer in
            let insets = TileInsets(outer.safeAreaInsets)
            GeometryReader { full in
                TileBoard(
                    items: items, size: full.size, insets: insets, connection: model.connection,
                    armedID: taps.armedID, onTap: handleTap, onLongPress: openSettings
                )
            }
            .ignoresSafeArea()
        }
        .task(id: taps.armedAt) {
            // Revert "tap again" after the timeout.
            guard let deadline = taps.expiresAt else { return }
            let wait = deadline.timeIntervalSinceNow
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            withAnimation(.easeOut(duration: 0.2)) { _ = taps.expire(now: Date()) }
        }
        .onChange(of: model.cards) { _, _ in
            taps.reconcile(with: model.presentations)
        }
    }

    private func handleTap(_ p: CardPresentation) {
        switch taps.tap(p, now: Date()) {
        case .ignored:
            break
        case .armed:
            Haptics.armed()
        case .clear(let id):
            // StatusModel hides the card at once and restores it if the POST fails.
            Task { await model.dismiss(id: id) }
        }
    }
}

extension TileInsets {
    init(_ e: EdgeInsets) {
        self.init(top: e.top, leading: e.leading, bottom: e.bottom, trailing: e.trailing)
    }
}

/// Pure drawing of the tile screen for a given display size and safe-area insets.
struct TileBoard: View {
    let items: [CardPresentation]
    let size: CGSize
    var insets: TileInsets = .zero
    var connection: ConnectionState = .live
    var armedID: String?
    var onTap: (CardPresentation) -> Void = { _ in }
    var onLongPress: () -> Void = {}

    var body: some View {
        let plan = TilePlan(ordered: items)
        let slots = TileGeometry.slots(for: plan.arrangement, in: size, insets: insets)
        let metrics = TileMetrics(arrangement: plan.arrangement, screenWidth: size.width)
        ZStack(alignment: .topLeading) {
            Color.black
                .onLongPressGesture(perform: onLongPress)
            ForEach(Array(zip(plan.tiles, slots)), id: \.0.id) { p, slot in
                SessionTile(p: p, slot: slot, metrics: metrics, armed: p.id == armedID)
                    .frame(width: slot.frame.width, height: slot.frame.height)
                    .offset(x: slot.frame.minX, y: slot.frame.minY)
                    .gesture(
                        LongPressGesture(minimumDuration: 0.5)
                            .onEnded { _ in onLongPress() }
                            .exclusively(before: TapGesture().onEnded { onTap(p) })
                    )
                    .transition(.opacity)
            }
            StatusStrip(connection: connection, overflow: plan.overflow, insets: insets, scale: metrics.scale)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .animation(.easeOut(duration: 0.25), value: plan.tiles.map(\.id))
        .accessibilityAction(named: "Settings", onLongPress)
    }
}

/// Font sizes per arrangement, designed on the 40 mm display (162 pt wide) and
/// scaled with the screen width. Fixed sizes rather than text styles: this is a
/// glance screen and every tile must look the same.
struct TileMetrics {
    var name: CGFloat
    var timer: CGFloat
    var marker: CGFloat
    var nameLines: Int
    /// Grid tiles are too narrow for the marker beside a two-line name: it moves
    /// in front of the timer instead.
    var markerOnTimerLine: Bool
    var spacing: CGFloat
    var padding: CGFloat
    var scale: CGFloat

    init(arrangement: TileArrangement, screenWidth: CGFloat) {
        let k = max(0.8, min(1.4, screenWidth / 162))
        scale = k
        markerOnTimerLine = false
        switch arrangement {
        case .empty, .single:
            name = 28; timer = 46; marker = 16; nameLines = 2; spacing = 6; padding = 10
        case .rows(2):
            name = 21; timer = 30; marker = 12; nameLines = 1; spacing = 1; padding = 10
        case .rows:
            name = 17; timer = 22; marker = 10; nameLines = 1; spacing = 0; padding = 10
        case .grid:
            name = 15; timer = 21; marker = 9; nameLines = 2; spacing = 1; padding = 4
            markerOnTimerLine = true
        }
        name *= k; timer *= k; marker *= k; spacing *= k; padding *= k
    }
}

/// One session: tool marker + project name + one self-running timer.
struct SessionTile: View {
    let p: CardPresentation
    let slot: TileSlot
    let metrics: TileMetrics
    let armed: Bool
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        let style = armed ? TileStyle.armed(dimmed: dimmed) : TileStyle.of(p.tone, dimmed: dimmed)
        ZStack(alignment: .topLeading) {
            Rectangle().fill(style.fill)
            content(style)
                .frame(width: slot.content.width, height: slot.content.height)
                .offset(x: slot.content.minX - slot.frame.minX, y: slot.content.minY - slot.frame.minY)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(p.project), \(p.tool.displayName), \(p.headline)")
        .accessibilityValue(timerAccessibilityValue)
        .accessibilityHint(hint)
        .accessibilityAddTraits(p.isFinished ? .isButton : [])
    }

    private func marker(_ style: TileStyle) -> some View {
        Image(systemName: p.tool.tileSymbol)
            .font(.system(size: metrics.marker, weight: .heavy))
            .foregroundStyle(style.secondary)
    }

    private func content(_ style: TileStyle) -> some View {
        VStack(spacing: metrics.spacing) {
            HStack(alignment: .firstTextBaseline, spacing: 3 * metrics.scale) {
                if !metrics.markerOnTimerLine { marker(style) }
                Text(p.project)
                    .font(.system(size: metrics.name, weight: .bold, design: .rounded))
                    .lineLimit(metrics.nameLines)
                    .minimumScaleFactor(0.7)
                    .multilineTextAlignment(.center)
            }
            if armed {
                Label("Tap again", systemImage: "xmark")
                    .font(.system(size: metrics.timer * 0.62, weight: .bold, design: .rounded))
                    .lineLimit(1)
                    .minimumScaleFactor(0.5)
            } else if let start = p.timerStart {
                HStack(alignment: .firstTextBaseline, spacing: 3 * metrics.scale) {
                    if metrics.markerOnTimerLine { marker(style) }
                    TileTimer(start: start)
                        .font(.system(size: metrics.timer, weight: .semibold, design: .rounded))
                        .monospacedDigit()
                }
                .lineLimit(1)
                .minimumScaleFactor(0.5)
            } else if metrics.markerOnTimerLine {
                marker(style)
            }
        }
        .foregroundStyle(style.text)
        .padding(.horizontal, metrics.padding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var timerAccessibilityValue: Text {
        guard let start = p.timerStart else { return Text("") }
        return Text("\(p.timerLabel ?? "") \(Text(start, style: .relative))")
    }

    private var hint: String {
        guard p.isFinished else { return "" }
        if armed { return "Tap again to clear" }
        return p.dismissPolicy == .swipe ? "Tap to clear" : "Tap twice to clear"
    }
}

/// Counts up from `start` by itself (no polling). In Always-On the screen only
/// refreshes about once a minute, so show whole minutes instead of frozen seconds.
struct TileTimer: View {
    let start: Date
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        if dimmed {
            TimelineView(.everyMinute) { context in
                Text(CoarseDuration.format(context.date.timeIntervalSince(start)))
            }
        } else {
            Text(start, style: .timer)
        }
    }
}

/// Top-leading corner, beside the system clock: connection trouble and "+N"
/// sessions that did not fit. Drawn only when there is something to say.
struct StatusStrip: View {
    let connection: ConnectionState
    let overflow: Int
    let insets: TileInsets
    let scale: CGFloat

    var body: some View {
        let color = connection.indicatorColor
        if color != nil || overflow > 0 {
            HStack(spacing: 3 * scale) {
                if let color {
                    Image(systemName: connection == .polling ? "circle.fill" : "wifi.exclamationmark")
                        .font(.system(size: (connection == .polling ? 7 : 11) * scale, weight: .bold))
                        .foregroundStyle(color)
                        .accessibilityLabel(connection.shortLabel)
                }
                if overflow > 0 {
                    Text("+\(overflow)")
                        .font(.system(size: 12 * scale, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .accessibilityLabel("\(overflow) more sessions")
                }
            }
            .padding(.horizontal, 6 * scale)
            .frame(height: 18 * scale)
            .background(Capsule().fill(.black.opacity(0.85)))
            .padding(.leading, max(insets.leading, 0) + 12 * scale)
            .frame(height: max(insets.top, 22 * scale))
            .allowsHitTesting(false)
        }
    }
}
