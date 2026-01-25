import Foundation
import Combine

// MARK: - Synthesis Metrics Service

/// Tracks TTS synthesis performance metrics including failures, timing, and success rates.
/// Used for monitoring and debugging synthesis issues.
@MainActor
final class SynthesisMetricsService: ObservableObject {

    // MARK: - Published State

    @Published private(set) var totalRequests: Int = 0
    @Published private(set) var successfulRequests: Int = 0
    @Published private(set) var failedRequests: Int = 0

    /// Average generation time in seconds (for successful requests)
    @Published private(set) var averageGenerationTime: TimeInterval = 0

    /// Average time to first audio (preview available) in seconds
    @Published private(set) var averageTimeToFirstAudio: TimeInterval = 0

    /// Recent errors for debugging
    @Published private(set) var recentErrors: [SynthesisErrorRecord] = []

    // MARK: - Properties

    private let storageKey = "ReadAloudAI.SynthesisMetrics"
    private let errorsKey = "ReadAloudAI.SynthesisErrors"
    private let maxRecentErrors = 50

    // Running totals for average calculation
    private var totalGenerationTime: TimeInterval = 0
    private var totalTimeToFirstAudio: TimeInterval = 0
    private var timeToFirstAudioCount: Int = 0

    // Error counts by type
    private var errorCounts: [SynthesisErrorType: Int] = [:]

    // Session metrics (reset on app launch)
    private var sessionStartTime: Date = Date()
    private var sessionRequests: Int = 0
    private var sessionFailures: Int = 0

    // MARK: - Singleton

    static let shared = SynthesisMetricsService()

    private init() {
        loadMetrics()
    }

    // MARK: - Public Methods

    /// Record the start of a synthesis request
    func recordRequestStart(
        articleId: UUID,
        voiceId: String,
        provider: String,
        textLength: Int
    ) -> SynthesisRequestTracker {
        totalRequests += 1
        sessionRequests += 1

        let tracker = SynthesisRequestTracker(
            id: UUID(),
            articleId: articleId,
            voiceId: voiceId,
            provider: provider,
            textLength: textLength,
            startTime: Date()
        )

        print("[Metrics] Request started: \(tracker.id) for article \(articleId)")
        return tracker
    }

    /// Record when preview audio becomes available (time to first audio)
    func recordFirstAudioAvailable(tracker: inout SynthesisRequestTracker) {
        guard tracker.firstAudioTime == nil else { return }

        tracker.firstAudioTime = Date()
        let ttfa = tracker.firstAudioTime!.timeIntervalSince(tracker.startTime)

        timeToFirstAudioCount += 1
        totalTimeToFirstAudio += ttfa
        averageTimeToFirstAudio = totalTimeToFirstAudio / Double(timeToFirstAudioCount)

        print("[Metrics] First audio available: \(String(format: "%.2f", ttfa))s (avg: \(String(format: "%.2f", averageTimeToFirstAudio))s)")
    }

    /// Record successful completion of synthesis
    func recordSuccess(tracker: SynthesisRequestTracker) {
        let generationTime = Date().timeIntervalSince(tracker.startTime)

        successfulRequests += 1
        totalGenerationTime += generationTime
        averageGenerationTime = totalGenerationTime / Double(successfulRequests)

        print("[Metrics] Success: \(String(format: "%.2f", generationTime))s (avg: \(String(format: "%.2f", averageGenerationTime))s, success rate: \(successRateFormatted))")

        saveMetrics()
    }

