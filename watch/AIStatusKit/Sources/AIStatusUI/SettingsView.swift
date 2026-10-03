import AIStatusKit
import SwiftUI

/// Host / port / token, persisted with AppStorage (same keys as `AIStatusRootView`).
@MainActor
public struct SettingsView: View {
    @AppStorage(SettingsKeys.host) private var host = BuildDefaults.host
    @AppStorage(SettingsKeys.port) private var port = DaemonEndpoint.defaultPort
    @AppStorage(SettingsKeys.token) private var token = ""
    @State private var testResult: String?
    @State private var testing = false

    public init() {}

    private var endpoint: DaemonEndpoint? {
        DaemonEndpoint(host: host, port: port, token: token)
    }

    public var body: some View {
        Form {
            Section {
                TextField("Mac name or IP", text: $host)
                    .autocorrectionDisabled()
                    #if os(watchOS) || os(iOS)
                    .textInputAutocapitalization(.never)
                    #endif
                TextField("Port", value: $port, format: .number.grouping(.never))
                SecureField("Token (optional)", text: $token)
            } header: {
                Text("Mac")
            } footer: {
                if let endpoint {
                    Text(endpoint.baseURLString)
                } else {
                    Text("A bare name gets “.local” added.")
                }
            }

            let fallback = BuildDefaults.host
            if !fallback.isEmpty, host != fallback {
                Section {
                    Button("Use \(fallback)") { host = fallback }
                }
            }

            Section {
                Button(testing ? "Testing…" : "Test connection") { runTest() }
                    .disabled(endpoint == nil || testing)
                if let testResult {
                    Text(testResult)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            } footer: {
                Text("On the Mac: `scutil --get LocalHostName` shows the name; run `aistatus daemon`. Watch and Mac must be on the same network.")
            }
        }
        .navigationTitle("Settings")
    }

    private func runTest() {
        guard let endpoint else { return }
        testing = true
        testResult = nil
        Task { @MainActor in
            switch await StatusModel.test(endpoint: endpoint) {
            case .success(let h):
                testResult = "OK · \(h.name ?? "aistatusd") \(h.version ?? "") · \(h.sessions ?? 0) sessions"
            case .failure(let e):
                testResult = "Failed: \(e.errorDescription ?? "error")"
            }
            testing = false
        }
    }
}
