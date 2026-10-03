import Foundation

/// AppStorage keys (UserDefaults of the watch app).
public enum SettingsKeys {
    public static let host = "daemonHost"
    public static let port = "daemonPort"
    public static let token = "daemonToken"
}

/// Values baked in at build time through Info.plist (see watch/Config/*.xcconfig).
public enum BuildDefaults {
    /// Info.plist `AIStatusDefaultHost` = `$(AISTATUS_DEFAULT_HOST)`, e.g. "Daniels-MacBook-Air.local".
    public static var host: String {
        clean(Bundle.main.object(forInfoDictionaryKey: "AIStatusDefaultHost") as? String)
    }

    static func clean(_ value: String?) -> String {
        let v = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return v.contains("$(") ? "" : v // unexpanded build setting
    }
}
