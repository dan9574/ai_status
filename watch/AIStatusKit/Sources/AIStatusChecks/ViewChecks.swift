import AIStatusKit
import AIStatusUI
import Foundation
import SwiftUI

/// Renders every screen off-screen with SwiftUI's ImageRenderer at the Apple
/// Watch SE 40 mm and 44 mm point sizes (macOS rendering: proves the view code
/// runs and lets you eyeball layout; it is not watchOS's renderer). Set
/// RENDER_DIR=/some/dir to write PNGs (`<size>-<screen>.png` plus an
/// `overview-<size>.png` contact sheet); watch/previews holds the committed set.
@MainActor
func runViewSmokeChecks() async {
    await asyncSuite("SwiftUI render smoke test (macOS)") {
        let dir = ProcessInfo.processInfo.environment["RENDER_DIR"].map { URL(fileURLWithPath: $0) }
        if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        let scale: CGFloat = 2
        // Timer text renders against the real clock, so samples are relative to now.
        let now = Date()
        for display in WatchDisplay.all {
            let screens = ScreenCatalog.screens(on: display, now: now)
            for (name, view) in screens {
                let renderer = ImageRenderer(content: view)
                renderer.scale = scale
                guard let image = renderer.cgImage else {
                    check(false, "\(display.name) \(name) rendered")
                    continue
                }
                let want = (Int(display.size.width * scale), Int(display.size.height * scale))
                check(image.width == want.0 && image.height == want.1,
                      "\(display.name) \(name) rendered at full screen size (\(image.width)x\(image.height))")
                if let dir { try writePNG(image, to: dir.appendingPathComponent("\(display.name)-\(name).png")) }
            }
            if let dir {
                let sheet = ImageRenderer(content: ContactSheet(display: display, screens: screens))
                sheet.scale = scale
                if let image = sheet.cgImage {
                    try writePNG(image, to: dir.appendingPathComponent("overview-\(display.name).png"))
                }
            }
        }
        for (name, view) in ScreenCatalog.widgets(now: now) {
            let r = ImageRenderer(content: view.frame(width: 184, height: 90).background(Color.black).environment(\.colorScheme, .dark))
            check(r.cgImage != nil, "\(name) rendered")
        }
        // The real root view (geometry readers, sheet, AppStorage) also renders.
        let root = ImageRenderer(content: AIStatusRootView(sharedStore: SharedSnapshotStore(suiteName: nil))
            .frame(width: 162, height: 197))
        check(root.cgImage != nil, "AIStatusRootView renders")
        let settings = ImageRenderer(content: NavigationStack { SettingsView() }.frame(width: 184, height: 224))
        check(settings.cgImage != nil, "SettingsView renders")
    }
}

private func writePNG(_ image: CGImage, to url: URL) throws {
    let rep = NSBitmapImageRep(cgImage: image)
    guard let png = rep.representation(using: .png, properties: [:]) else { return }
    try png.write(to: url)
}

/// All screens of one display size side by side, labelled.
private struct ContactSheet: View {
    let display: WatchDisplay
    let screens: [(name: String, view: AnyView)]

    var body: some View {
        let perRow = 4
        let rows = stride(from: 0, to: screens.count, by: perRow).map { Array(screens.indices)[$0..<min($0 + perRow, screens.count)] }
        VStack(alignment: .leading, spacing: 14) {
            ForEach(rows.indices, id: \.self) { r in
                HStack(alignment: .top, spacing: 14) {
                    ForEach(rows[r], id: \.self) { i in
                        VStack(spacing: 4) {
                            screens[i].view
                            Text(screens[i].name)
                                .font(.system(size: 11, weight: .medium, design: .monospaced))
                                .foregroundStyle(.white.opacity(0.8))
                        }
                    }
                }
            }
        }
        .padding(16)
        .background(Color(white: 0.16))
    }
}
