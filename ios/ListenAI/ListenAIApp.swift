import SwiftUI
import UserNotifications
import FirebaseCore
import PaywallKit
import RatingKit
import FacebookCore

// MARK: - App Delegate for Facebook SDK deep link handling

class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        ApplicationDelegate.shared.initializeSDK()
        // Required for Meta to register the install/launch and emit a SKAdNetwork
        // conversion postback. Without this call, Meta sees zero attributed installs
        // regardless of how many users tapped on FB ads.
        // Per Meta docs: must be invoked on every app launch AND when the app
        // returns to foreground (handled in `applicationDidBecomeActive`).
        AppEvents.shared.activateApp()
        return true
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Re-arm session attribution on every foreground transition.
        AppEvents.shared.activateApp()
    }

    func application(_ app: UIApplication, open url: URL,
                     options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        ApplicationDelegate.shared.application(app, open: url, options: options)
    }
}

@main
struct ListenAIApp: App {

    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate

    init() {
        print("[App] ListenAIApp.init() starting")
        // Configure Firebase for analytics
        FirebaseApp.configure()
        print("[App] Firebase configured")

        // Configure StoreKit 2 and referral system via PaywallKit
        PaywallKitSDK.shared.configure(
            appId: "ReadAloud AI",
            appName: "ReadAloud AI",
            productIds: ProductID.allIDs
        )
        // Disable post-dismiss offer prompts to comply with Apple guideline 5.6
        StoreManager.shared.offerAfterDismissEnabled = false
        print("[App] PaywallKit configured")

        // Avoid any MainActor singleton access here
        print("[App] ListenAIApp.init() completed")
    
        // Server-driven rating prompts (variant testing + analytics).
        // Currently in simple mode — uses native SKStoreReviewController, no UI overlay.
        RatingKit.configure(appId: "readaloudai", apiUrl: "https://paywallkit-api.fly.dev")
        RatingKit.shared.trackAppOpen()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .ratingPrompt()
                .onOpenURL { url in
                    // Forward to Facebook SDK for deferred deep link / attribution
                    ApplicationDelegate.shared.application(
                        UIApplication.shared,
                        open: url,
                        options: [:]
                    )
                    PromoCodeManager.shared.handleURL(url)
                }
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

        // Check clipboard for promo code once per install
        await PromoCodeManager.shared.checkClipboard()

        // Configure ListenAI Cloud Service with deployed backend
        let backendURL = URL(string: "https://listenai-backend.fly.dev")!

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

        // Fetch server-controlled paywall mode (soft vs aggressive)
        await PaywallConfigService.shared.refresh()

        // Validate subscription state via StoreKit 2 / PaywallKit
        await PremiumManager.shared.validateSubscriptionState()

        // Configure and collect Apple Search Ads attribution for ad-optimizer
        SearchAdsAttributionService.shared.configure(backendURL: backendURL)
        await SearchAdsAttributionService.shared.collectAttribution()

        // Configure Facebook SDK for Meta Ads attribution and CAPI
        FacebookSDKManager.shared.configure()

        // Initialize TikTok Events SDK for install attribution
        TikTokHelper.shared.initialize()
        TikTokHelper.shared.requestTrackingPermission()

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

        // Kick off the on-device Kokoro download if the user has Offline AI on
        // and the network policy allows. Idempotent — no-ops if already loaded
        // or already in flight. Defers to WiFi when cellular is disallowed.
        OfflineAIDownloadCoordinator.shared.prepareIfPossible()

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
    @StateObject private var paywallCoordinator = PaywallCoordinator.shared
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        // Access singletons directly in body - this is safe because body
        // is only evaluated after the view hierarchy is set up
        let playback = AudioPlaybackService.shared
        let queue = QueueManager.shared
        let usage = UsageTrackerService.shared

        Group {
            if onboarding.hasCompletedOnboarding || ProcessInfo.processInfo.arguments.contains("FASTLANE_SNAPSHOT") {
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
        .paywallKitReferral()
        .sheet(isPresented: $paywallCoordinator.showWinbackOffer) {
            WinbackOfferView()
        }
        .onChange(of: scenePhase) { _, newPhase in
            if newPhase == .active && !ProcessInfo.processInfo.arguments.contains("FASTLANE_SNAPSHOT") {
                Task { await PaywallConfigService.shared.refresh() }
                paywallCoordinator.checkWinbackEligibility()
            }
        }
    }
}
