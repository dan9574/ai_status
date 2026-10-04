import AIStatusKit
import SwiftUI

/// Host / port / token, persisted with AppStorage (same keys as `AIStatusRootView`).
@MainActor
public struct SettingsView: View {
    @AppStorage(SettingsKeys.host) private var host = BuildDefaults.host
    @AppStorage(SettingsKeys.port) private var port = DaemonEndpoint.defaultPort
    @AppStorage(SettingsKeys.token) private var token = BuildDefaults.token
    @AppStorage(SettingsKeys.pollSeconds) private var pollSeconds = PollIntervals.default
    @State private var testResult: String?
    @State private var testing = false

    public init() {}

    private var endpoint: DaemonEndpoint? {
        DaemonEndpoint(host: host, port: port, token: token)
    }

    public var body: some View {
        Form {
            Section {
                TextField("Mac name, IP or https URL", text: $host)
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
            let builtInToken = BuildDefaults.token
            if !fallback.isEmpty, host != fallback {
                Section {
                    Button("Use \(fallback)") { host = fallback }
                }
            }
            if !builtInToken.isEmpty, token != builtInToken {
                Section {
                    Button("Use built-in token") { token = builtInToken }
                }
            }

            Section {
                Picker("Refresh", selection: $pollSeconds) {
                    ForEach(PollIntervals.choices, id: \.self) { Text("\($0) s").tag($0) }
                }
            } footer: {
                Text("How often to ask for updates when the hub has no live stream (cloud hub). Only while the app is on screen.")
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
                Text("On the Mac: `scutil --get LocalHostName` shows the name; run `aistatus daemon`. Watch and Mac must be on the same network, or use the Mac's public https URL (`aistatus public-status`) or the cloud hub URL (`aistatus cloud status`).")
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
