import SwiftUI
import UserNotifications

@main
struct ListenAIApp: App {

    init() {
        print("[App] ListenAIApp.init() starting")
        // Avoid any MainActor singleton access here
        print("[App] ListenAIApp.init() completed")
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

// MARK: - Root View

/// Root view that safely initializes MainActor singletons after SwiftUI is ready.
/// This prevents EXC_BAD_ACCESS crashes from accessing @MainActor singletons
/// during App.init() when the dispatch system isn't fully initialized.
struct RootView: View {
    // State to track initialization - starts false, set to true in task
    @State private var isReady = false

    var body: some View {
        Group {
            if isReady {
                MainContentView()
            } else {
                // Launch screen while initializing
                LaunchScreenView()
            }
        }
        .task {
            // This runs after the view is on screen and main run loop is running
            print("[App] RootView.task starting - safe to access MainActor singletons")

            // Configure backend services
            await configureServices()

            // Now safe to access MainActor singletons
            await MainActor.run {
                isReady = true
                print("[App] RootView ready, onboarding completed: \(OnboardingManager.shared.hasCompletedOnboarding)")
            }
        }
    }

    @MainActor
    private func configureServices() async {
        print("[App] Configuring services...")

        // Configure ListenAI Cloud Service with deployed backend
        let backendURL = URL(string: "https://listenai-backend-917362189743.us-central1.run.app")!

        // Auth token provider (replace with actual Supabase auth in production)
        let authTokenProvider: @Sendable () async throws -> String = {
            // TODO: Replace with actual Supabase auth token provider
            // In production: return try await supabase.auth.session?.accessToken ?? ""
            return ""
        }

        // Configure TTS service
        TTSServiceFactory.configureListenAICloud(
            baseURL: backendURL,
            authTokenProvider: authTokenProvider
        )

        // Configure WebImportService for server-side extraction
        await WebImportService.shared.configure(
            backendURL: backendURL,
            authTokenProvider: authTokenProvider
        )

        // Configure VoiceCloningService for voice cloning
        // Uses device ID for user identification (no auth required)
        await VoiceCloningService.shared.configure(baseURL: backendURL)

        // Configure VoiceMarketplaceService for sharing and discovering voices
        // Uses device ID for user identification (no auth required)
        await VoiceMarketplaceService.shared.configure(baseURL: backendURL)

        // Configure AuthService for Apple/Google Sign In
        AuthService.shared.configure(backendURL: backendURL)

        // Configure StreamingTTSService for progressive audio playback
        StreamingTTSService.shared.configure(
            backendURL: backendURL,
            authTokenProvider: authTokenProvider
        )

        // Configure BackgroundStreamingSynthesisService for pre-caching long articles
        BackgroundStreamingSynthesisService.shared.configure(
            backendURL: backendURL,
            authTokenProvider: authTokenProvider
        )

        // Initialize NotificationManager and request permission proactively
        // This ensures notifications work when user later clicks "Notify me when ready"
        let notificationManager = NotificationManager.shared
        let notificationAuthorized = await notificationManager.requestAuthorization()
        print("[App] Notification permission: \(notificationAuthorized ? "granted" : "denied")")

        print("[App] Services configured")
    }
}

// MARK: - Launch Screen View

/// Simple launch screen shown while app initializes
struct LaunchScreenView: View {
    var body: some View {
        ZStack {
            Color(.systemBackground)
                .ignoresSafeArea()

            VStack(spacing: 16) {
                Image(systemName: "waveform.circle.fill")
                    .font(.system(size: 60))
                    .foregroundStyle(.blue)

                Text("ReadAloud AI")
                    .font(.title.bold())
            }
        }
    }
}

// MARK: - Main Content View

/// Container that holds the main app content with environment objects
struct MainContentView: View {
    @ObservedObject private var onboarding = OnboardingManager.shared

    var body: some View {
        // Access singletons directly in body - this is safe because body
        // is only evaluated after the view hierarchy is set up
        let playback = AudioPlaybackService.shared
        let queue = QueueManager.shared
        let usage = UsageTrackerService.shared

        Group {
            if onboarding.hasCompletedOnboarding {
                ContentView()
                    .environmentObject(playback)
                    .environmentObject(queue)
                    .environmentObject(usage)
            } else {
                OnboardingView()
                    .environmentObject(playback)
                    .environmentObject(queue)
                    .environmentObject(usage)
            }
        }
    }
}
