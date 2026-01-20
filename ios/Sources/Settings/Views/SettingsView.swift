import SwiftUI

// MARK: - TTS Quality Setting

/// TTS quality/provider setting - determines which TTS backend to use
enum TTSQuality: String, CaseIterable {
    case standard = "standard"    // Kokoro (selfhosted) - faster, free
    case premium = "premium"      // ElevenLabs - higher quality, uses quota

    var displayName: String {
        switch self {
        case .standard: return "Standard"
        case .premium: return "Premium"
        }
    }

    var description: String {
        switch self {
        case .standard: return "Kokoro - Fast, unlimited"
        case .premium: return "ElevenLabs - Higher quality"
        }
    }

    /// Maps to ListenAICloudService.TTSProvider
    var providerRawValue: String {
        switch self {
        case .standard: return "selfhosted"
        case .premium: return "elevenlabs"
        }
    }
}

// MARK: - Settings View

/// Enhanced settings view with voice cloning, linked accounts, and support sections.
struct SettingsView: View {
    @EnvironmentObject var usageTracker: UsageTrackerService
    @AppStorage("defaultPlaybackSpeed") private var defaultPlaybackSpeed: Double = 1.0
    @AppStorage("skipSilences") private var skipSilences = false
    @AppStorage("autoPlayNext") private var autoPlayNext = true
    @AppStorage("appLanguage") private var appLanguage = "en-US"
    @AppStorage("ttsQuality") private var ttsQualityRaw: String = TTSQuality.standard.rawValue

    private var ttsQuality: TTSQuality {
        get { TTSQuality(rawValue: ttsQualityRaw) ?? .standard }
        set { ttsQualityRaw = newValue.rawValue }
    }

    @State private var showingVoiceCloning = false
    @State private var showingVoicePicker = false
    @State private var showingLanguagePicker = false
    @State private var showingFeatureRequest = false
    @State private var showingLinkedAccounts = false
    @State private var showingUsageDetails = false

    // Current voice name - TODO: Connect to actual voice selection
    @State private var currentVoiceName = "Narrator"

    var body: some View {
        List {
            // Preferences Section (matches reference order)
            preferencesSection

            // Linked Accounts Section (prominent like reference)
            linkedAccountsSection

            // Share Section
            shareSection

            // Playback Section (moved down from top)
            playbackSection

            // Support Section
            supportSection

            // About Section
            aboutSection
        }
        .navigationTitle("Settings")
        .sheet(isPresented: $showingVoiceCloning) {
            NavigationStack {
                VoiceCloningView()
            }
        }
        .sheet(isPresented: $showingVoicePicker) {
            SelectVoiceView()
        }
        .sheet(isPresented: $showingLanguagePicker) {
            LanguagePickerView(selectedLanguage: $appLanguage)
        }
        .sheet(isPresented: $showingFeatureRequest) {
            FeatureRequestView()
        }
        .sheet(isPresented: $showingLinkedAccounts) {
            NavigationStack {
                LinkedAccountsView()
            }
        }
        .sheet(isPresented: $showingUsageDetails) {
            NavigationStack {
                UsageQuotaView()
            }
        }
    }

    // MARK: - Preferences Section

