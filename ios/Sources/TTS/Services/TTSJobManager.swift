import Foundation

// MARK: - TTS Job Manager

/// Manages TTS jobs in the background, continuing to poll and download audio
/// even when the user leaves the article view.
///
/// Polling Strategy for Fast TTFS (Time-To-First-Sound):
/// 1. Immediate first poll after job starts (no initial delay)
/// 2. Fast polling (0.5-1.0s) until playable audio is available
/// 3. Slow polling (1.5-2.0s) once preview/full audio exists
/// 4. Jitter of ±200ms to avoid thundering herd
/// 5. Max polling duration of 10 minutes per job
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
        var previewURL: URL?
        var audioURL: URL?
        var progress: Double
        var error: String?
        var localAudioPath: URL?
        var localPreviewPath: URL?

        // Timing metrics
        let jobStartTime: Date
        var firstAudioAvailableTime: Date?

        /// Whether any playable audio is available (preview or full)
        var hasPlayableAudio: Bool {
            localAudioPath != nil || localPreviewPath != nil
        }
    }

    // MARK: - Polling Configuration

    /// Fast polling interval when waiting for audio (milliseconds)
    private let fastPollingIntervalMs: UInt64 = 1500  // 1.5 seconds

    /// Slow polling interval once audio is available (milliseconds)
    private let slowPollingIntervalMs: UInt64 = 3000  // 3 seconds

    /// Jitter range (milliseconds) - ±300ms
    private let jitterRangeMs: UInt64 = 300

    /// Maximum polling duration before marking job as failed (seconds)
    private let maxPollingDurationSeconds: TimeInterval = 600  // 10 minutes

    // MARK: - Private Properties

    private var pollingTasks: [UUID: Task<Void, Never>] = [:]
    private var cloudService: ListenAICloudService?

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
        activeJobs.removeValue(forKey: articleId)

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

    /// Check if any playable audio is available (preview or full)
    func hasPlayableAudio(articleId: UUID) -> Bool {
        activeJobs[articleId]?.hasPlayableAudio ?? false
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
        var hasLoggedFirstAudio = false

        // Immediate first poll - no delay
        while !Task.isCancelled {
            pollCount += 1

            // Check max polling duration
            let elapsedSeconds = Date().timeIntervalSince(pollStartTime)
            if elapsedSeconds > maxPollingDurationSeconds {
                print("[TTSJobManager] Max polling duration (\(Int(maxPollingDurationSeconds))s) exceeded for job \(jobId)")
                await MainActor.run {
                    self.activeJobs[articleId]?.error = "Synthesis timed out"
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
                    // Download the full audio
                    await downloadAudio(articleId: articleId, from: statusResponse)

                    // Log TTFS metric
                    if let jobInfo = activeJobs[articleId] {
                        let ttfs = Date().timeIntervalSince(jobInfo.jobStartTime)
                        print("[TTSJobManager] TTFS: \(String(format: "%.2f", ttfs))s for job \(jobId) (full audio ready, \(pollCount) polls)")
                    }
                    return // Stop polling

                case .failed:
                    await MainActor.run {
                        self.activeJobs[articleId]?.error = statusResponse.error ?? "Job failed"
                        ArticleStore.shared.updateSynthesisStatus(
                            for: articleId,
                            status: .failed(message: statusResponse.error ?? "TTS job failed")
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
                    // Download preview if available and not already downloaded
                    if let previewUrlString = statusResponse.previewUrl,
                       activeJobs[articleId]?.localPreviewPath == nil {
                        await downloadPreview(articleId: articleId, previewURL: previewUrlString)

                        // Log first audio availability
                        if !hasLoggedFirstAudio {
                            hasLoggedFirstAudio = true
                            if let jobInfo = activeJobs[articleId] {
                                let ttfs = Date().timeIntervalSince(jobInfo.jobStartTime)
                                print("[TTSJobManager] TTFS (preview): \(String(format: "%.2f", ttfs))s for job \(jobId) (\(pollCount) polls)")
                            }
                        }
                    }
                    // Continue polling for full audio

                case .processing, .queued:
                    // Continue polling
                    break
                }

                // Determine if we have playable audio for polling cadence
                let hasPlayable = activeJobs[articleId]?.hasPlayableAudio ?? false
                let pollingInterval = getPollingInterval(hasAudio: hasPlayable)

                // Wait before next poll
                try await Task.sleep(nanoseconds: pollingInterval)

            } catch is CancellationError {
                break
            } catch let error as TTSJobError {
                if case .jobNotFound = error {
                    // Job expired or was deleted - stop tracking
                    print("[TTSJobManager] Job not found, stopping tracking")
                    await MainActor.run {
                        self.activeJobs.removeValue(forKey: articleId)
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

        // Use progressSec if available, otherwise estimate from duration
        if let progressSec = response.progressSec, let durationSec = response.durationSec, durationSec > 0 {
            jobInfo.progress = progressSec / durationSec
        } else {
            jobInfo.progress = 0
        }

        if let audioUrlString = response.fullUrl ?? response.audioUrl {
            jobInfo.audioURL = URL(string: audioUrlString)
        }
        if let previewUrlString = response.previewUrl {
            jobInfo.previewURL = URL(string: previewUrlString)
        }

        activeJobs[articleId] = jobInfo

        // Update ArticleStore progress
        if response.status == .processing || response.status == .partialReady {
            ArticleStore.shared.updateSynthesisStatus(
                for: articleId,
                status: .inProgress(progress: Float(jobInfo.progress))
            )
        }
    }

    private func downloadAudio(articleId: UUID, from response: TTSJobStatusResponse) async {
        guard let audioURLString = response.fullUrl ?? response.audioUrl,
              let audioURL = URL(string: audioURLString) else {
            print("[TTSJobManager] No audio URL in response")
            return
        }

        let downloadStart = Date()

        do {
            // Download audio
            let (data, _) = try await URLSession.shared.data(from: audioURL)

            // Save to local cache
            let localPath = cacheDirectory.appendingPathComponent("\(articleId.uuidString).mp3")
            try data.write(to: localPath)

            let downloadTime = Date().timeIntervalSince(downloadStart)
            print("[TTSJobManager] Downloaded audio to \(localPath.lastPathComponent) in \(String(format: "%.2f", downloadTime))s")

            await MainActor.run {
                // Update job info
                self.activeJobs[articleId]?.localAudioPath = localPath
                self.activeJobs[articleId]?.status = .ready

                // Record first audio time if not already set
                if self.activeJobs[articleId]?.firstAudioAvailableTime == nil {
                    self.activeJobs[articleId]?.firstAudioAvailableTime = Date()
                }

                // Update ArticleStore
                ArticleStore.shared.updateSynthesisStatus(
                    for: articleId,
                    status: .completed,
                    audioURL: localPath
                )
            }

        } catch {
            print("[TTSJobManager] Failed to download audio: \(error.localizedDescription)")
        }
    }

    private func downloadPreview(articleId: UUID, previewURL: String) async {
        guard let url = URL(string: previewURL) else { return }

        let downloadStart = Date()

        do {
            let (data, _) = try await URLSession.shared.data(from: url)

            // Save preview to local cache
            let localPath = cacheDirectory.appendingPathComponent("\(articleId.uuidString)_preview.mp3")
            try data.write(to: localPath)

            let downloadTime = Date().timeIntervalSince(downloadStart)
            print("[TTSJobManager] Downloaded preview to \(localPath.lastPathComponent) in \(String(format: "%.2f", downloadTime))s")

            await MainActor.run {
                self.activeJobs[articleId]?.previewURL = url
                self.activeJobs[articleId]?.localPreviewPath = localPath

                // Record first audio time
                if self.activeJobs[articleId]?.firstAudioAvailableTime == nil {
                    self.activeJobs[articleId]?.firstAudioAvailableTime = Date()
                }
            }

        } catch {
            print("[TTSJobManager] Failed to download preview: \(error.localizedDescription)")
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
