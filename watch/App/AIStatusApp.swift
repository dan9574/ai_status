import AIStatusKit
import AIStatusUI
import SwiftUI
import WidgetKit

/// Standalone watchOS app (no iPhone companion). All UI and logic live in the
/// AIStatusKit package (AIStatusUI.AIStatusRootView) so they can be built and
/// tested on a Mac without the watchOS SDK; this file only hosts it.
@main
struct AIStatusWatchApp: App {
    var body: some Scene {
        WindowGroup {
            AIStatusRootView(
                sharedStore: .fromMainBundle(),
                onWidgetDataChanged: { WidgetCenter.shared.reloadAllTimelines() }
            )
        }
    }
}