    private var preferencesSection: some View {
        Section {
            // Voice Cloning
            Button {
                showingVoiceCloning = true
            } label: {
                SettingsRow(
                    icon: "mic.fill",
                    iconColor: .purple,
                    title: "Voice Cloning",
                    showChevron: true
                )
            }
            .buttonStyle(.plain)

            // Change Voice
            Button {
                showingVoicePicker = true
            } label: {
                SettingsRow(
                    icon: "waveform",
                    iconColor: .blue,
                    title: "Change Voice",
                    value: currentVoiceName
                )
            }
            .buttonStyle(.plain)

            // TTS Quality
            HStack {
                SettingsIconView(icon: "sparkles", color: .orange)
                Text("Voice Quality")
                Spacer()
                Picker("", selection: $ttsQualityRaw) {
                    ForEach(TTSQuality.allCases, id: \.rawValue) { quality in
                        Text(quality.displayName).tag(quality.rawValue)
                    }
                }
                .pickerStyle(.menu)
            }

            // App Language
            Button {
                showingLanguagePicker = true
            } label: {
                SettingsRow(
                    icon: "globe",
                    iconColor: .green,
                    title: "App Language",
                    value: languageDisplayName
                )
            }
            .buttonStyle(.plain)

            // Request Feature
            Button {
                showingFeatureRequest = true
            } label: {
                SettingsRow(
                    icon: "lightbulb.fill",
                    iconColor: .yellow,
                    title: "Request Feature",
                    showChevron: true
                )
            }
            .buttonStyle(.plain)
        } header: {
            Text("Preferences")
        }
    }

    private var languageDisplayName: String {
        let locale = Locale(identifier: appLanguage)
        return locale.localizedString(forIdentifier: appLanguage) ?? appLanguage
    }

    // MARK: - Playback Section

    private var playbackSection: some View {
        Section {
            // Default Speed
            HStack {
                SettingsIconView(icon: "speedometer", color: .orange)
                Text("Default Speed")
                Spacer()
                Picker("", selection: $defaultPlaybackSpeed) {
                    Text("0.5x").tag(0.5)
                    Text("0.75x").tag(0.75)
                    Text("1x").tag(1.0)
                    Text("1.25x").tag(1.25)
                    Text("1.5x").tag(1.5)
                    Text("2x").tag(2.0)
                }
                .pickerStyle(.menu)
            }

            // Skip Silences
            Toggle(isOn: $skipSilences) {
                HStack {
                    SettingsIconView(icon: "forward.fill", color: .cyan)
                    Text("Skip Silences")
                }
            }

            // Auto-Play Next
            Toggle(isOn: $autoPlayNext) {
                HStack {
                    SettingsIconView(icon: "play.circle.fill", color: .green)
                    Text("Auto-Play Next")
                }
            }
        } header: {
            Text("Playback")
        }
    }

    // MARK: - Linked Accounts Section

    @StateObject private var googleAuth = GoogleAuthService.shared
    @State private var isConnectingGoogle = false
    @State private var googleAuthError: String?

