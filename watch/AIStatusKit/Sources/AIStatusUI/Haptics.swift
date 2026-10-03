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
}
