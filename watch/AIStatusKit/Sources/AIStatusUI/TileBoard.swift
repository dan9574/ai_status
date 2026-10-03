import AIStatusKit
import SwiftUI

/// The main screen: up to four session tiles filling the display edge to edge
/// (see `TileArrangement`), in stable start order. Owns the swipe-to-delete
/// state and the detail sheet; everything it draws comes from `TileBoard`,
/// which is pure and can be rendered off-screen.
struct TileBoardView: View {
    @ObservedObject var model: StatusModel
    let openSettings: () -> Void
    @State private var swipe = SwipeReveal()
    @State private var detail: DetailTarget?

    var body: some View {
        // Outer reader: the safe area (the system clock sits above it).
        // Inner reader: the whole display, so tile colour reaches every edge.
        GeometryReader { outer in
            let insets = TileInsets(outer.safeAreaInsets)
            GeometryReader { full in
                TileBoard(
                    items: model.presentations, size: full.size, insets: insets,
                    connection: model.connection, swipe: swipe, actions: actions
                )
            }
            .ignoresSafeArea()
        }
        .task(id: swipe.openedAt) {
            // Close the open tile after a few seconds without touching it.
            guard let deadline = swipe.expiresAt else { return }
            let wait = deadline.timeIntervalSinceNow
            if wait > 0 { try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000)) }
            guard !Task.isCancelled else { return }
            withAnimation(.snappy(duration: 0.25)) { _ = swipe.expire(now: Date()) }
        }
        .onChange(of: model.cards) { _, cards in
            swipe.reconcile(visible: TilePlan(ordered: cards).tiles.map(\.id))
        }
        .sheet(item: $detail) { target in
            SessionDetailSheet(model: model, target: target)
        }
    }

    /// StatusModel hides the card at once and restores it if the POST fails;
    /// the board animates the re-split.
    private func delete(_ id: String) {
        Task { await model.dismiss(id: id) }
    }

    private var actions: TileActions {
        TileActions(
            tapTile: { id in
                var outcome = SwipeReveal.TapOutcome.ignored
                withAnimation(.snappy(duration: 0.25)) { outcome = swipe.tapTile(id, now: Date()) }
                if case .showDetail(let id) = outcome, let p = model.presentations.first(where: { $0.id == id }) {
                    detail = DetailTarget(p)
                }
            },
            tapTrash: { id in
                if case .delete(let id) = swipe.tapTrash(id) { delete(id) }
            },
            delete: delete,
            dragChanged: { id, t in swipe.dragChanged(id, dx: t.width, dy: t.height) },
            dragEnded: { id, predicted, reveal in
                withAnimation(.snappy(duration: 0.25)) {
                    _ = swipe.dragEnded(id, predictedDX: predicted, revealWidth: reveal, now: Date())
                }
            },
            dragCancelled: { id in withAnimation(.snappy(duration: 0.25)) { swipe.dragCancelled(id) } },
            tapBackground: { withAnimation(.snappy(duration: 0.25)) { _ = swipe.close() } },
            longPress: {
                swipe.close()
                openSettings()
            }
        )
    }
}

/// The session whose detail sheet is open (captured so the sheet can still show
/// it if the session disappears meanwhile).
struct DetailTarget: Identifiable {
    let id: String
    let snapshot: CardPresentation
    init(_ p: CardPresentation) {
        id = p.id
        snapshot = p
    }
}

extension TileInsets {
    init(_ e: EdgeInsets) {
        self.init(top: e.top, leading: e.leading, bottom: e.bottom, trailing: e.trailing)
    }
}

/// What the tiles report back to `TileBoardView`.
struct TileActions {
    var tapTile: (String) -> Void = { _ in }
    var tapTrash: (String) -> Void = { _ in }
    /// Delete without the swipe (VoiceOver action).
    var delete: (String) -> Void = { _ in }
    var dragChanged: (String, CGSize) -> Void = { _, _ in }
    /// id, predicted end translation (x), trash button width.
    var dragEnded: (String, CGFloat, CGFloat) -> Void = { _, _, _ in }
    var dragCancelled: (String) -> Void = { _ in }
    var tapBackground: () -> Void = {}
    var longPress: () -> Void = {}
}