    private var linkedAccountsSection: some View {
        Section {
            HStack {
                // Google icon (multicolor G)
                Image(systemName: "g.circle.fill")
                    .font(.title)
                    .foregroundStyle(.red, .white)

                VStack(alignment: .leading, spacing: 2) {
                    Text("Google")
                        .foregroundStyle(.primary)

                    if googleAuth.isAuthenticated, let email = googleAuth.userEmail {
                        Text(email)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                // Connect/Disconnect button (coral color when connected like reference)
                if isConnectingGoogle {
                    ProgressView()
                        .padding(.horizontal, 16)
                } else {
                    Button {
                        if googleAuth.isAuthenticated {
                            disconnectGoogle()
                        } else {
                            connectGoogle()
                        }
                    } label: {
                        Text(googleAuth.isAuthenticated ? "Disconnect" : "Connect")
                            .font(.subheadline.weight(.medium))
                            .padding(.horizontal, 16)
                            .padding(.vertical, 8)
                            .background(googleAuth.isAuthenticated ? Color(red: 1.0, green: 0.4, blue: 0.4) : Color.blue)
                            .foregroundStyle(.white)
                            .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.vertical, 4)
        } header: {
            Text("Linked Accounts")
        } footer: {
            Text("Connect Google to import emails from Gmail and listen to them.")
        }
        .alert("Google Sign-In Error", isPresented: .constant(googleAuthError != nil)) {
            Button("OK") { googleAuthError = nil }
        } message: {
            Text(googleAuthError ?? "")
        }
    }

    private func connectGoogle() {
        isConnectingGoogle = true
        Task {
            do {
                try await googleAuth.signIn()
                isConnectingGoogle = false
            } catch let error as GoogleAuthError {
                isConnectingGoogle = false
                if case .userCancelled = error {
                    // User cancelled, don't show error
                } else {
                    googleAuthError = error.localizedDescription
                }
            } catch {
                isConnectingGoogle = false
                googleAuthError = error.localizedDescription
            }
        }
    }

    private func disconnectGoogle() {
        googleAuth.signOut()
        // Clear Gmail cache when disconnecting
        GmailService.shared.clearCache()
    }

    // MARK: - Share Section

    private var shareSection: some View {
        Section {
            Button {
                shareApp()
            } label: {
                SettingsRow(
                    icon: "square.and.arrow.up",
                    iconColor: .blue,
                    title: "Share ReadAloud AI",
                    showChevron: true
                )
            }
            .buttonStyle(.plain)
        } header: {
            Text("Share")
        }
    }

    // MARK: - Support Section

    private var supportSection: some View {
        Section {
            Button {
                rateApp()
            } label: {
                SettingsRow(
                    icon: "hand.thumbsup.fill",
                    iconColor: .pink,
                    title: "Like us, Rate us",
                    showChevron: true
                )
            }
            .buttonStyle(.plain)

            Button {
                contactSupport()
            } label: {
                SettingsRow(
                    icon: "envelope.fill",
                    iconColor: .indigo,
                    title: "Contact Support",
                    showChevron: true
                )
            }
            .buttonStyle(.plain)

            Button {
                showingUsageDetails = true
            } label: {
                SettingsRow(
                    icon: "chart.bar.fill",
                    iconColor: .teal,
                    title: "Usage & Quota",
                    showChevron: true
                )
            }
            .buttonStyle(.plain)
        } header: {
            Text("Support")
        }
    }

    // MARK: - About Section

    private var aboutSection: some View {
        Section {
            HStack {
                Text("Version")
                Spacer()
                Text(appVersion)
                    .foregroundStyle(.secondary)
            }

            Link(destination: URL(string: "https://kreativekoala.llc/privacy")!) {
                SettingsRow(
                    icon: "hand.raised.fill",
                    iconColor: .gray,
                    title: "Privacy Policy",
                    showChevron: true
                )
            }
            .buttonStyle(.plain)

            Link(destination: URL(string: "https://kreativekoala.llc/terms")!) {
                SettingsRow(
                    icon: "doc.text.fill",
                    iconColor: .gray,
                    title: "Terms of Service",
                    showChevron: true
                )
            }
            .buttonStyle(.plain)
        } header: {
            Text("About")
        }
    }

    // MARK: - Helpers

    private var appVersion: String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version) (\(build))"
    }

    private func shareApp() {
        let url = URL(string: "https://apps.apple.com/app/listenai")!
        let activityVC = UIActivityViewController(activityItems: [url], applicationActivities: nil)

        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first,
           let rootVC = window.rootViewController {
            rootVC.present(activityVC, animated: true)
        }
    }

    private func rateApp() {
        if let url = URL(string: "https://apps.apple.com/app/listenai?action=write-review") {
            UIApplication.shared.open(url)
        }
    }

    private func contactSupport() {
        if let url = URL(string: "mailto:support@kreativekoala.llc") {
            UIApplication.shared.open(url)
        }
    }
}

// MARK: - Settings Row

struct SettingsRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    var value: String? = nil
    var showChevron: Bool = false

    var body: some View {
        HStack {
            SettingsIconView(icon: icon, color: iconColor)

            Text(title)
                .foregroundStyle(.primary)

            Spacer()

            if let value = value {
                Text(value)
                    .foregroundStyle(.secondary)
            }

            if showChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
        }
    }
}

// MARK: - Settings Icon View

struct SettingsIconView: View {
    let icon: String
    let color: Color

