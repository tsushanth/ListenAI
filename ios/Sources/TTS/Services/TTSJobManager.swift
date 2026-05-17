import Foundation

// MARK: - TTS Job Manager

/// Manages TTS jobs in the background, continuing to poll and download audio
/// even when the user leaves the article view.
///
/// Polling Strategy for Fast TTFS (Time-To-First-Sound):
/// 1. Immediate first poll after job starts (no initial delay)
/// 2. Fast polling (0.7-1.0s) while queued/processing - for responsiveness
/// 3. Slow polling (1.5-2.0s) once partial_ready and playing - less aggressive
/// 4. Jitter of ±150ms to avoid thundering herd
/// 5. Max polling duration of 10 minutes per job
///
/// Playback Strategy:
/// - When partial_ready with preview URL: start AVPlayer immediately from remote URL
/// - Background download continues while streaming (optional caching)
/// - When ready with full URL: swap audio preserving playback position
@MainActor
final class TTSJobManager: ObservableObject {

    // MARK: - Singleton

    static let shared = TTSJobManager()

    // MARK: - Published State

    /// Active jobs being tracked (articleId -> job info)
    @Published private(set) var activeJobs: [UUID: JobInfo] = [:]

    struct JobInfo: Sendable {
        let articleId: UUID
        let jobId: String
        let voiceId: String
        var status: TTSJobStatus
        var previewURL: URL?          // Remote preview URL from backend
        var audioURL: URL?            // Remote full audio URL from backend
        var progress: Double
        var error: String?
        var localAudioPath: URL?      // Downloaded full audio (optional cache)
        var localPreviewPath: URL?    // Downloaded preview (optional cache)
        var previewDurationSec: Double?  // Preview duration from backend

        /// Latest full job-status response from the backend (chunks, queue, etc.).
        /// Stored verbatim so the rich progress UI (`CloudTTSProgressView`) can
        /// access chunk + queue context without re-polling.
        var latestStatus: TTSJobStatusResponse?

        // Timing metrics
        let jobStartTime: Date
        var firstAudioAvailableTime: Date?

        /// Whether any playable audio is available (remote URL or local)
        var hasPlayableAudio: Bool {
            previewURL != nil || audioURL != nil || localAudioPath != nil || localPreviewPath != nil
        }

        /// Best available playback URL (full preferred, then preview)
        var playableURL: URL? {
            // Prefer local cache if available
            if let local = localAudioPath { return local }
            if let local = localPreviewPath { return local }
            // Fall back to remote URLs
            if let remote = audioURL { return remote }
            if let remote = previewURL { return remote }
            return nil
        }

        /// Remote preview URL for immediate streaming (before download completes)
        var remotePreviewURL: URL? { previewURL }

        /// Remote full audio URL for streaming
        var remoteFullURL: URL? { audioURL }
    }

    // MARK: - Polling Configuration

    /// Fast polling interval while waiting for audio (queued/processing) - milliseconds
    private let fastPollingIntervalMs: UInt64 = 850  // 0.7-1.0s range with jitter

    /// Slow polling interval once partial_ready and playing - milliseconds
    private let slowPollingIntervalMs: UInt64 = 1750  // 1.5-2.0s range with jitter

    /// Jitter range (milliseconds) - ±150ms
    private let jitterRangeMs: UInt64 = 150

    /// Maximum polling duration before marking job as failed (seconds)
    private let maxPollingDurationSeconds: TimeInterval = 600  // 10 minutes

    // MARK: - Callbacks

    /// Called when partial_ready is detected with a playable remote preview URL.
    /// The view should start playback immediately from this URL.
    var onPreviewReady: ((UUID, URL, Double?) -> Void)?

    /// Called when full audio is ready with the full URL.
    /// The view should swap to full audio preserving playback position.
    var onFullAudioReady: ((UUID, URL) -> Void)?

