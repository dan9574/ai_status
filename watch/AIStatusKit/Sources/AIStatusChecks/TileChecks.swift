import AIStatusKit
import CoreGraphics
import Foundation

/// The tile screen's logic: arrangement per count, top-4 selection and "+N",
/// slot geometry, tap-to-clear state machine, Always-On durations.
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

    suite("tiles: top-4 selection and +N") {
        let cards = [
            card("claude:r-old", .running, started: 10),
            card("claude:r-new", .running, started: 90),
            card("claude:d-new", .done, started: 1, finished: 80),
            card("claude:w-new", .waiting, started: 5, waiting: 70),
            card("codex:d-old", .done, started: 2, finished: 40, policy: .swipe),
            card("codex:w-old", .waiting, started: 6, waiting: 30),
            card("codex:d-mid", .done, started: 3, finished: 60),
        ]
        let plan = TilePlan(cards: cards)
        expectEqual(plan.arrangement, .grid, "7 sessions => grid")
        expectEqual(plan.tiles.map(\.id), ["codex:w-old", "claude:w-new", "codex:d-old", "codex:d-mid"],
                    "waiting (longest waiting first), then done (oldest finished first)")
        expectEqual(plan.overflow, 3, "+3 badge")
        let few = TilePlan(cards: [card("claude:r", .running, started: 1), card("claude:d", .done, started: 1, finished: 5)])
        expectEqual(few.arrangement, .rows(2), "2 sessions => 2 rows")
        expectEqual(few.tiles.map(\.id), ["claude:d", "claude:r"], "done above running")
        expectEqual(few.overflow, 0, "no badge when everything fits")
        let four = TilePlan(cards: Array(cards.prefix(4)))
        expectEqual(four.overflow, 0, "exactly 4: no badge")
        expectEqual(four.tiles.last?.id, "claude:r-new", "running fills the rest, oldest start first")
        let running = TilePlan(cards: [card("claude:b", .running, started: 50), card("claude:a", .running, started: 20),
                                       card("claude:c", .running, started: 70), card("claude:d", .running, started: 10),
                                       card("claude:e", .running, started: 5)])
        expectEqual(running.tiles.map(\.id), ["claude:e", "claude:d", "claude:a", "claude:b"], "running only: existing WatchOrdering")
        expectEqual(running.overflow, 1, "+1 badge")
        let none = TilePlan<SessionCard>(ordered: [])
        expectEqual(none.arrangement, .empty, "0 sessions => empty")
        check(none.tiles.isEmpty && none.overflow == 0, "empty plan")
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

    suite("tiles: tap to clear") {
        let t0 = Date(timeIntervalSince1970: 1_000)
        let clock = ClockSync()
        func p(_ c: SessionCard) -> CardPresentation { CardPresentation(card: c, clock: clock) }
        let running = p(card("claude:r", .running, started: 1))
        let waiting = p(card("claude:w", .waiting, started: 1, waiting: 2))
        let short = p(card("claude:s", .done, started: 1, finished: 2, policy: .swipe))
        let long = p(card("codex:l", .done, started: 1, finished: 900_000, policy: .confirm))
        let long2 = p(card("codex:m", .done, started: 1, finished: 800_000, policy: .confirm))
        var failedCard = card("codex:f", .done, started: 1, finished: 5, policy: .swipe)
        failedCard.error = "rate_limit"
        let failed = p(failedCard)

        var taps = TapToClear()
        expectEqual(taps.timeout, 3, "default confirm window")
        expectEqual(taps.tap(running, now: t0), .ignored, "running: tap does nothing")
        expectEqual(taps.tap(waiting, now: t0), .ignored, "waiting: tap does nothing")
        check(taps.armedID == nil, "nothing armed by running/waiting taps")
        expectEqual(taps.tap(short, now: t0), .clear("claude:s"), "short task (swipe policy): first tap clears")
        expectEqual(taps.tap(failed, now: t0), .clear("codex:f"), "failed/interrupted done tiles clear too")

        // Long task: tap, tap again.
        expectEqual(taps.tap(long, now: t0), .armed("codex:l"), "long task: first tap arms")
        check(taps.isArmed("codex:l", now: t0.addingTimeInterval(1)), "armed shows 'tap again'")
        expectEqual(taps.expiresAt, t0.addingTimeInterval(3), "reverts after the window")
        expectEqual(taps.tap(long, now: t0.addingTimeInterval(2.9)), .clear("codex:l"), "second tap within the window clears")
        check(taps.armedID == nil, "disarmed after clearing")

        // Timeout: reverts, next tap arms again instead of clearing.
        _ = taps.tap(long, now: t0)
        check(!taps.expire(now: t0.addingTimeInterval(2)), "no revert before the window ends")
        check(taps.expire(now: t0.addingTimeInterval(3)), "reverts when the window ends")
        check(taps.armedID == nil && taps.armedAt == nil, "back to normal")
        _ = taps.tap(long, now: t0)
        expectEqual(taps.tap(long, now: t0.addingTimeInterval(3.5)), .armed("codex:l"), "late second tap (view not yet reverted) re-arms, never clears")

        // Only one armed tile.
        expectEqual(taps.tap(long2, now: t0.addingTimeInterval(4)), .armed("codex:m"), "arming another tile")
        check(!taps.isArmed("codex:l", now: t0.addingTimeInterval(4)) && taps.isArmed("codex:m", now: t0.addingTimeInterval(4)), "moves the armed state")
        expectEqual(taps.tap(running, now: t0.addingTimeInterval(4.5)), .ignored, "tap on a running tile")
        check(taps.isArmed("codex:m", now: t0.addingTimeInterval(4.5)), "…leaves the armed tile alone")
        expectEqual(taps.tap(long, now: t0.addingTimeInterval(5)), .armed("codex:l"), "first tap on the other long tile arms it, does not clear")

        // Reconcile with new snapshots.
        check(!taps.reconcile(with: [long, long2]), "armed tile still done: kept")
        var restarted = card("codex:l", .running, started: 950_000)
        restarted.updatedAt = 950_000
        check(taps.reconcile(with: [p(restarted), long2]), "armed tile started a new run: disarmed")
        _ = taps.tap(long2, now: t0)
        check(taps.reconcile(with: [long]), "armed tile cleared elsewhere: disarmed")
        check(taps.armedID == nil, "nothing armed")
    }

    await asyncSuite("tiles: tap clears through the view model") {
        let t = Int64(Date().timeIntervalSince1970 * 1000)
        let snap = Snapshot(serverTime: t, sessions: [
            card("claude:s", .done, started: t - 20_000, finished: t - 10_000, policy: .swipe),
            card("codex:l", .done, started: t - 900_000, finished: t - 60_000, policy: .confirm),
            card("claude:r", .running, started: t - 5_000),
        ])
        let fake = FakeTransport(stream: .deliver([snap], thenFail: false), poll: .success(snap))
        let model = StatusModel(sleeper: fastSleeper, makeTransport: { _ in fake })
        model.start(endpoint: DaemonEndpoint(host: "mac"))
        try await waitUntil { model.hasData }
        var taps = TapToClear()
        @MainActor func tap(_ id: String, at offset: TimeInterval) async {
            guard let p = model.presentations.first(where: { $0.id == id }) else { return check(false, "\(id) on screen") }
            if case .clear(let id) = taps.tap(p, now: Date().addingTimeInterval(offset)) { await model.dismiss(id: id) }
        }
        expectEqual(TilePlan(ordered: model.presentations).arrangement, .rows(3), "3 sessions => 3 rows")
        await tap("claude:r", at: 0)
        await tap("claude:s", at: 0)
        expectEqual(fake.dismissed, ["claude:s"], "short task: one tap sends dismiss")
        expectEqual(model.cards.map(\.id), ["codex:l", "claude:r"], "removed at once (optimistic)")
        await tap("codex:l", at: 0)
        expectEqual(fake.dismissed, ["claude:s"], "long task: first tap sends nothing")
        await tap("codex:l", at: 1)
        expectEqual(fake.dismissed, ["claude:s", "codex:l"], "long task: second tap sends dismiss")
        expectEqual(TilePlan(ordered: model.presentations).arrangement, .single, "one session left => whole screen")
        model.stop()
    }

    suite("tiles: waiting timer and Always-On durations") {
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