/// Pure drawing of the tile screen for a given display size and safe-area insets.
struct TileBoard: View {
    let items: [CardPresentation]
    let size: CGSize
    var insets: TileInsets = .zero
    var connection: ConnectionState = .live
    var swipe = SwipeReveal()
    var actions = TileActions()

    var body: some View {
        let plan = TilePlan(ordered: items)
        let slots = TileGeometry.slots(for: plan.arrangement, in: size, insets: insets)
        let metrics = TileMetrics(arrangement: plan.arrangement, screenWidth: size.width)
        ZStack(alignment: .topLeading) {
            Color.black
                .contentShape(Rectangle())
                .onTapGesture(perform: actions.tapBackground)
                .onLongPressGesture(minimumDuration: 0.5, perform: actions.longPress)
            ForEach(Array(zip(plan.tiles, slots)), id: \.0.id) { p, slot in
                SessionTile(p: p, slot: slot, metrics: metrics, swipe: swipe, actions: actions)
                    .frame(width: slot.frame.width, height: slot.frame.height)
                    .offset(x: slot.frame.minX, y: slot.frame.minY)
                    .transition(.opacity)
            }
            StatusStrip(connection: connection, overflow: plan.overflow, insets: insets, scale: metrics.scale)
        }
        .frame(width: size.width, height: size.height, alignment: .topLeading)
        .animation(.easeOut(duration: 0.25), value: plan.tiles.map(\.id))
        .accessibilityAction(named: "Settings", actions.longPress)
    }
}

/// Font sizes per arrangement, designed on the 40 mm display (162 pt wide) and
/// scaled with the screen width. Fixed sizes rather than text styles: this is a
/// glance screen and every tile must look the same.
struct TileMetrics {
    /// Tool name (line 1); the glyph is drawn at about this size.
    var tool: CGFloat
    /// Status word + timer (line 2).
    var status: CGFloat
    var spacing: CGFloat
    var padding: CGFloat
    /// 2×2 grid: `run 12:34` without the dot.
    var compact: Bool
    var scale: CGFloat

    init(arrangement: TileArrangement, screenWidth: CGFloat) {
        let k = max(0.8, min(1.4, screenWidth / 162))
        scale = k
        compact = false
        switch arrangement {
        case .empty, .single:
            tool = 21; status = 27; spacing = 8; padding = 8
        case .rows(2):
            tool = 18; status = 24; spacing = 5; padding = 8
        case .rows:
            tool = 15; status = 19; spacing = 2; padding = 8
        case .grid:
            tool = 14; status = 16; spacing = 4; padding = 3
            compact = true
        }
        tool *= k; status *= k; spacing *= k; padding *= k
    }
}

/// One session: tool mark + tool name, then status word + counting timer.
/// Swiping left slides it over a red trash button.
struct SessionTile: View {
    let p: CardPresentation
    let slot: TileSlot
    let metrics: TileMetrics
    let swipe: SwipeReveal
    let actions: TileActions
    @Environment(\.isLuminanceReduced) private var dimmed
    @GestureState private var touching = false

    var body: some View {
        let style = TileStyle.of(p.tone, dimmed: dimmed)
        let reveal = SwipeReveal.revealWidth(tileWidth: slot.frame.width)
        let x = swipe.offset(for: p.id, revealWidth: reveal)
        ZStack(alignment: .topLeading) {
            if x < 0 { trash(width: reveal) }
            body(style)
                .offset(x: x)
                .gesture(LongPressGesture(minimumDuration: 0.5)
                    .onEnded { _ in actions.longPress() }
                    .exclusively(before: TapGesture().onEnded { actions.tapTile(p.id) }))
                .simultaneousGesture(drag(reveal: reveal))
        }
        .frame(width: slot.frame.width, height: slot.frame.height, alignment: .topLeading)
        .clipped()
        .onChange(of: touching) { _, now in
            // Also fires after a normal end; deferred so `onEnded` always runs first.
            if !now { DispatchQueue.main.async { actions.dragCancelled(p.id) } }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(p.tool.displayName), \(p.headline)")
        .accessibilityValue(timerAccessibilityValue)
        .accessibilityAddTraits(.isButton)
        .accessibilityHint("Shows details. Swipe left to delete.")
        .accessibilityAction { actions.tapTile(p.id) }
        .accessibilityAction(named: "Delete") { actions.delete(p.id) }
    }

    private func drag(reveal: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8)
            .updating($touching) { _, state, _ in state = true }
            .onChanged { v in actions.dragChanged(p.id, v.translation) }
            .onEnded { v in actions.dragEnded(p.id, v.predictedEndTranslation.width, reveal) }
    }