    /// Called when job fails
    var onJobFailed: ((UUID, String) -> Void)?

    /// Called when job is not found (expired/cleaned up on server).
    /// The view should check backend cache and potentially restart generation.
    var onJobExpired: ((UUID, String) -> Void)?

    // MARK: - Private Properties

    private var pollingTasks: [UUID: Task<Void, Never>] = [:]
    private var downloadTasks: [UUID: Task<Void, Never>] = [:]  // Background download tasks
    private var cloudService: ListenAICloudService?

    /// Single-start guard: tracks which jobs have already triggered playback callbacks
    /// Prevents duplicate play calls during rapid polling
    private var didStartPlayback: Set<UUID> = []

    /// Tracks which jobs have already triggered full audio swap
    private var didSwapToFull: Set<UUID> = []

    // Local cache directory for downloaded audio
    private let cacheDirectory: URL

    // MARK: - Initialization

    private init() {
        let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
        self.cacheDirectory = cachesDir.appendingPathComponent("TTSJobAudioCache", isDirectory: true)

        // Create cache directory
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
    }

    // MARK: - Configuration

    func configure(cloudService: ListenAICloudService) {
        self.cloudService = cloudService
    }

    // MARK: - Public API

    /// Start tracking a job. Will poll in background even if user leaves article.
    func trackJob(articleId: UUID, jobId: String, voiceId: String, initialStatus: TTSJobStatus) {
        // Don't track if already complete
        if initialStatus == .ready {
            return
        }

        let startTime = Date()

        // Create job info with timing
        let jobInfo = JobInfo(
            articleId: articleId,
            jobId: jobId,
            voiceId: voiceId,
            status: initialStatus,
            previewURL: nil,
            audioURL: nil,
            progress: 0,
            error: nil,
            localAudioPath: nil,
            localPreviewPath: nil,
            jobStartTime: startTime,
            firstAudioAvailableTime: nil
        )

        activeJobs[articleId] = jobInfo

        // Start background polling
        startPolling(for: articleId, jobId: jobId)

        print("[TTSJobManager] Started tracking job \(jobId) for article \(articleId)")
    }

    /// Stop tracking a job (e.g., user cancelled)
    func stopTracking(articleId: UUID) {
        pollingTasks[articleId]?.cancel()
        pollingTasks.removeValue(forKey: articleId)
        downloadTasks[articleId]?.cancel()
        downloadTasks.removeValue(forKey: articleId)
        activeJobs.removeValue(forKey: articleId)

        // Clear single-start guards
        didStartPlayback.remove(articleId)
        didSwapToFull.remove(articleId)

        print("[TTSJobManager] Stopped tracking article \(articleId)")
    }

    /// Cancel a job on the server and stop tracking it locally.
    /// Use this when an article is deleted to free up server resources.
    ///
    /// - Parameter articleId: The article ID whose job should be cancelled
    /// - Parameter jobId: Optional job ID if known (otherwise looks up from activeJobs)
    func cancelAndCleanup(articleId: UUID, jobId: String? = nil) {
        // Get the job ID from active jobs if not provided
        let targetJobId = jobId ?? activeJobs[articleId]?.jobId

        // Stop local tracking first
        stopTracking(articleId: articleId)

        // Cancel on server in background (fire and forget)
        if let jobId = targetJobId, let cloudService = cloudService {
            Task {
                do {
                    try await cloudService.cancelJob(jobId: jobId)
                    print("[TTSJobManager] Cancelled job \(jobId) on server")
                } catch {
                    // Log but don't fail - job may already be complete or cancelled
                    print("[TTSJobManager] Failed to cancel job \(jobId) on server: \(error.localizedDescription)")
                }
            }
        }
    }

    /// Check if a job is being tracked
    func isTracking(articleId: UUID) -> Bool {
        activeJobs[articleId] != nil
    }

    /// Get job info for an article
    func getJobInfo(articleId: UUID) -> JobInfo? {
        activeJobs[articleId]
    }

