import Foundation

/// What the app leaves behind for the widget / complication (App Group defaults).
/// Only counts and a little context: the widget never talks to the network.
public struct SharedSnapshot: Codable, Hashable, Sendable {
    public var savedAt: Date
    public var counts: StatusCounts
    /// False when the last thing the app knew was "cannot reach Mac".
    public var reachable: Bool
    public var waitingProjects: [String]
    public var host: String?

    public init(savedAt: Date, counts: StatusCounts, reachable: Bool, waitingProjects: [String] = [], host: String? = nil) {
        self.savedAt = savedAt
        self.counts = counts
        self.reachable = reachable
        self.waitingProjects = waitingProjects
        self.host = host
    }

    /// Equal ignoring `savedAt`, so the widget is only reloaded when something visible changed.
    public func sameContent(as other: SharedSnapshot) -> Bool {
        counts == other.counts && reachable == other.reachable && waitingProjects == other.waitingProjects && host == other.host
    }

    public static let placeholder = SharedSnapshot(
        savedAt: Date(), counts: StatusCounts(running: 2, waiting: 1, done: 1), reachable: true, waitingProjects: ["ai_status"]
    )
}

/// Reads/writes `SharedSnapshot` in the App Group's UserDefaults.
public struct SharedSnapshotStore: @unchecked Sendable {
    public static let key = "aistatus.sharedSnapshot.v1"
    /// Info.plist key holding the App Group id (set from build settings, see project.yml).
    public static let appGroupInfoKey = "AIStatusAppGroup"

    let defaults: UserDefaults
    /// False when the App Group container was unavailable and we fell back to
    /// standard defaults (the widget then cannot see the data).
    public let usesAppGroup: Bool

    public init(suiteName: String?) {
        if let suiteName, !suiteName.isEmpty, !suiteName.contains("$("), let d = UserDefaults(suiteName: suiteName) {
            defaults = d
            usesAppGroup = true
        } else {
            defaults = .standard
            usesAppGroup = false
        }
    }

    /// Uses the App Group named in the main bundle's Info.plist.
    public static func fromMainBundle() -> SharedSnapshotStore {
        SharedSnapshotStore(suiteName: Bundle.main.object(forInfoDictionaryKey: appGroupInfoKey) as? String)
    }

    public func load() -> SharedSnapshot? {
        guard let data = defaults.data(forKey: Self.key) else { return nil }
        return try? JSONDecoder().decode(SharedSnapshot.self, from: data)
    }

    public func save(_ snapshot: SharedSnapshot) {
        guard let data = try? JSONEncoder().encode(snapshot) else { return }
        defaults.set(data, forKey: Self.key)
    }

    public func clear() {
        defaults.removeObject(forKey: Self.key)
    }
}
