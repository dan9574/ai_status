// swift-tools-version:5.10
// AIStatusKit: everything of the watch app that can be built and tested on a Mac
// with only the Command Line Tools (no Xcode, no watchOS SDK):
//   AIStatusKit     models, JSON decoding, SSE parser, networking, feed loop, view model
//   AIStatusUI      SwiftUI views (type-checked on macOS; watch-only APIs behind #if os(watchOS))
//   AIStatusChecks  executable test runner (XCTest / Swift Testing are not available with CLT)
// The Xcode project (../project.yml) links AIStatusKit + AIStatusUI into the watch app and widget.
import PackageDescription

let package = Package(
    name: "AIStatusKit",
    platforms: [.macOS(.v14), .watchOS("11.0")],
    products: [
        .library(name: "AIStatusKit", targets: ["AIStatusKit"]),
        .library(name: "AIStatusUI", targets: ["AIStatusUI"]),
    ],
    targets: [
        .target(name: "AIStatusKit"),
        .target(name: "AIStatusUI", dependencies: ["AIStatusKit"]),
        .executableTarget(name: "AIStatusChecks", dependencies: ["AIStatusKit", "AIStatusUI"]),
    ]
)