    /// Get local audio path if available (full audio preferred, preview as fallback)
    func getLocalAudioPath(articleId: UUID) -> URL? {
        guard let jobInfo = activeJobs[articleId] else { return nil }
        return jobInfo.localAudioPath ?? jobInfo.localPreviewPath
    }

    /// Get local preview path if available
    func getLocalPreviewPath(articleId: UUID) -> URL? {
        activeJobs[articleId]?.localPreviewPath
    }

    /// Check if full audio is ready (downloaded locally)
    func isAudioReady(articleId: UUID) -> Bool {
        guard let jobInfo = activeJobs[articleId] else { return false }
        return jobInfo.localAudioPath != nil && jobInfo.status == .ready
    }

    /// Check if any playable audio is available (preview or full, local or remote)
    func hasPlayableAudio(articleId: UUID) -> Bool {
        activeJobs[articleId]?.hasPlayableAudio ?? false
    }

    /// Get the best available playable URL (prefers local cache, falls back to remote)
    func getPlayableURL(articleId: UUID) -> URL? {
        activeJobs[articleId]?.playableURL
    }

    /// Get remote preview URL for immediate streaming (no download wait)
    func getRemotePreviewURL(articleId: UUID) -> URL? {
        activeJobs[articleId]?.remotePreviewURL
    }

    /// Get remote full audio URL for streaming
    func getRemoteFullURL(articleId: UUID) -> URL? {
        activeJobs[articleId]?.remoteFullURL
    }

    /// Get preview duration if known (from backend)
    func getPreviewDuration(articleId: UUID) -> Double? {
        activeJobs[articleId]?.previewDurationSec
    }

    // MARK: - Private Methods

    private func startPolling(for articleId: UUID, jobId: String) {
        // Cancel any existing polling for this article
        pollingTasks[articleId]?.cancel()

        let task = Task { [weak self] in
            guard let self = self else { return }
            await self.pollJobStatus(articleId: articleId, jobId: jobId)
        }

        pollingTasks[articleId] = task
    }

    /// Calculate polling interval with jitter
    private func getPollingInterval(hasAudio: Bool) -> UInt64 {
        let baseIntervalMs = hasAudio ? slowPollingIntervalMs : fastPollingIntervalMs

        // Add jitter: random value in range [-jitterRangeMs, +jitterRangeMs]
        let jitter = Int64.random(in: -Int64(jitterRangeMs)...Int64(jitterRangeMs))
        let intervalMs = Int64(baseIntervalMs) + jitter

        // Convert to nanoseconds, ensure positive
        return UInt64(max(100, intervalMs)) * 1_000_000
    }

