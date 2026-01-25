import Foundation
import UIKit

// MARK: - Voice Marketplace Service

/// Service for interacting with the voice marketplace API.
/// Allows users to share voices, browse community voices, rate, and report.
actor VoiceMarketplaceService {

    // MARK: - Types

    /// Shared voice from the marketplace
    struct SharedVoice: Codable, Identifiable, Sendable {
        let id: String
        let displayName: String
        let description: String?
        let tags: [String]
        let previewAudioUrl: String?
        let previewDurationSec: Double?
        let usageCount: Int
        let avgRating: Double
        let ratingCount: Int
        let ownerUserId: String
        let createdAt: Date
        let isOwn: Bool

        enum CodingKeys: String, CodingKey {
            case id
            case displayName = "display_name"
            case description
            case tags
            case previewAudioUrl = "preview_audio_url"
            case previewDurationSec = "preview_duration_sec"
            case usageCount = "usage_count"
            case avgRating = "avg_rating"
            case ratingCount = "rating_count"
            case ownerUserId = "owner_user_id"
            case createdAt = "created_at"
            case isOwn = "is_own"
        }
    }

    /// User's own shared voice with status info
    struct MySharedVoice: Codable, Identifiable, Sendable {
        let id: String
        let displayName: String
        let description: String?
        let tags: [String]
        let status: String
        let usageCount: Int
        let avgRating: Double
        let ratingCount: Int
        let createdAt: Date
        let revokedAt: Date?
        let revokedReason: String?

        enum CodingKeys: String, CodingKey {
            case id
            case displayName = "display_name"
            case description
            case tags
            case status
            case usageCount = "usage_count"
            case avgRating = "avg_rating"
            case ratingCount = "rating_count"
            case createdAt = "created_at"
            case revokedAt = "revoked_at"
            case revokedReason = "revoked_reason"
        }
    }

    /// Rewards summary
    struct RewardsSummary: Codable, Sendable {
        let pending: PendingRewards
        let credited: CreditedRewards

        struct PendingRewards: Codable, Sendable {
            let minutes: Double
            let count: Int
        }

        struct CreditedRewards: Codable, Sendable {
            let totalMinutes: Double

            enum CodingKeys: String, CodingKey {
                case totalMinutes = "total_minutes"
            }
        }
    }

    /// Reward history entry
    struct RewardHistoryEntry: Codable, Identifiable, Sendable {
        let id: String
        let sharedVoiceId: String
        let voiceName: String
        let charactersGenerated: Int
        let secondsGenerated: Double
        let rewardMinutes: Double
        let credited: Bool
        let creditedAt: Date?
        let createdAt: Date

        enum CodingKeys: String, CodingKey {
            case id
            case sharedVoiceId = "shared_voice_id"
            case voiceName = "voice_name"
            case charactersGenerated = "characters_generated"
            case secondsGenerated = "seconds_generated"
            case rewardMinutes = "reward_minutes"
            case credited
            case creditedAt = "credited_at"
            case createdAt = "created_at"
        }
    }

    /// Sort options for marketplace
    enum SortOption: String, CaseIterable, Sendable {
        case popular = "popular"
        case newest = "newest"
        case rating = "rating"

        var displayName: String {
            switch self {
            case .popular: return "Most Popular"
            case .newest: return "Newest"
            case .rating: return "Top Rated"
            }
        }
    }

    /// Report reason
    enum ReportReason: String, CaseIterable, Sendable {
        case notTheirVoice = "not_their_voice"
        case celebrity = "celebrity"
        case publicFigure = "public_figure"
        case offensive = "offensive"
        case copyright = "copyright"
        case other = "other"

        var displayName: String {
            switch self {
            case .notTheirVoice: return "Not Their Voice"
            case .celebrity: return "Celebrity Impersonation"
            case .publicFigure: return "Public Figure"
            case .offensive: return "Offensive Content"
            case .copyright: return "Copyright Violation"
            case .other: return "Other"
            }
        }
    }

    /// Errors
    enum MarketplaceError: LocalizedError, Sendable {
        case notConfigured
        case networkError(String)
        case unauthorized
        case notFound
        case alreadyShared
        case validationError(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured:
                return "Marketplace service is not configured"
            case .networkError(let message):
                return "Network error: \(message)"
            case .unauthorized:
                return "Please sign in to access the marketplace"
            case .notFound:
                return "Voice not found"
            case .alreadyShared:
                return "This voice is already shared"
            case .validationError(let message):
                return message
            }
        }
    }

    // MARK: - Singleton

    static let shared = VoiceMarketplaceService()

    // MARK: - Properties

    private var baseURL: URL?

    // MARK: - Configuration

    func configure(baseURL: URL) {
        self.baseURL = baseURL
    }

    var isConfigured: Bool {
        baseURL != nil
    }

    // MARK: - Browse Marketplace

    /// Browse shared voices in the marketplace
    func browse(
        tags: [String]? = nil,
        search: String? = nil,
        sort: SortOption = .popular,
        limit: Int = 20,
        offset: Int = 0
    ) async throws -> [SharedVoice] {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        var queryItems: [URLQueryItem] = [
            URLQueryItem(name: "sort", value: sort.rawValue),
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]

        if let tags = tags, !tags.isEmpty {
            queryItems.append(URLQueryItem(name: "tags", value: tags.joined(separator: ",")))
        }

        if let search = search, !search.isEmpty {
            queryItems.append(URLQueryItem(name: "search", value: search))
        }

        let request = try await createRequest(endpoint: "/api/marketplace", method: "GET", queryItems: queryItems)
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = Self.dateDecodingStrategy

        struct BrowseResponse: Decodable {
            let voices: [SharedVoice]
        }

        let browseResponse = try decoder.decode(BrowseResponse.self, from: data)
        return browseResponse.voices
    }

    /// Get details for a single shared voice
    func getVoice(id: String) async throws -> SharedVoice {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        let request = try await createRequest(endpoint: "/api/marketplace/\(id)", method: "GET")
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        if httpResponse.statusCode == 404 {
            throw MarketplaceError.notFound
        }

        guard httpResponse.statusCode == 200 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = Self.dateDecodingStrategy
        return try decoder.decode(SharedVoice.self, from: data)
    }

    // MARK: - Share Voice

    /// Share a cloned voice to the marketplace
    func shareVoice(
        clonedVoiceId: String,
        displayName: String,
        description: String?,
        tags: [String],
        attestation: String
    ) async throws -> String {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        var request = try await createRequest(endpoint: "/api/marketplace/share", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = [
            "cloned_voice_id": clonedVoiceId,
            "display_name": displayName,
            "tags": tags,
            "owner_attestation": attestation,
            "terms_accepted": true
        ]

        if let description = description, !description.isEmpty {
            body["description"] = description
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        if httpResponse.statusCode == 400 {
            if let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                if errorResponse.error.contains("already shared") {
                    throw MarketplaceError.alreadyShared
                }
                throw MarketplaceError.validationError(errorResponse.error)
            }
        }

        guard httpResponse.statusCode == 201 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }

        struct ShareResponse: Decodable {
            let id: String
        }

        let shareResponse = try JSONDecoder().decode(ShareResponse.self, from: data)
        return shareResponse.id
    }

    /// Revoke (unshare) a voice from the marketplace
    func revokeVoice(id: String) async throws {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        let request = try await createRequest(endpoint: "/api/marketplace/\(id)", method: "DELETE")
        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        if httpResponse.statusCode == 404 {
            throw MarketplaceError.notFound
        }

        guard httpResponse.statusCode == 204 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }
    }

    // MARK: - Rate Voice

    /// Rate a shared voice
    func rateVoice(id: String, rating: Int, review: String?) async throws {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        var request = try await createRequest(endpoint: "/api/marketplace/\(id)/rate", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        var body: [String: Any] = ["rating": rating]
        if let review = review, !review.isEmpty {
            body["review"] = review
        }

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (_, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }
    }

    // MARK: - Report Voice

    /// Report a shared voice
    func reportVoice(id: String, reason: ReportReason, description: String) async throws {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        var request = try await createRequest(endpoint: "/api/marketplace/\(id)/report", method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")

        let body: [String: Any] = [
            "reason": reason.rawValue,
            "description": description
        ]

        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        if httpResponse.statusCode == 400 {
            if let errorResponse = try? JSONDecoder().decode(ErrorResponse.self, from: data) {
                throw MarketplaceError.validationError(errorResponse.error)
            }
        }

        guard httpResponse.statusCode == 201 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }
    }

    // MARK: - My Shares

    /// Get user's shared voices
    func getMyShares() async throws -> [MySharedVoice] {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        let request = try await createRequest(endpoint: "/api/marketplace/my/shares", method: "GET")
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = Self.dateDecodingStrategy

        struct SharesResponse: Decodable {
            let shares: [MySharedVoice]
        }

        let sharesResponse = try decoder.decode(SharesResponse.self, from: data)
        return sharesResponse.shares
    }

    // MARK: - Rewards

    /// Get rewards summary
    func getRewardsSummary() async throws -> RewardsSummary {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        let request = try await createRequest(endpoint: "/api/marketplace/my/rewards", method: "GET")
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }

        return try JSONDecoder().decode(RewardsSummary.self, from: data)
    }

    /// Credit pending rewards
    func creditRewards() async throws -> Double {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        let request = try await createRequest(endpoint: "/api/marketplace/my/rewards/credit", method: "POST")
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }

        struct CreditResponse: Decodable {
            let creditedMinutes: Double

            enum CodingKeys: String, CodingKey {
                case creditedMinutes = "credited_minutes"
            }
        }

        let creditResponse = try JSONDecoder().decode(CreditResponse.self, from: data)
        return creditResponse.creditedMinutes
    }

    /// Get reward history
    func getRewardHistory(limit: Int = 50, offset: Int = 0) async throws -> [RewardHistoryEntry] {
        guard isConfigured else {
            throw MarketplaceError.notConfigured
        }

        let queryItems = [
            URLQueryItem(name: "limit", value: String(limit)),
            URLQueryItem(name: "offset", value: String(offset))
        ]

        let request = try await createRequest(endpoint: "/api/marketplace/my/rewards/history", method: "GET", queryItems: queryItems)
        let (data, response) = try await URLSession.shared.data(for: request)

        guard let httpResponse = response as? HTTPURLResponse else {
            throw MarketplaceError.networkError("Invalid response")
        }

        guard httpResponse.statusCode == 200 else {
            throw MarketplaceError.networkError("Status \(httpResponse.statusCode)")
        }

        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = Self.dateDecodingStrategy

        struct HistoryResponse: Decodable {
            let history: [RewardHistoryEntry]
        }

        let historyResponse = try decoder.decode(HistoryResponse.self, from: data)
        return historyResponse.history
    }

    // MARK: - Private Helpers

    private func getDeviceId() -> String {
        if let cachedId = UserDefaults.standard.string(forKey: "com.listenai.deviceId"), !cachedId.isEmpty {
            return cachedId
        }

        let deviceId: String
        if let vendorId = UIDevice.current.identifierForVendor?.uuidString {
            deviceId = vendorId
        } else {
            deviceId = UUID().uuidString
        }

        UserDefaults.standard.set(deviceId, forKey: "com.listenai.deviceId")
        return deviceId
    }

    private func createRequest(endpoint: String, method: String, queryItems: [URLQueryItem]? = nil) async throws -> URLRequest {
        guard let baseURL = baseURL else {
            throw MarketplaceError.notConfigured
        }

        var urlString = baseURL.absoluteString
        if urlString.hasSuffix("/") {
            urlString.removeLast()
        }
        if !endpoint.hasPrefix("/") {
            urlString += "/"
        }
        urlString += endpoint

        guard var components = URLComponents(string: urlString) else {
            throw MarketplaceError.networkError("Invalid URL: \(urlString)")
        }

        if let queryItems = queryItems {
            components.queryItems = queryItems
        }

        guard let url = components.url else {
            throw MarketplaceError.networkError("Invalid URL")
        }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 30
        request.setValue(getDeviceId(), forHTTPHeaderField: "X-Device-ID")

        return request
    }

    private struct ErrorResponse: Decodable {
        let error: String
    }

    // MARK: - Date Decoding

    private static var dateDecodingStrategy: JSONDecoder.DateDecodingStrategy {
        .custom { decoder in
            let container = try decoder.singleValueContainer()
            let dateString = try container.decode(String.self)

            let formatters = [
                ISO8601DateFormatter.withFractionalSeconds,
                ISO8601DateFormatter.withoutFractionalSeconds
            ]

            for formatter in formatters {
                if let date = formatter.date(from: dateString) {
                    return date
                }
            }

            throw DecodingError.dataCorruptedError(
                in: container,
                debugDescription: "Cannot decode date: \(dateString)"
            )
        }
    }
}

// MARK: - ISO8601 Formatters

private extension ISO8601DateFormatter {
    static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let withoutFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}
