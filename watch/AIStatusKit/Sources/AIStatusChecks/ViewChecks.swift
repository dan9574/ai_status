import AIStatusKit
import AIStatusUI
import Foundation
import SwiftUI

/// Renders every screen off-screen with SwiftUI's ImageRenderer (macOS rendering,
/// at roughly a 46 mm watch's point size). This proves the view code runs, not
/// just compiles; it says nothing about watchOS-specific layout. Set
/// RENDER_DIR=/some/dir to also write PNGs for eyeballing.
@MainActor
func runViewSmokeChecks() async {
    await asyncSuite("SwiftUI render smoke test (macOS)") {
        let dir = ProcessInfo.processInfo.environment["RENDER_DIR"].map { URL(fileURLWithPath: $0) }
        if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
        for (name, view) in ScreenCatalog.screens() {
            let framed = view
                .padding(4)
                .frame(width: 208, height: name == "list" ? 420 : 248, alignment: .top)
                .background(Color.black)
                .environment(\.colorScheme, .dark)
            let renderer = ImageRenderer(content: framed)
            renderer.scale = 2
            guard let image = renderer.cgImage else {
                check(false, "\(name) rendered")
                continue
            }
            check(image.width == 416, "\(name) rendered (\(image.width)x\(image.height))")
            if let dir, let rep = renderer.nsImage.flatMap({ NSBitmapImageRep(data: $0.tiffRepresentation ?? Data()) }),
               let png = rep.representation(using: .png, properties: [:]) {
                try png.write(to: dir.appendingPathComponent("\(name).png"))
            }
        }
        // The real root view (NavigationStack + toolbar + AppStorage) also renders.
        let root = ImageRenderer(content: AIStatusRootView(sharedStore: SharedSnapshotStore(suiteName: nil))
            .frame(width: 208, height: 248))
        check(root.cgImage != nil, "AIStatusRootView renders")
        let settings = ImageRenderer(content: NavigationStack { SettingsView() }.frame(width: 208, height: 248))
        check(settings.cgImage != nil, "SettingsView renders")
    }
}