    private func pollJobStatus(articleId: UUID, jobId: String) async {
        guard let cloudService = cloudService else {
            print("[TTSJobManager] Cloud service not configured")
            return
        }

        let pollStartTime = Date()
        var pollCount = 0
        var hasNotifiedPreview = false
        var hasNotifiedFull = false

        // Immediate first poll - no delay
        while !Task.isCancelled {
            pollCount += 1

            // Check max polling duration
            let elapsedSeconds = Date().timeIntervalSince(pollStartTime)
            if elapsedSeconds > maxPollingDurationSeconds {
                print("[TTSJobManager] Max polling duration (\(Int(maxPollingDurationSeconds))s) exceeded for job \(jobId)")
                await MainActor.run {
                    self.activeJobs[articleId]?.error = "Synthesis timed out"
                    self.onJobFailed?(articleId, "Audio generation timed out after \(Int(maxPollingDurationSeconds / 60)) minutes")
                    ArticleStore.shared.updateSynthesisStatus(
                        for: articleId,
                        status: .failed(message: "Audio generation timed out after \(Int(maxPollingDurationSeconds / 60)) minutes")
                    )
                }
                break
            }

            do {
                // Fetch job status
                let statusResponse = try await cloudService.fetchJobStatus(jobId: jobId)

                // Update job info
                await MainActor.run {
                    self.updateJobInfo(articleId: articleId, from: statusResponse)
                }

                // Check if job is complete or failed
                switch statusResponse.status {
                case .ready:
                    // Full audio ready - notify for playback swap (only once via guard)
                    if !didSwapToFull.contains(articleId),
                       let fullUrlString = statusResponse.audioUrl,
                       let fullURL = URL(string: fullUrlString) {
                        // Mark guards BEFORE calling callback to prevent duplicates
                        didSwapToFull.insert(articleId)
                        // Also mark playback started (for short texts that skip partialReady)
                        didStartPlayback.insert(articleId)
                        hasNotifiedFull = true

                        // Record first audio time if not already set (for short texts that skip preview)
                        if activeJobs[articleId]?.firstAudioAvailableTime == nil {
                            activeJobs[articleId]?.firstAudioAvailableTime = Date()
                        }

                        let ttfs = Date().timeIntervalSince(activeJobs[articleId]?.jobStartTime ?? pollStartTime)
                        print("[TTSJobManager] Full audio ready in \(String(format: "%.2f", ttfs))s for job \(jobId) (\(pollCount) polls)")

                        // Notify for swap to full audio (streaming from remote URL)
                        // Single-start guard ensures this only fires once per job
                        onFullAudioReady?(articleId, fullURL)

                        // Update ArticleStore
                        ArticleStore.shared.updateSynthesisStatus(
                            for: articleId,
                            status: .completed,
                            audioURL: fullURL
                        )
                    }

                    // Start background download of full audio to cache (non-blocking)
                    startBackgroundDownload(articleId: articleId, from: statusResponse, isPreview: false)

                    return // Stop polling

                case .failed:
                    let errorMsg = statusResponse.error?.message ?? "Job failed"
                    await MainActor.run {
                        self.activeJobs[articleId]?.error = errorMsg
                        self.onJobFailed?(articleId, errorMsg)
                        ArticleStore.shared.updateSynthesisStatus(
                            for: articleId,
                            status: .failed(message: errorMsg)
                        )
                    }
                    return // Stop polling

                case .cancelled:
                    // Job was cancelled, stop tracking
                    await MainActor.run {
                        self.activeJobs.removeValue(forKey: articleId)
                    }
                    return // Stop polling

                case .partialReady:
                    // Preview ready - notify for IMMEDIATE playback from remote URL (only once via guard)
                    if !didStartPlayback.contains(articleId),
                       let previewUrlString = statusResponse.previewUrl,
                       let previewURL = URL(string: previewUrlString) {
                        // Mark as started BEFORE calling callback to prevent duplicates
                        didStartPlayback.insert(articleId)
                        hasNotifiedPreview = true

                        // Record first audio time
                        activeJobs[articleId]?.firstAudioAvailableTime = Date()
                        let ttfs = Date().timeIntervalSince(activeJobs[articleId]?.jobStartTime ?? pollStartTime)
                        print("[TTSJobManager] Preview ready in \(String(format: "%.2f", ttfs))s for job \(jobId) (\(pollCount) polls)")

                        // Get preview duration from response
                        let previewDuration = statusResponse.previewDurationSec

                        // Notify immediately - view should start AVPlayer from remote URL
                        // Single-start guard ensures this only fires once per job
                        onPreviewReady?(articleId, previewURL, previewDuration)

                        // Start background download of preview to cache (non-blocking)
                        startBackgroundDownload(articleId: articleId, from: statusResponse, isPreview: true)
                    }
                    // Continue polling for full audio (with slower cadence)

                case .processing, .queued:
                    // Continue polling (with fast cadence)
                    break
                }

                // Determine polling cadence:
                // - Fast (0.7-1.0s) while queued/processing
                // - Slow (1.5-2.0s) once partial_ready (already playing preview)
                let isPlayingPreview = hasNotifiedPreview && statusResponse.status == .partialReady
                let pollingInterval = getPollingInterval(hasAudio: isPlayingPreview)

                // Wait before next poll
                try await Task.sleep(nanoseconds: pollingInterval)

            } catch is CancellationError {
                break
            } catch let error as TTSJobError {
                if case .jobNotFound = error {
                    // Job expired or was deleted - stop tracking and notify UI
                    print("[TTSJobManager] Job not found (expired?), stopping tracking and notifying UI")
                    await MainActor.run {
                        // Get voiceId before removing
                        let voiceId = self.activeJobs[articleId]?.voiceId ?? ""
                        self.activeJobs.removeValue(forKey: articleId)
                        // Notify UI so it can check cache and potentially restart
                        self.onJobExpired?(articleId, voiceId)
                    }
                    break
                }
                print("[TTSJobManager] Polling error (poll #\(pollCount)): \(error.localizedDescription)")

                // Wait before retry on error (use slow interval)
                let retryInterval = getPollingInterval(hasAudio: true)
                try? await Task.sleep(nanoseconds: retryInterval)
            } catch {
                print("[TTSJobManager] Polling error (poll #\(pollCount)): \(error.localizedDescription)")

                // Wait before retry on error
                let retryInterval = getPollingInterval(hasAudio: true)
                try? await Task.sleep(nanoseconds: retryInterval)
            }
        }

        // Cleanup
        await MainActor.run {
            self.pollingTasks.removeValue(forKey: articleId)
        }
    }

