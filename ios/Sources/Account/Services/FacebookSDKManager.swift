import Foundation
import FacebookCore

// MARK: - Facebook SDK Manager

/// Manages Facebook SDK for Meta Ads attribution and Conversions API (CAPI)
@MainActor
final class FacebookSDKManager: ObservableObject {

    // MARK: - Singleton

    static let shared = FacebookSDKManager()

    // MARK: - Properties

    /// Whether the SDK has been configured
    @Published private(set) var isConfigured: Bool = false

    // MARK: - Initialization

    private init() {}

    // MARK: - Configuration

    /// Configure Facebook SDK - call this at app launch
    /// The SDK reads FacebookAppID and FacebookClientToken from Info.plist
    func configure() {
        // Initialize Facebook SDK
        // The SDK automatically reads configuration from Info.plist:
        // - FacebookAppID
        // - FacebookClientToken
        // - FacebookDisplayName
        ApplicationDelegate.shared.initializeSDK()

        // Enable automatic event logging for attribution
        Settings.shared.isAutoLogAppEventsEnabled = true

        // Enable advertiser ID collection for better attribution
        Settings.shared.isAdvertiserIDCollectionEnabled = true

        isConfigured = true
        print("[FacebookSDK] Configured successfully")
    }

    // MARK: - App Lifecycle

    /// Handle app launch for Facebook SDK deferred deep linking
    func application(
        _ application: Any,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
    ) -> Bool {
        ApplicationDelegate.shared.initializeSDK()
        return true
    }

    /// Handle URL open for Facebook SDK
    func application(
        _ app: Any,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        return ApplicationDelegate.shared.application(
            UIApplication.shared,
            open: url,
            options: options
        )
    }

    // MARK: - Event Logging

    // MARK: - Tracking Authorization

    /// Update advertiser tracking based on ATT authorization result
    func updateTrackingAuthorization(enabled: Bool) {
        Settings.shared.isAdvertiserTrackingEnabled = enabled
        print("[FacebookSDK] Advertiser tracking set to: \(enabled)")
    }

    // MARK: - Event Logging

    /// Log a custom event for attribution
    func logEvent(_ eventName: AppEvents.Name, parameters: [AppEvents.ParameterName: Any]? = nil) {
        if let parameters = parameters {
            AppEvents.shared.logEvent(eventName, parameters: parameters)
        } else {
            AppEvents.shared.logEvent(eventName)
        }
        print("[FacebookSDK] Logged event: \(eventName.rawValue)")
    }

    /// Log purchase event for CAPI
    func logPurchase(amount: Double, currency: String, parameters: [AppEvents.ParameterName: Any]? = nil) {
        AppEvents.shared.logPurchase(amount: amount, currency: currency, parameters: parameters)
        print("[FacebookSDK] Logged purchase: \(amount) \(currency)")
    }

    /// Log subscription event
    func logSubscription(price: Double, currency: String, productId: String) {
        let params: [AppEvents.ParameterName: Any] = [
            .contentID: productId,
            .currency: currency,
            .numItems: 1
        ]
        AppEvents.shared.logPurchase(amount: price, currency: currency, parameters: params)
        logEvent(.subscribe, parameters: params)
        print("[FacebookSDK] Logged subscription: \(productId) - \(price) \(currency)")
    }

    /// Log trial started event
    func logTrialStarted(productId: String) {
        let params: [AppEvents.ParameterName: Any] = [
            .contentID: productId
        ]
        logEvent(.startTrial, parameters: params)
    }

    /// Log content view for retargeting
    func logContentView(contentType: String, contentId: String) {
        let params: [AppEvents.ParameterName: Any] = [
            .contentType: contentType,
            .contentID: contentId
        ]
        logEvent(.viewedContent, parameters: params)
    }

    /// Log completed registration
    func logCompletedRegistration(method: String) {
        let params: [AppEvents.ParameterName: Any] = [
            .registrationMethod: method
        ]
        logEvent(.completedRegistration, parameters: params)
    }
}