    /// Record a synthesis failure
    func recordFailure(
        tracker: SynthesisRequestTracker,
        errorType: SynthesisErrorType,
        errorMessage: String,
        retryCount: Int = 0
    ) {
        failedRequests += 1
        sessionFailures += 1

        // Increment error type count
        errorCounts[errorType, default: 0] += 1

        // Create error record
        let errorRecord = SynthesisErrorRecord(
            id: UUID(),
            timestamp: Date(),
            articleId: tracker.articleId,
            voiceId: tracker.voiceId,
            provider: tracker.provider,
            textLength: tracker.textLength,
            errorType: errorType,
            errorMessage: errorMessage,
            retryCount: retryCount,
            durationBeforeFailure: Date().timeIntervalSince(tracker.startTime)
        )

        // Add to recent errors (keep last N)
        recentErrors.insert(errorRecord, at: 0)
        if recentErrors.count > maxRecentErrors {
            recentErrors = Array(recentErrors.prefix(maxRecentErrors))
        }

        print("[Metrics] Failure: \(errorType.rawValue) - \(errorMessage) (failure rate: \(failureRateFormatted))")

        saveMetrics()
    }

    /// Record a failure without a tracker (for early failures before request starts)
    func recordEarlyFailure(
        errorType: SynthesisErrorType,
        errorMessage: String,
        voiceId: String? = nil,
        provider: String? = nil
    ) {
        failedRequests += 1
        totalRequests += 1
        sessionFailures += 1
        sessionRequests += 1

        errorCounts[errorType, default: 0] += 1

        let errorRecord = SynthesisErrorRecord(
            id: UUID(),
            timestamp: Date(),
            articleId: nil,
            voiceId: voiceId,
            provider: provider,
            textLength: nil,
            errorType: errorType,
            errorMessage: errorMessage,
            retryCount: 0,
            durationBeforeFailure: 0
        )

        recentErrors.insert(errorRecord, at: 0)
        if recentErrors.count > maxRecentErrors {
            recentErrors = Array(recentErrors.prefix(maxRecentErrors))
        }

        print("[Metrics] Early failure: \(errorType.rawValue) - \(errorMessage)")
        saveMetrics()
    }

    // MARK: - Computed Properties

    /// Success rate as a percentage (0-100)
    var successRate: Double {
        guard totalRequests > 0 else { return 100 }
        return Double(successfulRequests) / Double(totalRequests) * 100
    }

    /// Failure rate as a percentage (0-100)
    var failureRate: Double {
        guard totalRequests > 0 else { return 0 }
        return Double(failedRequests) / Double(totalRequests) * 100
    }

    var successRateFormatted: String {
        String(format: "%.1f%%", successRate)
    }

    var failureRateFormatted: String {
        String(format: "%.1f%%", failureRate)
    }

    /// Session success rate (since app launch)
    var sessionSuccessRate: Double {
        guard sessionRequests > 0 else { return 100 }
        return Double(sessionRequests - sessionFailures) / Double(sessionRequests) * 100
    }

    /// Get error count for a specific type
    func errorCount(for type: SynthesisErrorType) -> Int {
        errorCounts[type, default: 0]
    }

    /// Get all error counts
    var allErrorCounts: [SynthesisErrorType: Int] {
        errorCounts
    }

    /// Summary for display
    var metricsSummary: String {
        """
        Total: \(totalRequests) | Success: \(successfulRequests) | Failed: \(failedRequests)
        Success Rate: \(successRateFormatted)
        Avg Generation: \(String(format: "%.1f", averageGenerationTime))s
        Avg TTFA: \(String(format: "%.1f", averageTimeToFirstAudio))s
        """
    }

    // MARK: - Reset

    /// Reset all metrics (for debugging/testing)
    func resetAllMetrics() {
        totalRequests = 0
        successfulRequests = 0
        failedRequests = 0
        totalGenerationTime = 0
        averageGenerationTime = 0
        totalTimeToFirstAudio = 0
        averageTimeToFirstAudio = 0
        timeToFirstAudioCount = 0
        errorCounts = [:]
        recentErrors = []
        sessionRequests = 0
        sessionFailures = 0

        saveMetrics()
        print("[Metrics] All metrics reset")
    }

    // MARK: - Persistence

