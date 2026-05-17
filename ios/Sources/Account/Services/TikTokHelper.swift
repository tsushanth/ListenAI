import Foundation
import TikTokBusinessSDK
import AppTrackingTransparency

/// TikTok Business SDK integration for install attribution and event tracking.
final class TikTokHelper {
    static let shared = TikTokHelper()

    private let appId = "7610334570906435592"

    private init() {}

    /// Call once at app launch.
    func initialize() {
        guard let config = TikTokConfig(appId: appId, tiktokAppId: appId) else {
            print("[TikTok] Failed to create config")
            return
        }
        config.setLogLevel(TikTokLogLevelInfo)
        TikTokBusiness.initializeSdk(config)
        print("[TikTok] SDK initialized with appId: \(appId)")
    }

    /// Request App Tracking Transparency permission for IDFA access.
    func requestTrackingPermission() {
        if #available(iOS 14, *) {
            ATTrackingManager.requestTrackingAuthorization { status in
                switch status {
                case .authorized:
                    print("[TikTok] ATT authorized — IDFA available")
                case .denied:
                    print("[TikTok] ATT denied — limited attribution")
                case .notDetermined:
                    print("[TikTok] ATT not determined")
                case .restricted:
                    print("[TikTok] ATT restricted")
                @unknown default:
                    break
                }
                // Forward ATT result to Facebook SDK
                Task { @MainActor in
                    FacebookSDKManager.shared.updateTrackingAuthorization(enabled: status == .authorized)
                }
            }
        }
    }

    /// Track a custom event.
    func trackEvent(_ name: String, properties: [String: Any] = [:]) {
        let event = TikTokBaseEvent(eventName: name)
        for (key, value) in properties {
            event.addProperty(withKey: key, value: value)
        }
        TikTokBusiness.trackTTEvent(event)
    }

    func logSubscription(price: Double, currency: String, productId: String) {
        trackEvent("Subscribe", properties: [
            "content_id": productId,
            "currency": currency,
            "value": price
        ])
    }

    func logTrialStarted(productId: String) {
        trackEvent("StartTrial", properties: [
            "content_id": productId
        ])
    }
}
