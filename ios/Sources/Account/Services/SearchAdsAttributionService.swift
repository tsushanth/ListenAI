import Foundation
import AdServices
import UIKit

// MARK: - Search Ads Attribution Service

/// Service for collecting Apple Search Ads attribution data and sending it to the backend
/// for ASA bid optimization. This captures campaign, ad group, and keyword data that
/// helps optimize Apple Search Ads bidding strategies.
@MainActor
final class SearchAdsAttributionService: ObservableObject {

    // MARK: - Singleton

    static let shared = SearchAdsAttributionService()

    // MARK: - Published Properties

    /// Whether attribution has been collected for this install
    @Published private(set) var hasCollectedAttribution: Bool = false

    // MARK: - Private Properties

    private var backendURL: URL?

    /// UserDefaults key for tracking attribution collection
    private let attributionCollectedKey = "ListenAI.SearchAds.AttributionCollected"

    /// UserDefaults key for storing attribution data
    private let attributionDataKey = "ListenAI.SearchAds.AttributionData"

    // MARK: - Initialization

    private init() {
        hasCollectedAttribution = UserDefaults.standard.bool(forKey: attributionCollectedKey)
    }

    // MARK: - Configuration

    /// Configure the service with the backend URL.
    func configure(backendURL: URL) {
        self.backendURL = backendURL
        print("[SearchAdsAttribution] Configured with backend: \(backendURL)")
    }

    // MARK: - Attribution Collection

    /// Collect and send Apple Search Ads attribution data to the backend.
    /// This should be called once at app launch after configuration.
    /// Attribution is only collected once per install.
    func collectAttribution() async {
        // Only collect attribution once per install
        guard !hasCollectedAttribution else {
            print("[SearchAdsAttribution] Attribution already collected for this install")
            return
        }

        // AdServices attribution requires iOS 14.3+
        guard #available(iOS 14.3, *) else {
            print("[SearchAdsAttribution] AdServices requires iOS 14.3+")
            markAttributionCollected(data: nil)
            return
        }

