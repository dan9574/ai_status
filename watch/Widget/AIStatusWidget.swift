import AIStatusKit
import AIStatusUI
import SwiftUI
import WidgetKit

/// Smart Stack / complication: running · waiting · done counts from the last
/// snapshot the app saved to the App Group. The widget never touches the network;
/// the app reloads its timeline whenever the counts change.
struct CountsEntry: TimelineEntry {
    let date: Date
    let snapshot: SharedSnapshot?
}

struct CountsProvider: TimelineProvider {
    private let store = SharedSnapshotStore.fromMainBundle()

    func placeholder(in context: Context) -> CountsEntry {
        CountsEntry(date: Date(), snapshot: .placeholder)
    }

    func getSnapshot(in context: Context, completion: @escaping (CountsEntry) -> Void) {
        completion(CountsEntry(date: Date(), snapshot: context.isPreview ? .placeholder : store.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<CountsEntry>) -> Void) {
        completion(Timeline(entries: [CountsEntry(date: Date(), snapshot: store.load())], policy: .never))
    }
}

struct SessionCountsWidget: Widget {
    let kind = "AIStatusSessionCounts"

    private var families: [WidgetFamily] {
        #if os(watchOS)
        [.accessoryRectangular, .accessoryCircular, .accessoryInline, .accessoryCorner]
        #else
        [.systemSmall]
        #endif
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: CountsProvider()) { entry in
            StatusCountsWidgetView(snapshot: entry.snapshot)
                .containerBackground(for: .widget) { Color.clear }
        }
        .configurationDisplayName("AI Sessions")
        .description("Running, waiting and finished Claude Code / Codex sessions.")
        .supportedFamilies(families)
    }
}

@main
struct AIStatusWidgets: WidgetBundle {
    var body: some Widget {
        SessionCountsWidget()
    }
}
