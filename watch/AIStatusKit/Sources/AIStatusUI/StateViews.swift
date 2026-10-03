import AIStatusKit
import SwiftUI

struct NotConfiguredView: View {
    let openSettings: () -> Void
    /// False only for off-screen rendering (ImageRenderer cannot draw scroll views).
    var scrolls = true

    var body: some View {
        Scrollable(enabled: scrolls) {
            VStack(spacing: 8) {
                Image(systemName: "laptopcomputer")
                    .font(.largeTitle)
                    .foregroundStyle(.secondary)
                Text("Set your Mac")
                    .font(.headline)
                Text("Enter the Mac's name (e.g. my-macbook → my-macbook.local).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                Button("Settings", action: openSettings)
            }
        }
    }
}

struct ConnectingView: View {
    let host: String

    var body: some View {
        VStack(spacing: 8) {
            ProgressView()
            Text("Connecting to")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Text(host)
                .font(.footnote.weight(.semibold))
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
    }
}

struct EmptySessionsView: View {
    let connection: ConnectionState

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "checkmark.seal")
                .font(.largeTitle)
                .foregroundStyle(.green)
            Text("No active sessions")
                .font(.headline)
            Text(connection == .polling ? "Mac connected (polling)" : "Mac connected")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .multilineTextAlignment(.center)
    }
}

/// The unmistakable "cannot reach Mac" screen.
struct UnreachableView: View {
    let reason: String
    let host: String
    let lastUpdate: Date?
    let lastCounts: StatusCounts?
    let retry: () -> Void
    let openSettings: () -> Void
    var scrolls = true

    var body: some View {
        Scrollable(enabled: scrolls) {
            VStack(spacing: 6) {
                Image(systemName: "wifi.exclamationmark")
                    .font(.largeTitle)
                    .foregroundStyle(.red)
                Text("Can't reach Mac")
                    .font(.headline)
                Text(host)
                    .font(.caption2.weight(.semibold))
                    .lineLimit(2)
                Text(reason)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
                if let lastUpdate {
                    Text("Last update \(Text(lastUpdate, style: .relative)) ago")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if let c = lastCounts, c.total > 0 {
                    Text("Then: \(c.running) running · \(c.waiting) waiting · \(c.done) done")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Button("Retry", action: retry)
                Button("Settings", action: openSettings)
                    .tint(.gray)
            }
            .multilineTextAlignment(.center)
        }
    }
}

struct Scrollable<Content: View>: View {
    let enabled: Bool
    @ViewBuilder let content: () -> Content

    var body: some View {
        if enabled {
            ScrollView { content() }
        } else {
            content()
        }
    }
}
