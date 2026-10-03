import AIStatusKit
#if os(watchOS)
import WatchKit
#endif

/// Wrist taps for status changes while the app is open.
public enum Haptics {
    public static func play(for transition: Transition) {
        #if os(watchOS)
        switch transition {
        case .becameWaiting: WKInterfaceDevice.current().play(.notification)
        case .becameDone: WKInterfaceDevice.current().play(.success)
        }
        #endif
    }

    /// First tap on a long-task done tile ("tap again to clear").
    static func armed() {
        #if os(watchOS)
        WKInterfaceDevice.current().play(.click)
        #endif
    }
}