    private func updateJobInfo(articleId: UUID, from response: TTSJobStatusResponse) {
        guard var jobInfo = activeJobs[articleId] else { return }

        jobInfo.status = response.status

        // Use backend-calculated percentage
        jobInfo.progress = Double(response.percentage) / 100.0

        if let audioUrlString = response.audioUrl {
            jobInfo.audioURL = URL(string: audioUrlString)
        }
        if let previewUrlString = response.previewUrl {
            jobInfo.previewURL = URL(string: previewUrlString)
        }

        // Store preview duration from backend
        if let previewDuration = response.previewDurationSec {
            jobInfo.previewDurationSec = previewDuration
        }

        // Cache the full status payload so the rich progress UI can read
        // chunks_total/chunks_completed/queue_depth/queue_position without
        // re-fetching.
        jobInfo.latestStatus = response

        activeJobs[articleId] = jobInfo

        // Update ArticleStore progress
        if response.status == .processing || response.status == .partialReady {
            ArticleStore.shared.updateSynthesisStatus(
                for: articleId,
                status: .inProgress(progress: Float(jobInfo.progress))
            )
        }
    }

    /// Start a background download task that doesn't block playback.
    /// Audio is streamed from remote URL for immediate playback; download caches for offline use.
    private func startBackgroundDownload(articleId: UUID, from response: TTSJobStatusResponse, isPreview: Bool) {
        // Cancel any existing download for this article
        downloadTasks[articleId]?.cancel()

        let task = Task { [weak self] in
            guard let self = self else { return }

            if isPreview {
                await self.downloadPreviewInBackground(articleId: articleId, response: response)
            } else {
                await self.downloadFullAudioInBackground(articleId: articleId, response: response)
            }
        }

        downloadTasks[articleId] = task
    }