    private func saveMetrics() {
        let data = SynthesisMetricsData(
            totalRequests: totalRequests,
            successfulRequests: successfulRequests,
            failedRequests: failedRequests,
            totalGenerationTime: totalGenerationTime,
            totalTimeToFirstAudio: totalTimeToFirstAudio,
            timeToFirstAudioCount: timeToFirstAudioCount,
            errorCounts: errorCounts.reduce(into: [String: Int]()) { $0[$1.key.rawValue] = $1.value }
        )

        if let encoded = try? JSONEncoder().encode(data) {
            UserDefaults.standard.set(encoded, forKey: storageKey)
        }

        // Save errors separately
        if let errorsEncoded = try? JSONEncoder().encode(recentErrors) {
            UserDefaults.standard.set(errorsEncoded, forKey: errorsKey)
        }
    }

    private func loadMetrics() {
        // Load main metrics
        if let data = UserDefaults.standard.data(forKey: storageKey),
           let decoded = try? JSONDecoder().decode(SynthesisMetricsData.self, from: data) {
            totalRequests = decoded.totalRequests
            successfulRequests = decoded.successfulRequests
            failedRequests = decoded.failedRequests
            totalGenerationTime = decoded.totalGenerationTime
            totalTimeToFirstAudio = decoded.totalTimeToFirstAudio
            timeToFirstAudioCount = decoded.timeToFirstAudioCount
            errorCounts = decoded.errorCounts.reduce(into: [SynthesisErrorType: Int]()) {
                if let type = SynthesisErrorType(rawValue: $1.key) {
                    $0[type] = $1.value
                }
            }

            // Recalculate averages
            if successfulRequests > 0 {
                averageGenerationTime = totalGenerationTime / Double(successfulRequests)
            }
            if timeToFirstAudioCount > 0 {
                averageTimeToFirstAudio = totalTimeToFirstAudio / Double(timeToFirstAudioCount)
            }
        }

        // Load errors
        if let errorsData = UserDefaults.standard.data(forKey: errorsKey),
           let decoded = try? JSONDecoder().decode([SynthesisErrorRecord].self, from: errorsData) {
            recentErrors = decoded
        }

        print("[Metrics] Loaded: \(totalRequests) total, \(successRateFormatted) success rate")
    }
}

// MARK: - Supporting Types

/// Tracks a single synthesis request in progress
struct SynthesisRequestTracker {
    let id: UUID
    let articleId: UUID
    let voiceId: String
    let provider: String
    let textLength: Int
    let startTime: Date
    var firstAudioTime: Date?
}

/// Types of synthesis errors
enum SynthesisErrorType: String, Codable, CaseIterable {
    case network = "network"
    case timeout = "timeout"
    case quota = "quota"
    case unauthorized = "unauthorized"
    case rateLimited = "rate_limited"
    case voiceNotFound = "voice_not_found"
    case serverError = "server_error"
    case cudaError = "cuda_error"
    case modelLoadError = "model_load"
    case audioValidation = "audio_validation"
    case cancelled = "cancelled"
    case unknown = "unknown"

    var displayName: String {
        switch self {
        case .network: return "Network Error"
        case .timeout: return "Timeout"
        case .quota: return "Quota Exceeded"
        case .unauthorized: return "Unauthorized"
        case .rateLimited: return "Rate Limited"
        case .voiceNotFound: return "Voice Not Found"
        case .serverError: return "Server Error"
        case .cudaError: return "GPU Error"
        case .modelLoadError: return "Model Load Error"
        case .audioValidation: return "Audio Validation"
        case .cancelled: return "Cancelled"
        case .unknown: return "Unknown Error"
        }
    }
}

/// Record of a synthesis error
struct SynthesisErrorRecord: Codable, Identifiable {
    let id: UUID
    let timestamp: Date
    let articleId: UUID?
    let voiceId: String?
    let provider: String?
    let textLength: Int?
    let errorType: SynthesisErrorType
    let errorMessage: String
    let retryCount: Int
    let durationBeforeFailure: TimeInterval
}

/// Persisted metrics data
private struct SynthesisMetricsData: Codable {
    let totalRequests: Int
    let successfulRequests: Int
    let failedRequests: Int
    let totalGenerationTime: TimeInterval
    let totalTimeToFirstAudio: TimeInterval
    let timeToFirstAudioCount: Int
    let errorCounts: [String: Int]
}
