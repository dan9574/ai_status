import Foundation

/// AppStorage keys (UserDefaults of the watch app).
public enum SettingsKeys {
    public static let host = "daemonHost"
    public static let port = "daemonPort"
    public static let token = "daemonToken"
    /// Seconds between polls when the server has no event stream (cloud hub).
    public static let pollSeconds = "pollSeconds"
}

/// Choices for `SettingsKeys.pollSeconds` (default 5 s).
public enum PollIntervals {
    public static let `default` = 5
    public static let choices = [3, 5, 10, 15, 30, 60]
}

/// Values baked in at build time through Info.plist (see watch/Config/*.xcconfig,
/// written by `watch/scripts/generate.sh --host … --token …`). They are the
/// defaults until the user edits the field in Settings.
public enum BuildDefaults {
    public static let hostKey = "AIStatusDefaultHost"
    public static let tokenKey = "AIStatusDefaultToken"

    /// Info.plist `AIStatusDefaultHost` = `$(AISTATUS_DEFAULT_HOST)`, e.g.
    /// "Daniels-MacBook-Air.local" or "https://mac.tailnet.ts.net".
    public static var host: String { host(in: Bundle.main.infoDictionary) }
    /// Info.plist `AIStatusDefaultToken` = `$(AISTATUS_DEFAULT_TOKEN)`: the daemon's
    /// read token, so it does not have to be typed on the watch.
    public static var token: String { token(in: Bundle.main.infoDictionary) }

    public static func host(in info: [String: Any]?) -> String { clean(info?[hostKey] as? String) }
    public static func token(in info: [String: Any]?) -> String { clean(info?[tokenKey] as? String) }

    public static func clean(_ value: String?) -> String {
        let v = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return v.contains("$(") ? "" : v // unexpanded build setting
    }
}