    private func downloadFullAudioInBackground(articleId: UUID, response: TTSJobStatusResponse) async {
        guard let audioURLString = response.audioUrl,
              let audioURL = URL(string: audioURLString) else {
            print("[TTSJobManager] No audio URL in response for background download")
            return
        }

        let downloadStart = Date()

        do {
            // Download audio in background (doesn't block playback)
            let (data, _) = try await URLSession.shared.data(from: audioURL)

            guard !Task.isCancelled else { return }

            // Save to local cache
            let localPath = cacheDirectory.appendingPathComponent("\(articleId.uuidString).mp3")
            try data.write(to: localPath)

            let downloadTime = Date().timeIntervalSince(downloadStart)
            print("[TTSJobManager] Background download complete: \(localPath.lastPathComponent) in \(String(format: "%.2f", downloadTime))s")

            await MainActor.run {
                // Update job info with local path (for offline playback)
                self.activeJobs[articleId]?.localAudioPath = localPath
                self.activeJobs[articleId]?.status = .ready

                // Cleanup download task
                self.downloadTasks.removeValue(forKey: articleId)
            }

        } catch is CancellationError {
            print("[TTSJobManager] Background download cancelled for \(articleId)")
        } catch {
            print("[TTSJobManager] Background download failed: \(error.localizedDescription)")
            await MainActor.run {
                self.downloadTasks.removeValue(forKey: articleId)
            }
        }
    }

    private func downloadPreviewInBackground(articleId: UUID, response: TTSJobStatusResponse) async {
        guard let previewUrlString = response.previewUrl,
              let url = URL(string: previewUrlString) else { return }

        let downloadStart = Date()

        do {
            let (data, _) = try await URLSession.shared.data(from: url)

            guard !Task.isCancelled else { return }

            // Save preview to local cache
            let localPath = cacheDirectory.appendingPathComponent("\(articleId.uuidString)_preview.mp3")
            try data.write(to: localPath)

            let downloadTime = Date().timeIntervalSince(downloadStart)
            print("[TTSJobManager] Background preview download complete: \(localPath.lastPathComponent) in \(String(format: "%.2f", downloadTime))s")

            await MainActor.run {
                self.activeJobs[articleId]?.localPreviewPath = localPath
            }

        } catch is CancellationError {
            print("[TTSJobManager] Background preview download cancelled for \(articleId)")
        } catch {
            print("[TTSJobManager] Background preview download failed: \(error.localizedDescription)")
        }
    }

    // MARK: - Cache Management

    /// Clear cached audio for an article
    func clearCache(for articleId: UUID) {
        let audioPath = cacheDirectory.appendingPathComponent("\(articleId.uuidString).mp3")
        let previewPath = cacheDirectory.appendingPathComponent("\(articleId.uuidString)_preview.mp3")

        try? FileManager.default.removeItem(at: audioPath)
        try? FileManager.default.removeItem(at: previewPath)
    }

    /// Clear all cached audio
    func clearAllCache() {
        try? FileManager.default.removeItem(at: cacheDirectory)
        try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)
    }

    /// Clear all persisted TTS data for an article (UserDefaults entries for all voices)
    /// Call this when an article is deleted to clean up all associated data.
    func clearAllPersistedData(for articleId: UUID) {
        let articleIdString = articleId.uuidString
        let prefixes = [
            "ttsJobId_\(articleIdString)_",
            "ttsJobStatus_\(articleIdString)_",
            "ttsFullAudioUrl_\(articleIdString)_"
        ]

        // Find and remove all UserDefaults keys for this article
        let defaults = UserDefaults.standard
        let allKeys = defaults.dictionaryRepresentation().keys

        for key in allKeys {
            for prefix in prefixes {
                if key.hasPrefix(prefix) {
                    defaults.removeObject(forKey: key)
                    print("[TTSJobManager] Cleared persisted key: \(key)")
                }
            }
        }

        // Also clear local cache
        clearCache(for: articleId)

        print("[TTSJobManager] Cleared all persisted data for article \(articleIdString)")
    }

    // MARK: - Metrics

    /// Get time-to-first-sound for a job (if available)
    func getTimeToFirstSound(articleId: UUID) -> TimeInterval? {
        guard let jobInfo = activeJobs[articleId],
              let firstAudioTime = jobInfo.firstAudioAvailableTime else {
            return nil
        }
        return firstAudioTime.timeIntervalSince(jobInfo.jobStartTime)
    }
}
