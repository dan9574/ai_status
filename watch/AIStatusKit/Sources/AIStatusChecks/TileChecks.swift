import AIStatusKit
import CoreGraphics
import Foundation

/// The tile screen's logic: arrangement per count, stable order and the first-4
/// selection with "+N", slot geometry, tile labels, swipe-to-delete state
/// machine, Always-On durations.
@MainActor
func runTileChecks() async {
    suite("tiles: arrangement by session count") {
        let want: [(Int, TileArrangement, Int)] = [
            (0, .empty, 0), (1, .single, 1), (2, .rows(2), 2), (3, .rows(3), 3), (4, .grid, 4), (5, .grid, 4), (9, .grid, 4),
        ]
        for (n, arrangement, capacity) in want {
            expectEqual(TileArrangement(tileCount: n), arrangement, "\(n) sessions")
            expectEqual(TileArrangement(tileCount: n).capacity, capacity, "\(n) sessions: capacity")
        }
        expectEqual(TileArrangement.grid.rows, 2, "grid rows")
        expectEqual(TileArrangement.grid.columns, 2, "grid columns")
        expectEqual(TileArrangement.rows(3).columns, 1, "rows are full width")
    }

    suite("tiles: first 4 by start time and +N") {
        let cards = [
            card("claude:r-old", .running, started: 10),
            card("claude:r-new", .running, started: 90),
            card("claude:d-new", .done, started: 1, finished: 80),
            card("claude:w-new", .waiting, started: 5, waiting: 70),
            card("codex:d-old", .done, started: 2, finished: 40),
            card("codex:w-old", .waiting, started: 6, waiting: 30),
            card("codex:d-mid", .done, started: 3, finished: 60),
        ]
        let plan = TilePlan(cards: cards)
        expectEqual(plan.arrangement, .grid, "7 sessions => grid")
        expectEqual(plan.tiles.map(\.id), ["claude:d-new", "codex:d-old", "codex:d-mid", "claude:w-new"],
                    "oldest start first, whatever the status (no waiting-first importance order)")
        expectEqual(plan.overflow, 3, "+3 badge")
        let few = TilePlan(cards: [card("claude:r", .running, started: 1), card("claude:d", .done, started: 2, finished: 5)])
        expectEqual(few.arrangement, .rows(2), "2 sessions => 2 rows")
        expectEqual(few.tiles.map(\.id), ["claude:r", "claude:d"], "running started first stays above done")
        expectEqual(few.overflow, 0, "no badge when everything fits")
        let four = TilePlan(cards: Array(cards.prefix(4)))
        expectEqual(four.overflow, 0, "exactly 4: no badge")
        expectEqual(four.tiles.map(\.id), ["claude:d-new", "claude:w-new", "claude:r-old", "claude:r-new"], "4: all shown in start order")
        let five = TilePlan(cards: [card("claude:b", .running, started: 50), card("claude:a", .waiting, started: 20, waiting: 99),
                                    card("claude:c", .done, started: 70, finished: 80), card("claude:d", .running, started: 10),
                                    card("claude:e", .waiting, started: 95, waiting: 96)])
        expectEqual(five.tiles.map(\.id), ["claude:d", "claude:a", "claude:b", "claude:c"], "5: newest-started session is the one left out")
        expectEqual(five.overflow, 1, "+1 badge")
        let none = TilePlan<SessionCard>(ordered: [])
        expectEqual(none.arrangement, .empty, "0 sessions => empty")
        check(none.tiles.isEmpty && none.overflow == 0, "empty plan")
    }

    suite("tiles: stable order (status changes never move a tile)") {
        var order = SessionOrder()
        let a = card("claude:a", .running, started: 100)
        let b = card("codex:b", .running, started: 200)
        let c = card("claude:c", .waiting, started: 300, waiting: 310)
        order.update(with: [c, a, b])
        expectEqual(order.sorted([c, b, a]).map(\.id), ["claude:a", "codex:b", "claude:c"], "start order, independent of input order")
        // a finishes, b asks, c gets approval and runs again.
        var a2 = card("claude:a", .done, started: 100, finished: 400)
        let b2 = card("codex:b", .waiting, started: 200, waiting: 410)
        let c2 = card("claude:c", .running, started: 300)
        order.update(with: [a2, b2, c2])
        expectEqual(order.sorted([c2, b2, a2]).map(\.id), ["claude:a", "codex:b", "claude:c"], "status changes keep positions")
        // a starts a new run (startedAt moves past everyone): still first.
        a2 = card("claude:a", .running, started: 500)
        order.update(with: [a2, b2, c2])
        expectEqual(order.sorted([a2, b2, c2]).map(\.id), ["claude:a", "codex:b", "claude:c"], "a new run keeps the first-seen start")
        expectEqual(order.key(a2), 100, "remembered start")
        // A new session goes last; a cleared one is forgotten and comes back by its new start.
        let d = card("codex:d", .running, started: 450)
        order.update(with: [b2, c2, d])
        a2 = card("claude:a", .running, started: 600)
        expectEqual(order.sorted([a2, b2, c2, d]).map(\.id), ["codex:b", "claude:c", "codex:d", "claude:a"], "cleared then back: placed by its new start")
        // Ties and missing times.
        let t1 = card("codex:t", .done, finished: 5), t2 = card("claude:t", .done, finished: 5)
        let unknown = SessionCard(id: "x:u", tool: .other("x"), sessionId: "u", status: .other("idle"))
        expectEqual(SessionOrder().sorted([unknown, t1, t2]).map(\.id), ["claude:t", "codex:t", "x:u"], "ties by id, unknown start last")
        expectEqual(SessionOrder.startKey(card("claude:w", .waiting, waiting: 7)), 7, "no startedAt: falls back to waitingSince")
        order.reset()
        expectEqual(order.key(a2), 600, "reset forgets remembered starts")
    }

    suite("tiles: geometry fills the screen") {
        let screens = [(CGSize(width: 162, height: 197), TileInsets(top: 28)), (CGSize(width: 184, height: 224), TileInsets(top: 31)),
                       (CGSize(width: 200, height: 240), TileInsets(top: 20, leading: 4, bottom: 6, trailing: 4))]
        let gap = TileGeometry.gap
        for (size, insets) in screens {
            let screen = CGRect(origin: .zero, size: size)
            let safe = CGRect(x: insets.leading, y: insets.top, width: size.width - insets.leading - insets.trailing,
                              height: size.height - insets.top - insets.bottom)
            for arrangement in [TileArrangement.single, .rows(2), .rows(3), .grid] {
                let label = "\(Int(size.width))x\(Int(size.height)) \(arrangement)"
                let slots = TileGeometry.slots(for: arrangement, in: size, insets: insets)
                expectEqual(slots.count, arrangement.capacity, "\(label): one slot per tile")
                // Painted area: whole screen minus the dividers.
                let painted = slots.reduce(0) { $0 + $1.frame.width * $1.frame.height }
                let dividers = gap * size.height * CGFloat(arrangement.columns - 1) + gap * size.width * CGFloat(arrangement.rows - 1)
                    - gap * gap * CGFloat((arrangement.columns - 1) * (arrangement.rows - 1))
                check(abs(painted - (size.width * size.height - dividers)) < 0.01, "\(label): tiles cover the screen edge to edge")
                check(slots.allSatisfy { screen.contains($0.frame) && $0.frame.contains($0.content) && safe.contains($0.content) },
                      "\(label): text area inside the safe area and inside its tile")
                let sizes = Set(slots.map { "\($0.content.width)x\($0.content.height)" })
                expectEqual(sizes.count, 1, "\(label): every tile gets the same text area")
                check(slots.prefix(arrangement.columns).allSatisfy { $0.frame.minY == 0 }, "\(label): top tiles reach under the clock")
                check(slots.suffix(arrangement.columns).allSatisfy { $0.frame.maxY == size.height }, "\(label): bottom tiles reach the bottom edge")
                for (a, b) in zip(slots, slots.dropFirst()) where arrangement.columns == 1 || a.frame.minY == b.frame.minY {
                    let between = arrangement.columns == 1 ? b.frame.minY - a.frame.maxY : b.frame.minX - a.frame.maxX
                    check(abs(between - gap) < 0.001, "\(label): thin divider between neighbours (\(between))")
                }
            }
            check(TileGeometry.slots(for: .empty, in: size, insets: insets).isEmpty, "empty => no slots")
        }
        let grid = TileGeometry.slots(for: .grid, in: CGSize(width: 162, height: 197), insets: TileInsets(top: 28))
        check(grid[0].frame.minX == 0 && grid[1].frame.maxX == 162 && grid[0].frame.minY == grid[1].frame.minY && grid[2].frame.minY > grid[0].frame.maxY,
              "grid is row-major: [top-left, top-right, bottom-left, bottom-right]")
        check(grid[0].content.width > 75 && grid[0].content.height > 80, "40 mm grid tile text area \(grid[0].content.size)")
    }

    suite("tiles: labels (status word + timer)") {
        let clock = ClockSync()
        func p(_ c: SessionCard) -> CardPresentation { CardPresentation(card: c, clock: clock) }
        var failed = card("codex:f", .done, started: 1, finished: 5)
        failed.error = "rate_limit"
        var interrupted = card("codex:x", .done, started: 1, finished: 5)
        interrupted.interrupted = true
        expectEqual(TileLabel.word(p(card("claude:r", .running, started: 1)).tone), "run", "running => run")
        expectEqual(TileLabel.word(p(card("claude:w", .waiting, started: 1, waiting: 2)).tone), "ask", "waiting => ask")
        expectEqual(TileLabel.word(p(card("claude:d", .done, started: 1, finished: 2)).tone), "done", "done => done")
        expectEqual(TileLabel.word(p(failed).tone), "done", "failed counts as done")
        expectEqual(TileLabel.word(p(interrupted).tone), "done", "interrupted counts as done")
        expectEqual(TileLabel.status(.running, elapsed: 754), "run · 12:34", "running line")
        expectEqual(TileLabel.status(.waiting, elapsed: 41), "ask · 0:41", "waiting line")
        expectEqual(TileLabel.status(.done, elapsed: 182), "done · 3:02", "done line")
        expectEqual(TileLabel.status(.running, elapsed: 754, compact: true), "run 12:34", "2x2 grid: no dot")
        expectEqual(TileLabel.status(.done, elapsed: 754, coarse: true), "done · 12m", "Always-On: minutes")
        expectEqual(TileLabel.status(.waiting, elapsed: 30, compact: true, coarse: true), "ask <1m", "Always-On grid")
        expectEqual(TileLabel.status(.unknown, elapsed: nil), "?", "no timer: word only")
        let clocks: [(TimeInterval, String)] = [
            (0, "0:00"), (9.99, "0:09"), (41, "0:41"), (60, "1:00"), (754, "12:34"), (3599, "59:59"), (3600, "1:00:00"),
            (3912, "1:05:12"), (86_399, "23:59:59"), (93_600, "1d 2h"), (-3, "0:00"),
        ]
        for (s, want) in clocks { expectEqual(ElapsedClock.format(s), want, "clock \(s)s") }
        // Timer starts: run from startedAt, ask from waitingSince, done from finishedAt.
        expectEqual(p(card("claude:r", .running, started: 10_000)).timerStart, Date(timeIntervalSince1970: 10), "run counts from startedAt")
        expectEqual(p(card("claude:d", .done, started: 10_000, finished: 50_000)).timerStart, Date(timeIntervalSince1970: 50), "done counts from finishedAt")
        // Tile text never carries the project name.
        check(!TileLabel.status(.running, elapsed: 5).contains("p-r"), "no project on the tile")
    }

    suite("tiles: swipe to reveal delete") {
        let t0 = Date(timeIntervalSince1970: 1_000)
        let w: CGFloat = 40
        var s = SwipeReveal()
        expectEqual(s.timeout, 4, "default inactivity timeout")
        expectEqual(SwipeReveal.revealWidth(tileWidth: 80), 40, "grid tile: half its width")
        expectEqual(SwipeReveal.revealWidth(tileWidth: 162), 60, "full-width tile: capped at 60")
        expectEqual(s.tapTile("a", now: t0), .showDetail("a"), "tap with nothing open => detail")
        expectEqual(s.tapTrash("a"), .ignored, "trash of a closed tile does nothing")

        // Drag follows the finger, clamped.
        s.dragChanged("a", dx: -15, dy: 3)
        expectEqual(s.offset(for: "a", revealWidth: w), -15, "follows the finger")
        expectEqual(s.offset(for: "b", revealWidth: w), 0, "other tiles stay put")
        s.dragChanged("a", dx: -200, dy: 3)
        expectEqual(s.offset(for: "a", revealWidth: w), -(w + SwipeReveal.overshoot), "clamped past fully open")
        s.dragChanged("a", dx: 30, dy: 0)
        expectEqual(s.offset(for: "a", revealWidth: w), 0, "cannot slide right of closed")
        expectEqual(s.tapTile("a", now: t0), .ignored, "tap during a drag ignored")
        // Short drag snaps back; past half-way opens.
        check(!s.dragEnded("a", predictedDX: -15, revealWidth: w, now: t0), "less than half-way: stays closed")
        expectEqual(s.offset(for: "a", revealWidth: w), 0, "snapped back")
        expectEqual(s.tapTile("a", now: t0.addingTimeInterval(0.1)), .ignored, "tap from the same touch as the swipe ignored")
        s.dragChanged("a", dx: -12, dy: 0)
        check(s.dragEnded("a", predictedDX: -35, revealWidth: w, now: t0), "flick (predicted end past half-way) opens")
        check(s.isOpen("a"), "a open")
        expectEqual(s.offset(for: "a", revealWidth: w), -w, "open offset = trash width")
        expectEqual(s.expiresAt, t0.addingTimeInterval(4), "closes 4 s after opening")

        // Vertical movement is not a swipe.
        s.dragChanged("b", dx: 4, dy: 20)
        check(s.dragID == nil && s.isOpen("a"), "vertical drag on b: ignored, a stays open")

        // Only one open: dragging b closes a; b opens.
        s.dragChanged("b", dx: -10, dy: 2)
        check(!s.isOpen("a"), "starting to drag b closes a")
        s.dragEnded("b", predictedDX: -30, revealWidth: w, now: t0.addingTimeInterval(1))
        check(s.isOpen("b") && !s.isOpen("a"), "only b open")

        // Swipe right closes.
        s.dragChanged("b", dx: 25, dy: 0)
        expectEqual(s.offset(for: "b", revealWidth: w), -w + 25, "dragging the open tile back")
        check(!s.dragEnded("b", predictedDX: 25, revealWidth: w, now: t0.addingTimeInterval(2)), "swipe right closes")
        check(s.openID == nil, "nothing open")

        // Tapping elsewhere closes (and does nothing else).
        s.dragChanged("b", dx: -30, dy: 0)
        s.dragEnded("b", predictedDX: -30, revealWidth: w, now: t0.addingTimeInterval(3))
        expectEqual(s.tapTile("c", now: t0.addingTimeInterval(4)), .closed, "tap another tile: closes b, no detail")
        check(s.openID == nil, "closed")
        s.dragChanged("b", dx: -30, dy: 0)
        s.dragEnded("b", predictedDX: -30, revealWidth: w, now: t0.addingTimeInterval(5))
        expectEqual(s.tapTile("b", now: t0.addingTimeInterval(6)), .closed, "tap the open tile itself: closes")
        s.dragChanged("b", dx: -30, dy: 0)
        s.dragEnded("b", predictedDX: -30, revealWidth: w, now: t0.addingTimeInterval(7))
        check(s.close() && s.openID == nil, "background tap / long press closes")

        // Inactivity timeout.
        s.dragChanged("b", dx: -30, dy: 0)
        s.dragEnded("b", predictedDX: -30, revealWidth: w, now: t0)
        check(!s.expire(now: t0.addingTimeInterval(3.9)), "still open before the timeout")
        s.dragChanged("b", dx: 5, dy: 0)
        check(!s.expire(now: t0.addingTimeInterval(9)), "not while the finger is on it")
        s.dragCancelled("b")
        expectEqual(s.offset(for: "b", revealWidth: w), -w, "cancelled touch: back to open, unchanged")
        check(s.expire(now: t0.addingTimeInterval(9)), "closes after the timeout")
        check(s.openID == nil && s.expiresAt == nil, "back to normal")

        // Delete.
        s.dragChanged("b", dx: -30, dy: 0)
        s.dragEnded("b", predictedDX: -30, revealWidth: w, now: t0)
        expectEqual(s.tapTrash("c"), .ignored, "trash of another tile ignored")
        expectEqual(s.tapTrash("b"), .delete("b"), "trash of the open tile deletes it")
        check(s.openID == nil, "closed after delete")
        expectEqual(s.tapTrash("b"), .ignored, "double tap on trash deletes once")

        // Reconcile with the tiles on screen.
        s.dragChanged("a", dx: -30, dy: 0)
        s.dragEnded("a", predictedDX: -30, revealWidth: w, now: t0)
        check(!s.reconcile(visible: ["a", "b"]), "open tile still on screen: kept")
        check(s.reconcile(visible: ["b"]), "open tile gone (deleted elsewhere / pushed out): closed")
        s.dragChanged("b", dx: -5, dy: 0)
        s.reconcile(visible: ["a"])
        check(s.dragID == nil, "drag of a vanished tile dropped")
    }

    await asyncSuite("tiles: swipe + trash deletes through the view model (any status)") {
        let t = Int64(Date().timeIntervalSince1970 * 1000)
        let snap = Snapshot(serverTime: t, sessions: [
            card("claude:s", .done, started: t - 20_000, finished: t - 10_000, policy: .swipe),
            card("codex:l", .done, started: t - 900_000, finished: t - 60_000, policy: .confirm),
            card("claude:r", .running, started: t - 5_000),
            card("codex:w", .waiting, started: t - 7_000, waiting: t - 1_000),
        ])
        let fake = FakeTransport(stream: .deliver([snap], thenFail: false), poll: .success(snap))
        let model = StatusModel(sleeper: fastSleeper, makeTransport: { _ in fake })
        model.start(endpoint: DaemonEndpoint(host: "mac"))
        try await waitUntil { model.hasData }
        var swipe = SwipeReveal()
        @MainActor func swipeAndTrash(_ id: String) async {
            swipe.dragChanged(id, dx: -40, dy: 0)
            swipe.dragEnded(id, predictedDX: -40, revealWidth: 40, now: Date())
            if case .delete(let id) = swipe.tapTrash(id) { await model.dismiss(id: id) }
        }
        expectEqual(model.cards.map(\.id), ["codex:l", "claude:s", "codex:w", "claude:r"], "model keeps start order")
        expectEqual(TilePlan(ordered: model.presentations).arrangement, .grid, "4 sessions => grid")
        for id in ["claude:r", "codex:w", "codex:l"] {
            if case .showDetail = swipe.tapTile(id, now: Date().addingTimeInterval(1)) {} else { check(false, "tap \(id) => detail") }
        }
        expectEqual(fake.dismissed, [], "taps never delete")
        await swipeAndTrash("claude:r")
        expectEqual(fake.dismissed, ["claude:r"], "running session deleted")
        await swipeAndTrash("codex:w")
        expectEqual(fake.dismissed, ["claude:r", "codex:w"], "waiting session deleted")
        await swipeAndTrash("codex:l")
        expectEqual(fake.dismissed, ["claude:r", "codex:w", "codex:l"], "long done session: one trash tap, no confirm step")
        expectEqual(model.cards.map(\.id), ["claude:s"], "removed at once (optimistic)")
        expectEqual(TilePlan(ordered: model.presentations).arrangement, .single, "one session left => whole screen")
        // Failure: the tile comes back in its place.
        let more = Snapshot(serverTime: t + 1, sessions: snap.sessions.filter { $0.id == "claude:s" } + [card("codex:n", .running, started: t)])
        model.ingest(timed(more))
        fake.set(dismiss: .failure(.network("No network")))
        await swipeAndTrash("claude:s")
        expectEqual(model.cards.map(\.id), ["claude:s", "codex:n"], "failed delete restores the tile in the same place")
        check(model.transientError != nil, "error surfaced")
        model.stop()
    }

    suite("tiles: ask timer fallbacks and Always-On durations") {
        let clock = ClockSync()
        let w = CardPresentation(card: card("claude:w", .waiting, started: 10_000, waiting: 70_000), clock: clock)
        expectEqual(w.timerStart, Date(timeIntervalSince1970: 70), "waiting counts from waitingSince")
        let noSince = CardPresentation(card: card("claude:x", .waiting, started: 10_000, updated: 99_000), clock: clock)
        expectEqual(noSince.timerStart, Date(timeIntervalSince1970: 10), "waiting without waitingSince counts from startedAt")
        let cases: [(TimeInterval, String)] = [
            (0, "<1m"), (59.9, "<1m"), (60, "1m"), (754, "12m"), (3599, "59m"), (3600, "1h 00m"), (3912, "1h 05m"),
            (86_399, "23h 59m"), (93_600, "1d 2h"), (-10, "<1m"),
        ]
        for (s, want) in cases { expectEqual(CoarseDuration.format(s), want, "always-on \(s)s") }
    }
}
