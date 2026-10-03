import Foundation

/// Estimates `serverClock - localClock` from the `serverTime` field of each
/// snapshot, so server timestamps can be turned into local `Date`s for
/// self-updating `Text(date, style: .timer)` views.
///
/// Each sample is `serverTime - midpoint(localSend, localReceive)`. For SSE
/// snapshots send == receive (the event is pushed), which biases the sample by
/// the one-way LAN latency (milliseconds; irrelevant at 1 s display resolution).
/// The median of the last few samples rejects the odd delayed response.
public struct ClockSync: Equatable, Sendable {
    public private(set) var samples: [Double] = [] // seconds, newest last
    public let window: Int

    public init(window: Int = 5) {
        self.window = max(1, window)
    }

    /// Current offset estimate in seconds (server minus local); 0 until the first sample.
    public var offset: TimeInterval {
        guard !samples.isEmpty else { return 0 }
        let sorted = samples.sorted()
        let n = sorted.count
        return n % 2 == 1 ? sorted[n / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    }

    public mutating func record(serverTimeMs: Int64, sentAt: Date, receivedAt: Date) {
        let mid = sentAt.timeIntervalSince1970 + receivedAt.timeIntervalSince(sentAt) / 2
        samples.append(Double(serverTimeMs) / 1000 - mid)
        if samples.count > window { samples.removeFirst(samples.count - window) }
    }

    public mutating func reset() {
        samples.removeAll()
    }

    /// A server epoch-ms timestamp expressed on the local clock.
    public func localDate(serverMs: Int64) -> Date {
        Date(timeIntervalSince1970: Double(serverMs) / 1000 - offset)
    }

    public func localDate(serverMs: Int64?) -> Date? {
        serverMs.map { localDate(serverMs: $0) }
    }
}

/// Short human durations for labels that do not tick ("ran 4m 10s").
public enum DurationFormat {
    /// 42s · 4m 10s · 12m · 1h 04m · 2d 3h
    public static func short(_ seconds: TimeInterval) -> String {
        let s = max(0, Int(seconds.rounded(.down)))
        if s < 60 { return "\(s)s" }
        let m = s / 60
        if m < 10 { return "\(m)m \(pad(s % 60))s" }
        if m < 60 { return "\(m)m" }
        let h = m / 60
        if h < 24 { return "\(h)h \(pad(m % 60))m" }
        return "\(h / 24)d \(h % 24)h"
    }

    public static func short(ms: Int64) -> String {
        short(TimeInterval(ms) / 1000)
    }

    private static func pad(_ v: Int) -> String {
        v < 10 ? "0\(v)" : "\(v)"
    }
}