        do {
            // Step 1: Get the attribution token from AdServices
            let token = try AAAttribution.attributionToken()
            print("[SearchAdsAttribution] Got attribution token")

            // Step 2: Fetch full attribution data from Apple's Attribution API
            let attributionData = try await fetchAttributionData(token: token)

            // Step 3: Send to backend for ad-optimizer
            try await sendAttributionToBackend(data: attributionData)

            // Mark as collected
            markAttributionCollected(data: attributionData)

            print("[SearchAdsAttribution] Attribution collection complete")

        } catch {
            print("[SearchAdsAttribution] Attribution not available: \(error.localizedDescription)")
            // This is normal for organic installs, simulator, or if attribution fails
            // Mark as collected to avoid retrying
            markAttributionCollected(data: nil)
        }
    }

    // MARK: - Private Methods

    /// Fetch attribution data from Apple's Attribution API using the token.
    private func fetchAttributionData(token: String) async throws -> [String: Any] {
        // Apple's Attribution API endpoint
        let url = URL(string: "https://api-adservices.apple.com/api/v1/")!

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("text/plain", forHTTPHeaderField: "Content-Type")
        request.httpBody = token.data(using: .utf8)
        request.timeoutInterval = 30

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AttributionError.invalidResponse
        }

        // Handle different response codes
        switch httpResponse.statusCode {
        case 200:
            // Success - parse attribution data
            guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
                throw AttributionError.invalidData
            }
            return json

        case 404:
            // No attribution data (organic install)
            print("[SearchAdsAttribution] Organic install (no attribution data)")
            return ["attribution": false, "source": "organic"]

        default:
            throw AttributionError.serverError(statusCode: httpResponse.statusCode)
        }
    }

    /// Send attribution data to the backend for ad-optimizer processing.
    private func sendAttributionToBackend(data: [String: Any]) async throws {
        guard let backendURL = backendURL else {
            print("[SearchAdsAttribution] Backend not configured, skipping send")
            return
        }

        let endpoint = backendURL.appendingPathComponent("/api/analytics/attribution")

        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(getDeviceId(), forHTTPHeaderField: "X-Device-ID")
        request.setValue("ios", forHTTPHeaderField: "X-Platform")
        request.setValue(Bundle.main.bundleIdentifier ?? "com.kreativekoala.listenai", forHTTPHeaderField: "X-App-ID")
        request.setValue(getAppVersion(), forHTTPHeaderField: "X-App-Version")
        request.timeoutInterval = 30

        // Build the payload
        var payload: [String: Any] = [
            "device_id": getDeviceId(),
            "platform": "ios",
            "app_version": getAppVersion(),
            "collected_at": ISO8601DateFormatter().string(from: Date()),
            "attribution_data": data
        ]

        // Add iOS-specific metadata
        payload["ios_version"] = UIDevice.current.systemVersion
        payload["device_model"] = getDeviceModel()

        request.httpBody = try JSONSerialization.data(withJSONObject: payload)

        let (responseData, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw AttributionError.invalidResponse
        }

        if httpResponse.statusCode >= 200 && httpResponse.statusCode < 300 {
            print("[SearchAdsAttribution] Attribution data sent to backend successfully")

            // Log response if available
            if let responseJson = try? JSONSerialization.jsonObject(with: responseData) as? [String: Any] {
                print("[SearchAdsAttribution] Backend response: \(responseJson)")
            }
        } else {
            print("[SearchAdsAttribution] Backend returned status \(httpResponse.statusCode)")
            // Don't throw - we still want to mark attribution as collected
            // The backend may not have the endpoint yet
        }
    }

    /// Mark attribution as collected and store the data.
    private func markAttributionCollected(data: [String: Any]?) {
        hasCollectedAttribution = true
        UserDefaults.standard.set(true, forKey: attributionCollectedKey)

        if let data = data,
           let jsonData = try? JSONSerialization.data(withJSONObject: data) {
            UserDefaults.standard.set(jsonData, forKey: attributionDataKey)
        }

        print("[SearchAdsAttribution] Marked attribution as collected")
    }

    // MARK: - Helper Methods

    /// Get stored attribution data (for debugging/analytics).
    func getStoredAttributionData() -> [String: Any]? {
        guard let jsonData = UserDefaults.standard.data(forKey: attributionDataKey),
              let data = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
            return nil
        }
        return data
    }

    /// Reset attribution collection state (for testing only).
    func resetAttributionForTesting() {
        hasCollectedAttribution = false
        UserDefaults.standard.removeObject(forKey: attributionCollectedKey)
        UserDefaults.standard.removeObject(forKey: attributionDataKey)
        print("[SearchAdsAttribution] Attribution state reset")
    }

    private func getDeviceId() -> String {
        let key = "ListenAI.DeviceID"
        if let storedId = UserDefaults.standard.string(forKey: key) {
            return storedId
        }

        let deviceId = UIDevice.current.identifierForVendor?.uuidString ?? UUID().uuidString
        UserDefaults.standard.set(deviceId, forKey: key)
        return deviceId
    }

    private func getAppVersion() -> String {
        let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0"
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "1"
        return "\(version)(\(build))"
    }

    private func getDeviceModel() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let modelCode = withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                String(cString: $0)
            }
        }
        return modelCode
    }
}

// MARK: - Attribution Error

enum AttributionError: LocalizedError {
    case tokenNotAvailable
    case invalidResponse
    case invalidData
    case serverError(statusCode: Int)
    case notConfigured

    var errorDescription: String? {
        switch self {
        case .tokenNotAvailable:
            return "Attribution token not available"
        case .invalidResponse:
            return "Invalid response from attribution API"
        case .invalidData:
            return "Invalid attribution data format"
        case .serverError(let statusCode):
            return "Server error: \(statusCode)"
        case .notConfigured:
            return "Service not configured"
        }
    }
}
