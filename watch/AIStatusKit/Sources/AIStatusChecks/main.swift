import AIStatusKit
import AIStatusUI
import Foundation

// swift run AIStatusChecks                    unit checks (fixtures, parser, feed, view model)
// swift run AIStatusChecks --live HOST:PORT [--lan IP --token T]
//                                             + live checks; use scripts/live-check.mjs

let args = CommandLine.arguments
func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

print("AIStatusKit checks")
runDecodingChecks()
runSSEChecks()
runOrderingAndPresentationChecks()
runEndpointChecks()
await runFeedChecks()
await runModelChecks()
await runViewSmokeChecks()

if let live = arg("--live") {
    let parts = live.split(separator: ":")
    await runLiveChecks(host: String(parts[0]), port: Int(parts[1]) ?? 7778, lanHost: arg("--lan"), token: arg("--token"))
}

let h = Harness.shared
print("\n\(h.passed) passed, \(h.failed) failed")
if h.failed > 0 {
    for f in h.failures { print("  - \(f)") }
    exit(1)
}