    private func body(_ style: TileStyle) -> some View {
        ZStack(alignment: .topLeading) {
            Rectangle().fill(style.fill)
            content
                .frame(width: slot.content.width, height: slot.content.height)
                .offset(x: slot.content.minX - slot.frame.minX, y: slot.content.minY - slot.frame.minY)
        }
        .foregroundStyle(style.text)
        .frame(width: slot.frame.width, height: slot.frame.height, alignment: .topLeading)
        .contentShape(Rectangle())
    }

    private var content: some View {
        VStack(spacing: metrics.spacing) {
            HStack(spacing: metrics.tool * 0.3) {
                ToolGlyph(tool: p.tool, size: metrics.tool * 0.95)
                Text(p.tool.displayName)
                    .font(.system(size: metrics.tool, weight: .semibold, design: .rounded))
            }
            .lineLimit(1)
            .minimumScaleFactor(0.6)
            TileStatusText(tone: p.tone, start: p.timerStart, compact: metrics.compact)
                .font(.system(size: metrics.status, weight: .semibold, design: .rounded))
                .monospacedDigit()
                .lineLimit(1)
                .minimumScaleFactor(0.55)
        }
        .padding(.horizontal, metrics.padding)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Red button under the right edge of the tile, revealed as the tile slides
    /// left. A 2 pt black gap keeps the tile edge visible; the icon is centred in
    /// the tile's text area (top tiles reach under the clock).
    private func trash(width: CGFloat) -> some View {
        let gap = TileGeometry.gap
        let w = max(0, width - gap)
        let iconY = slot.content.midY - slot.frame.minY
        return Button { actions.tapTrash(p.id) } label: {
            ZStack(alignment: .topLeading) {
                Rectangle().fill(TileStyle.trashFill)
                Image(systemName: "trash.fill")
                    .font(.system(size: min(22, max(15, w * 0.42)), weight: .semibold))
                    .foregroundStyle(TileStyle.trashIcon)
                    .frame(width: w)
                    .position(x: w / 2, y: iconY)
            }
            .frame(width: w + SwipeReveal.overshoot, height: slot.frame.height)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .frame(width: w + SwipeReveal.overshoot, height: slot.frame.height, alignment: .topLeading)
        .offset(x: slot.frame.width - w)
        .allowsHitTesting(swipe.isOpen(p.id))
        .accessibilityLabel("Delete")
    }

    private var timerAccessibilityValue: Text {
        guard let start = p.timerStart else { return Text("") }
        return Text(start, style: .relative)
    }
}

/// Second line of a tile: `run · 12:34` counting up from `start` by itself.
/// In Always-On the screen only refreshes about once a minute, so it shows
/// whole minutes (`run · 12m`) instead of frozen seconds.
struct TileStatusText: View {
    let tone: CardPresentation.Tone
    let start: Date?
    var compact = false
    @Environment(\.isLuminanceReduced) private var dimmed

    var body: some View {
        if let start {
            if dimmed {
                TimelineView(.everyMinute) { context in
                    Text(TileLabel.status(tone, elapsed: context.date.timeIntervalSince(start), compact: compact, coarse: true))
                }
            } else {
                // Tick on the start's whole seconds, so the clock turns over on time.
                let next = start.addingTimeInterval(max(0, Date().timeIntervalSince(start)).rounded(.up))
                TimelineView(.periodic(from: next, by: 1)) { context in
                    Text(TileLabel.status(tone, elapsed: context.date.timeIntervalSince(start), compact: compact))
                }
            }
        } else {
            Text(TileLabel.word(tone))
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
