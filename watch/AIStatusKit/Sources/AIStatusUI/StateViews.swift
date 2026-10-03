import AIStatusKit
import SwiftUI

// Full-screen states shown only when there are no tiles to draw. Each fits a
// 40 mm screen without scrolling; settings stay one tap (or a long press) away.

struct NotConfiguredView: View {
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: "laptopcomputer")
                .font(.system(size: 28))
                .foregroundStyle(.secondary)
            Text("Set your Mac")
                .font(.system(size: 17, weight: .semibold, design: .rounded))
            Text("e.g. my-macbook → my-macbook.local")
                .font(.system(size: 12))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button("Settings", action: openSettings)
                .buttonStyle(PillButtonStyle())
        }
        .padding(.horizontal, 6)
    }
}

struct ConnectingView: View {
    let host: String

    var body: some View {
        VStack(spacing: 8) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.secondary)
                .symbolEffect(.variableColor.iterative)
            Text(host)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 6)
    }
}

/// Connected, nothing running: quiet on purpose.
struct EmptySessionsView: View {
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 6) {
            Spacer(minLength: 0)
            Image(systemName: "checkmark")
                .font(.system(size: 22, weight: .semibold))
                .foregroundStyle(Color(white: 0.4))
            Text("No sessions")
                .font(.system(size: 15, weight: .medium, design: .rounded))
                .foregroundStyle(Color(white: 0.55))
            Spacer(minLength: 0)
            SettingsGlyphButton(action: openSettings)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// "Can't reach Mac" — only when there are no last-known tiles to show
/// (with tiles on screen, a small red mark in the corner says the same).
struct UnreachableView: View {
    let reason: String
    let host: String
    let retry: () -> Void
    let openSettings: () -> Void

    var body: some View {
        VStack(spacing: 4) {
            Image(systemName: "wifi.exclamationmark")
                .font(.system(size: 24, weight: .semibold))
                .foregroundStyle(.red)
            Text("Can't reach Mac")
                .font(.system(size: 16, weight: .semibold, design: .rounded))
            Text(host)
                .font(.system(size: 11, weight: .medium))
                .lineLimit(1)
                .truncationMode(.middle)
                .minimumScaleFactor(0.8)
            Text(reason)
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .lineLimit(2)
                .minimumScaleFactor(0.85)
            HStack(spacing: 6) {
                Button("Retry", action: retry)
                    .buttonStyle(PillButtonStyle(prominent: true))
                SettingsGlyphButton(action: openSettings)
            }
            .padding(.top, 2)
        }
        .multilineTextAlignment(.center)
        .padding(.horizontal, 6)
    }
}

struct SettingsGlyphButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: "gearshape.fill")
        }
        .buttonStyle(PillButtonStyle())
        .accessibilityLabel("Settings")
    }
}

/// Compact capsule button (the stock watch button is a full-width slab).
struct PillButtonStyle: ButtonStyle {
    var prominent = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold, design: .rounded))
            .foregroundStyle(prominent ? Color.black : Color.white)
            .padding(.horizontal, 14)
            .frame(minHeight: 32)
            .background(Capsule().fill(prominent ? Color.white : Color(white: 0.22)))
            .opacity(configuration.isPressed ? 0.6 : 1)
            .contentShape(Capsule())
    }
}