    var body: some View {
        Image(systemName: icon)
            .font(.body)
            .foregroundStyle(.white)
            .frame(width: 28, height: 28)
            .background(color)
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }
}

// MARK: - Language Picker View

struct LanguagePickerView: View {
    @Binding var selectedLanguage: String
    @Environment(\.dismiss) private var dismiss

    private let languages = [
        ("en-US", "English (US)"),
        ("en-GB", "English (UK)"),
        ("es-ES", "Spanish"),
        ("fr-FR", "French"),
        ("de-DE", "German"),
        ("it-IT", "Italian"),
        ("pt-BR", "Portuguese (Brazil)"),
        ("ja-JP", "Japanese"),
        ("ko-KR", "Korean"),
        ("zh-CN", "Chinese (Simplified)")
    ]

    var body: some View {
        NavigationStack {
            List {
                ForEach(languages, id: \.0) { code, name in
                    Button {
                        selectedLanguage = code
                        dismiss()
                    } label: {
                        HStack {
                            Text(name)
                                .foregroundStyle(.primary)
                            Spacer()
                            if selectedLanguage == code {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.blue)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                }
            }
            .navigationTitle("App Language")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        dismiss()
                    }
                }
            }
        }
    }
}

// MARK: - Feature Request View

struct FeatureRequestView: View {
    @State private var featureText = ""
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextEditor(text: $featureText)
                        .frame(minHeight: 150)
                } header: {
                    Text("Describe your feature idea")
                } footer: {
                    Text("We read every suggestion and use them to improve ReadAloud AI.")
                }

                Section {
                    Button {
                        submitFeature()
                    } label: {
                        HStack {
                            Spacer()
                            Text("Submit")
                                .font(.headline)
                            Spacer()
                        }
                    }
                    .disabled(featureText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
            .navigationTitle("Request Feature")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
        }
    }

    private func submitFeature() {
        // TODO: Submit feature request to backend
        dismiss()
    }
}

// MARK: - Linked Accounts View

struct LinkedAccountsView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var googleAuth = GoogleAuthService.shared
    @State private var isConnecting = false
    @State private var authError: String?

    var body: some View {
        List {
            Section {
                HStack {
                    // Google icon
                    Image(systemName: "g.circle.fill")
                        .font(.title)
                        .foregroundStyle(.red, .white)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Google")
                            .font(.headline)

                        if googleAuth.isAuthenticated {
                            if let email = googleAuth.userEmail {
                                Text(email)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            } else {
                                Text("Connected")
                                    .font(.caption)
                                    .foregroundStyle(.green)
                            }
                        } else {
                            Text("Not connected")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }

                    Spacer()

                    if isConnecting {
                        ProgressView()
                    } else {
                        Button(googleAuth.isAuthenticated ? "Disconnect" : "Connect") {
                            if googleAuth.isAuthenticated {
                                disconnectGoogle()
                            } else {
                                connectGoogle()
                            }
                        }
                        .buttonStyle(.bordered)
                        .tint(googleAuth.isAuthenticated ? .red : .blue)
                    }
                }
                .padding(.vertical, 4)
            } footer: {
                Text("Connect Google to import emails from Gmail and listen to them.")
            }
        }
        .navigationTitle("Linked Accounts")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button("Done") {
                    dismiss()
                }
            }
        }
        .alert("Error", isPresented: .constant(authError != nil)) {
            Button("OK") { authError = nil }
        } message: {
            Text(authError ?? "")
        }
    }

    private func connectGoogle() {
        isConnecting = true
        Task {
            do {
                try await googleAuth.signIn()
                isConnecting = false
            } catch let error as GoogleAuthError {
                isConnecting = false
                if case .userCancelled = error {
                    // Don't show error for user cancellation
                } else {
                    authError = error.localizedDescription
                }
            } catch {
                isConnecting = false
                authError = error.localizedDescription
            }
        }
    }

    private func disconnectGoogle() {
        googleAuth.signOut()
        GmailService.shared.clearCache()
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        SettingsView()
            .environmentObject(UsageTrackerService.shared)
    }
}
