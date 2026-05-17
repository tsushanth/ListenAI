import SwiftUI
import AVFoundation

// MARK: - Article Reader View

/// Full-screen view displaying article content with text highlighting during playback.
/// Design with yellow text highlighting and bottom player bar.
struct ArticleReaderView: View {
    let article: Article
    /// When true, the reader fires `startPlayback()` shortly after appearing.
    /// Used by the queue's "needs synthesis" path so the user doesn't have to
    /// tap play after the reader pops up — the queue tap is the play intent.
    var autoPlayOnAppear: Bool = false

    @EnvironmentObject var playbackService: AudioPlaybackService
    @EnvironmentObject var queueManager: QueueManager
    @StateObject private var voicePresetManager = VoicePresetManager.shared
    @ObservedObject private var articleStore = ArticleStore.shared
    @Environment(\.dismiss) private var dismiss

    /// Get the current article state from the store (observes synthesis status updates)
    private var currentArticle: Article {
        articleStore.article(withID: article.id) ?? article
    }

    /// Check if synthesis is queued
    private var isQueued: Bool {
        if case .queued = currentArticle.synthesisStatus { return true }
        return false
    }

    /// Determine if we should show the "Preparing audio" banner
    private var shouldShowSynthesisBanner: Bool {
        // Show if local synthesis is active
        if isSynthesizing { return true }

        let status = currentArticle.synthesisStatus

        // Show if background synthesis is in progress or queued
        if status.isInProgress || isQueued { return true }

        // Show if article is in library and hasn't been synthesized yet
        // (synthesis will start/has started but status might not be updated yet)
        if isInLibrary && !status.isComplete {
            // Don't show for failed status (let them retry manually)
            if case .failed = status { return false }
            return true
        }

        return false
    }

    @State private var showingFullPlayer = false
    @State private var showingVoicePicker = false
    @State private var showingTextSettings = false
    @State private var showingQuotaWarning = false
    @State private var showingRegenerateConfirm = false
    @State private var showingAddedToLibrary = false
    @State private var isSynthesizing = false
    @State private var synthesisError: String?
    @State private var synthesisProgress: Float = 0
    @State private var lastUsedVoiceID: UUID?
    @State private var lastUsedProviderVoiceID: String?
    @State private var pendingUsageEstimate: UsageEstimate?
    @State private var synthesisStartTime: Date?
    @State private var estimatedTimeString: String = "~5 seconds"
    @State private var isSeeking: Bool = false
    @State private var seekPosition: Double = 0

    /// Check if article is already in the library
    private var isInLibrary: Bool {
        articleStore.article(withID: article.id) != nil
    }

    // Text display settings
    @AppStorage("readerFontSize") private var fontSize: Double = 18
    @AppStorage("readerLineSpacing") private var lineSpacing: Double = 8
    @AppStorage("readerFontType") private var fontType: String = "System"
    @AppStorage("readerHighlightStyle") private var highlightStyle: String = "Natural"
    @AppStorage("readerHighlightWordOnly") private var highlightWordOnly: Bool = false
    @AppStorage("readerThemeMode") private var themeMode: String = "System"

    // More options sheet
    @State private var showingMoreOptions = false
    @State private var showingAppearance = false

    // AI Chat state
    @State private var showingAIChat = false

    // Streaming TTS settings (experimental) - DEPRECATED: now using URL-based playback
    @AppStorage("useStreamingTTS") private var useStreamingTTS: Bool = false
    @StateObject private var streamingTTS = StreamingTTSService.shared

    // TTS provider - always use Kokoro (selfhosted) with GPU acceleration
    private var ttsProvider: ListenAICloudService.TTSProvider {
        .selfhosted  // GPU-accelerated Kokoro TTS
    }

    // URL-based audio player for job-based TTS
    @StateObject private var urlPlayer = URLAudioPlayer.shared

    // TTSJobManager as single source of truth for job state (DRY consolidation)
    @ObservedObject private var ttsJobManager = TTSJobManager.shared

    // Local polling task (for when TTSJobManager isn't tracking yet)
    @State private var pollingTask: Task<Void, Never>?

    // Client-side progress interpolation for smooth progress display
    @State private var interpolatedProgressSec: Double = 0
    @State private var progressInterpolationTimer: Timer?
    @State private var lastProgressUpdateTime: Date?

    // Estimated wait time from initial job response (not in TTSJobManager)
    @State private var ttsJobEstimatedWaitSec: Int?

    // Quota limit error state
    @State private var showingQuotaLimitSheet = false
    @State private var quotaLimitError: TTSJobError?
    @StateObject private var quotaErrorState = QuotaErrorState.shared
    @State private var showingUpgradePrompt = false

    // Background synthesis with notification
    @State private var showNotifyWhenReadyOption = false
    @State private var isGeneratingInBackground = false
    @State private var showNotificationExplanation = false

    // MARK: - Job State from TTSJobManager (Single Source of Truth)

    /// Current job ID from TTSJobManager
    private var ttsJobId: String? {
        currentJobInfo?.jobId
    }

    /// Current job status from TTSJobManager
    private var ttsJobStatus: TTSJobStatus? {
        currentJobInfo?.status
    }

    /// Current job error from TTSJobManager
    private var ttsJobError: String? {
        currentJobInfo?.error
    }

    /// Progress in seconds from TTSJobManager
    private var ttsJobProgressSec: Double {
        guard let jobInfo = currentJobInfo else { return 0 }
        // Calculate from progress percentage and estimated duration
        let estimatedDuration = estimatedAudioDurationForArticle
        return estimatedDuration * jobInfo.progress
    }

    /// Total duration estimate (calculated from article text length)
    private var ttsJobTotalDurationSec: Double {
        estimatedAudioDurationForArticle
    }

    /// Estimated remaining time (calculated from progress)
    private var ttsJobEstimatedRemainingSec: Int? {
        guard let jobInfo = currentJobInfo, jobInfo.progress > 0 else { return nil }
        let remaining = ttsJobTotalDurationSec * (1.0 - jobInfo.progress)
        // Estimate synthesis time (roughly 8x realtime for GPU TTS)
        return Int(remaining / 8.0)
    }

    /// Estimated audio duration for the article text
    private var estimatedAudioDurationForArticle: Double {
        // ~12.5 chars per second speaking rate
        Double(article.rawText.count) / 12.5
    }

    /// Check if TTS job is currently generating
    private var isGeneratingTTS: Bool {
        guard let status = ttsJobStatus else { return false }
        return status.isInProgress
    }

    /// Check if Play button should be disabled due to quota exceeded (for cloud voices only)
    private var isPlayDisabledByQuota: Bool {
        // Only disable if using a cloud voice
        let currentVoice = voicePresetManager.selectedPreset
        guard currentVoice.provider != .apple else { return false }

        // Check if quota is blocked
        return quotaErrorState.isPlayDisabledDueToQuota
    }

    /// Progress percentage for job-based TTS (0.0 to 1.0)
    /// Uses interpolated progress for smooth animation between backend updates
    private var ttsJobProgressPercentage: Double {
        guard ttsJobTotalDurationSec > 0 else { return 0 }
        // Use interpolated progress for smoother display
        let effectiveProgress = max(ttsJobProgressSec, interpolatedProgressSec)
        return min(effectiveProgress / ttsJobTotalDurationSec, 1.0)
    }

    /// Progress string for job-based TTS showing percentage and time
    private var ttsJobProgressString: String {
        let percentage = Int(ttsJobProgressPercentage * 100)

        // Use backend-calculated remaining time if available (most accurate)
        if let remainingSec = ttsJobEstimatedRemainingSec, remainingSec >= 0 {
            if remainingSec < 5 {
                return "\(percentage)% • finishing up..."
            } else if remainingSec < 60 {
                return "\(percentage)% • ~\(remainingSec)s left"
            } else {
                return "\(percentage)% • ~\(remainingSec / 60)m left"
            }
        }

        // Fallback if no backend estimate
        if ttsJobProgressSec > 0 {
            return String(format: "\(percentage)%% • %.0fs generated", ttsJobProgressSec)
        } else if let waitSec = ttsJobEstimatedWaitSec {
            return "starting in ~\(waitSec)s"
        }
        return estimatedTimeString
    }

    var body: some View {
        VStack(spacing: 0) {
            // Synthesis status banner at top (always visible, not scrollable)
            if shouldShowSynthesisBanner {
                synthesisProgressBanner
                    .padding(.horizontal)
                    .padding(.top, 8)
            }

            // Scrollable content
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        // Article content with highlighting
                        articleContent
                            .padding(.horizontal)
                            .padding(.top, 16)
                            .padding(.bottom, 120) // Space for player bar
                    }
                }
                .onChange(of: currentHighlightIndex) { _, newIndex in
                    // Auto-scroll to current highlighted text
                    if let index = newIndex {
                        withAnimation(.easeInOut(duration: 0.3)) {
                            proxy.scrollTo("paragraph-\(index)", anchor: .center)
                        }
                    }
                }
            }

            // Bottom player bar
            playerBar
        }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                HStack(spacing: 16) {
                    // Appearance settings (Aa icon)
                    Button {
                        showingAppearance = true
                    } label: {
                        Image(systemName: "textformat.size")
                            .font(.body)
                    }

                    // AI/Summarize (sparkle icon)
                    Button {
                        showingAIChat = true
                    } label: {
                        Image(systemName: "sparkles")
                            .font(.body)
                            .foregroundStyle(.primary)
                    }

                    // Voice picker (head icon)
                    Button {
                        showingVoicePicker = true
                    } label: {
                        Image(systemName: "person.wave.2")
                            .font(.body)
                    }

                    // More options (ellipsis)
                    Button {
                        showingMoreOptions = true
                    } label: {
                        Image(systemName: "ellipsis.circle")
                            .font(.body)
                    }
                }
            }
        }
        .alert("Added to Library", isPresented: $showingAddedToLibrary) {
            Button("OK", role: .cancel) { }
        } message: {
            Text("This article has been saved to your library and audio synthesis has started.")
        }
        .confirmationDialog("Regenerate Audio?", isPresented: $showingRegenerateConfirm, titleVisibility: .visible) {
            Button("Regenerate with \(voicePresetManager.selectedPreset.name)") {
                regenerateAudio()
            }
            Button("Cancel", role: .cancel) { }
        } message: {
            Text("This will create new audio using the current voice. The existing audio will be replaced.")
        }
        .sheet(isPresented: $showingFullPlayer) {
            AudioPlayerView(playbackService: playbackService)
        }
        .sheet(isPresented: $showingVoicePicker) {
            SelectVoiceView()
        }
        .fullScreenCover(isPresented: $showingAIChat) {
            AIChatView(article: article)
        }
        .sheet(isPresented: $showingTextSettings) {
            TextSettingsSheet(fontSize: $fontSize, lineSpacing: $lineSpacing)
                .presentationDetents([.height(200)])
        }
        .sheet(isPresented: $showingAppearance) {
            AppearanceSettingsSheet(
                fontSize: $fontSize,
                lineSpacing: $lineSpacing,
                fontType: $fontType,
                highlightStyle: $highlightStyle,
                highlightWordOnly: $highlightWordOnly,
                themeMode: $themeMode
            )
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showingMoreOptions) {
            MoreOptionsSheet(
                article: article,
                isInLibrary: isInLibrary,
                onAddToLibrary: addToLibrary,
                onAddToQueue: { addToQueue() },
                onMarkAsFinished: { markAsFinished() },
                onToggleFavorite: toggleFavorite,
                onExportAudio: { exportAudio() },
                onDeleteFile: { deleteArticle() },
                onRegenerateAudio: { showingRegenerateConfirm = true }
            )
            .presentationDetents([.medium, .large])
        }
        .alert("Error", isPresented: .constant(synthesisError != nil)) {
            Button("Retry") {
                synthesisError = nil
                ttsJobManager.stopTracking(articleId: article.id)  // Clear any job error state
                synthesizeAndPlay()
            }
            Button("Cancel", role: .cancel) {
                synthesisError = nil
                ttsJobManager.stopTracking(articleId: article.id)  // Clear any job error state
            }
        } message: {
            Text(synthesisError ?? "")
        }
        .alert("Get Notified When Ready", isPresented: $showNotificationExplanation) {
            Button("Enable Notifications") {
                Task {
                    await enableBackgroundNotification()
                }
            }
            Button("Not Now", role: .cancel) {}
        } message: {
            Text("Most audio generates in seconds, but longer content may take a bit more time.\n\nWe'll send you ONE notification when your audio is ready to play. We never send marketing or promotional notifications.")
        }
        .sheet(isPresented: $showingQuotaWarning) {
            if let estimate = pendingUsageEstimate {
                SynthesisConfirmationSheet(
                    estimate: estimate,
                    articleTitle: article.displayTitle,
                    isPresented: $showingQuotaWarning
                ) { useCloud in
                    if useCloud {
                        // Proceed with cloud synthesis - use job-based API
                        synthesizeAndPlay()
                    } else {
                        // Use on-device voice (switch to Apple TTS)
                        switchToOnDeviceAndSynthesize()
                    }
                }
            }
        }
        .sheet(isPresented: $showingQuotaLimitSheet) {
            if let error = quotaLimitError {
                QuotaLimitSheet(
                    error: error,
                    isPresented: $showingQuotaLimitSheet,
                    onUpgrade: {
                        showingUpgradePrompt = true
                    },
                    onUseOnDevice: {
                        switchToOnDeviceAndSynthesize()
                    },
                    onDismiss: {
                        quotaLimitError = nil
                    }
                )
            }
        }
        .sheet(isPresented: $showingUpgradePrompt) {
            UpgradePromptView()
        }
        .onAppear {
            // Track current voice when view appears (both ID and provider voice ID for cloned voices)
            lastUsedVoiceID = voicePresetManager.selectedPreset.id
            lastUsedProviderVoiceID = voicePresetManager.selectedPreset.providerVoiceID
            // Hide global mini player since we have our own player bar
            playbackService.isArticleReaderActive = true
            print("[ArticleReader] onAppear - hiding mini player")

            // Check and reset daily quota if new day
            quotaErrorState.checkAndResetDailyQuota()

            // Setup TTSJobManager callbacks for immediate playback
            setupTTSJobManagerCallbacks()

            // Check for persisted job and resume polling if needed
            checkAndResumePersistedJob()

            // Auto-start when the reader was opened by the queue (the user tapped
            // "Play Queue" expecting audio, not a reader pop-up). Slight delay
            // so the view's state observers settle before startPlayback consults
            // synthesis state.
            if autoPlayOnAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) {
                    startPlayback()
                }
            }
        }
        .onDisappear {
            // Show global mini player again when leaving
            // Reset immediately - no delay needed since we're already disappearing
            playbackService.isArticleReaderActive = false
            print("[ArticleReader] onDisappear - showing mini player")

            // Hand off job polling to TTSJobManager so it continues in background
            // The manager will download audio when ready and update ArticleStore
            if let jobId = ttsJobId, let status = ttsJobStatus, status != .ready && status != .failed {
                TTSJobManager.shared.trackJob(
                    articleId: article.id,
                    jobId: jobId,
                    voiceId: voicePresetManager.selectedPreset.providerVoiceID,
                    initialStatus: status
                )
                print("[ArticleReader] Handed off job \(jobId) to TTSJobManager for background polling")
            }

            // Cancel local polling (TTSJobManager will continue)
            cancelPolling()
        }
        .onChange(of: voicePresetManager.selectedPreset.id) { _, newVoiceID in
            // Voice changed by ID - only invalidate if user explicitly changed voice during this session
            // Skip if this is the initial setup (lastUsedVoiceID being set for first time)
            guard let previousVoiceID = lastUsedVoiceID, previousVoiceID != newVoiceID else {
                // First time setting or same voice - just update tracking
                lastUsedVoiceID = newVoiceID
                lastUsedProviderVoiceID = voicePresetManager.selectedPreset.providerVoiceID
                return
            }

            // User changed voice during this session
            print("[ArticleReader] Voice changed from \(previousVoiceID) to \(newVoiceID)")

            // Stop current audio and cancel any pending job for old voice
            handleVoiceChange(previousVoiceId: lastUsedProviderVoiceID ?? "")

            lastUsedVoiceID = newVoiceID
            lastUsedProviderVoiceID = voicePresetManager.selectedPreset.providerVoiceID

            // Check if new voice has persisted audio ready (for instant replay when switching back)
            checkAndResumePersistedJob()
        }
        .onChange(of: voicePresetManager.selectedPreset.providerVoiceID) { oldProviderVoiceID, newProviderVoiceID in
            // Provider voice ID changed (e.g., switched to different ElevenLabs voice)
            guard oldProviderVoiceID != newProviderVoiceID else { return }

            print("[ArticleReader] Provider voice changed from \(oldProviderVoiceID) to \(newProviderVoiceID)")

            // Stop current audio and cancel any pending job for old voice
            handleVoiceChange(previousVoiceId: oldProviderVoiceID)

            lastUsedProviderVoiceID = newProviderVoiceID

            // Check if new voice has persisted audio ready (for instant replay when switching back)
            checkAndResumePersistedJob()
        }
        .onReceive(NotificationCenter.default.publisher(for: .voiceDidChange)) { notification in
            // Voice changed via SelectVoiceView
            if let newVoice = notification.object as? VoicePreset {
                let oldProviderVoiceID = lastUsedProviderVoiceID

                // Check if this is actually a change
                if lastUsedVoiceID != newVoice.id || lastUsedProviderVoiceID != newVoice.providerVoiceID {
                    print("[ArticleReader] Voice changed via picker to: \(newVoice.name)")

                    // Stop current audio and cancel any pending job for old voice
                    if let oldId = oldProviderVoiceID {
                        handleVoiceChange(previousVoiceId: oldId)
                    }

                    lastUsedVoiceID = newVoice.id
                    lastUsedProviderVoiceID = newVoice.providerVoiceID

                    // Check if new voice has persisted audio ready (for instant replay when switching back)
                    checkAndResumePersistedJob()
                } else {
                    lastUsedVoiceID = newVoice.id
                    lastUsedProviderVoiceID = newVoice.providerVoiceID
                }
            }
        }
        .onChange(of: streamingTTS.isPlaying) { _, isPlaying in
            // Stop showing spinner once streaming audio starts playing (legacy)
            if isPlaying && isSynthesizing && useStreamingTTS {
                isSynthesizing = false
            }
        }
        .onChange(of: urlPlayer.isPlaying) { _, isPlaying in
            // Stop showing spinner once URL audio starts playing
            if isPlaying && isSynthesizing {
                isSynthesizing = false
            }
        }
        .onChange(of: articleStore.articles) { _, _ in
            // Check if pre-synthesis completed and auto-play
            checkAndAutoPlayIfSynthesisComplete()
        }
        .preferredColorScheme(preferredColorScheme)
    }

    // MARK: - Article Content with Highlighting

    private var articleContent: some View {
        VStack(alignment: .leading, spacing: lineSpacing * 2) {
            // Article header
            articleHeader

            Divider()
                .padding(.vertical, 8)

            // Render formatted text with markdown support
            FormattedTextView(
                content: article.rawText,
                fontSize: fontSize,
                lineSpacing: lineSpacing,
                highlightIndex: currentHighlightIndex,
                highlightColor: highlightColor,
                highlightWordOnly: highlightWordOnly
            )
        }
    }

    private var articleHeader: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Title
            Text(article.displayTitle)
                .font(.title2.weight(.bold))
                .foregroundStyle(.primary)

            // Metadata row
            HStack(spacing: 16) {
                // Source type badge
                HStack(spacing: 4) {
                    Image(systemName: article.sourceType.iconName)
                        .font(.caption)
                    Text(article.sourceType.displayName)
                        .font(.caption)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Color.blue.opacity(0.1))
                .foregroundStyle(Color.blue)
                .clipShape(Capsule())

                // Author
                Text("by \(article.displayAuthor)")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)

                Spacer()
            }

            // Stats row
            HStack(spacing: 20) {
                Label("\(article.wordCount) words", systemImage: "text.word.spacing")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Label(article.estimatedDuration.formattedDurationShort, systemImage: "clock")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                if let siteName = article.siteName {
                    Label(siteName, systemImage: "globe")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
    }

    private var synthesisProgressBanner: some View {
        let status = currentArticle.synthesisStatus
        let progressValue: Float? = {
            if case .inProgress(let progress) = status {
                return progress
            }
            return nil
        }()

        // Determine if this is a job-based TTS in progress
        let isJobBased = ttsJobId != nil && isGeneratingTTS

        // Calculate effective progress for progress bar
        let effectiveProgress: Double = {
            if isJobBased && ttsJobProgressPercentage > 0 {
                return ttsJobProgressPercentage
            } else if let progress = progressValue {
                return Double(progress)
            }
            return 0
        }()

        return VStack(spacing: 8) {
            HStack(spacing: 12) {
                // Show progress indicator
                if effectiveProgress > 0 {
                    // Circular progress when we have actual progress
                    ZStack {
                        Circle()
                            .stroke(Color.blue.opacity(0.2), lineWidth: 3)
                            .frame(width: 28, height: 28)
                        Circle()
                            .trim(from: 0, to: CGFloat(effectiveProgress))
                            .stroke(Color.blue, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                            .frame(width: 28, height: 28)
                            .rotationEffect(.degrees(-90))
                            .animation(.easeInOut(duration: 0.3), value: effectiveProgress)

                        // Percentage in center
                        Text("\(Int(effectiveProgress * 100))")
                            .font(.system(size: 9, weight: .semibold))
                            .foregroundStyle(.blue)
                    }
                } else {
                    // Indeterminate spinner
                    ProgressView()
                        .scaleEffect(0.9)
                }

                VStack(alignment: .leading, spacing: 2) {
                    // Show job status if available
                    if isJobBased {
                        Text(jobStatusDisplayText)
                            .font(.subheadline.weight(.medium))
                    } else {
                        Text("Preparing audio...")
                            .font(.subheadline.weight(.medium))
                    }

                    // Show progress from job API or legacy progress
                    if isJobBased {
                        Text("\(voicePresetManager.selectedPreset.name) • \(ttsJobProgressString)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else if let progress = progressValue, progress > 0 {
                        Text("\(voicePresetManager.selectedPreset.name) • \(Int(progress * 100))% complete")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    } else {
                        Text("\(voicePresetManager.selectedPreset.name) • \(estimatedTimeString)")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                // Cancel button for job-based TTS
                if isJobBased && !isGeneratingInBackground {
                    Button {
                        cancelTTSJob()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                            .font(.title3)
                    }
                    .buttonStyle(.plain)
                }

                // Background indicator
                if isGeneratingInBackground {
                    Image(systemName: "bell.badge.fill")
                        .foregroundStyle(.blue)
                        .font(.title3)
                }
            }

            // Rich Cloud TTS progress: chunk strip + queue position + "use offline AI"
            // CTA when queue_depth > 5. Falls back to a thin linear bar if no
            // backend status payload is cached yet.
            if isJobBased && !isGeneratingInBackground {
                if let latest = currentJobInfo?.latestStatus {
                    CloudTTSProgressView(
                        response: latest,
                        onUseOffline: { switchToOfflineSynthesis() }
                    )
                } else if effectiveProgress > 0 {
                    // Pre-status fallback (first poll hasn't returned yet)
                    GeometryReader { geometry in
                        ZStack(alignment: .leading) {
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color.blue.opacity(0.2))
                                .frame(height: 4)
                            RoundedRectangle(cornerRadius: 2)
                                .fill(Color.blue)
                                .frame(width: geometry.size.width * CGFloat(effectiveProgress), height: 4)
                                .animation(.easeInOut(duration: 0.3), value: effectiveProgress)
                        }
                    }
                    .frame(height: 4)
                }
            }

            // Offline synthesis indicator + "Switch to cloud" CTA. Mirrors the
            // CloudTTSProgressView's "Use offline AI" CTA so users always know
            // which path they're on and can flip if the on-device run is
            // taking too long (e.g. mid-playback OOM, no GPU on this device).
            if !isJobBased && isSynthesizing && voicePresetManager.isOfflineAIActive && !isGeneratingInBackground {
                HStack(spacing: 8) {
                    Image(systemName: "iphone.gen3")
                        .font(.caption)
                        .foregroundStyle(.purple)
                    Text("Generating on-device")
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                    Spacer()
                    Button {
                        switchToCloudSynthesis()
                    } label: {
                        Text("Switch to cloud")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.blue)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.top, 2)
            }

            // "Notify when ready" option - shown after synthesis takes a while
            if showNotifyWhenReadyOption && isJobBased && !isGeneratingInBackground {
                Divider()

                Button {
                    showNotificationExplanation = true
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "bell.fill")
                            .font(.subheadline)
                        Text("Notify me when ready")
                            .font(.subheadline.weight(.medium))
                    }
                    .foregroundStyle(.blue)
                    .frame(maxWidth: .infinity)
                }
                .buttonStyle(.plain)
            }
        }
        .padding()
        .background(isGeneratingInBackground ? Color.blue.opacity(0.05) : Color.blue.opacity(0.1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    /// Display text for current job status
    private var jobStatusDisplayText: String {
        switch ttsJobStatus {
        case .queued:
            return "Queued..."
        case .processing:
            return "Generating audio..."
        case .partialReady:
            return "Almost ready..."
        case .ready:
            return "Ready!"
        case .failed:
            return "Generation failed"
        case .cancelled:
            return "Cancelled"
        case .none:
            return "Preparing audio..."
        }
    }

    /// Estimate synthesis time based on character count.
    /// GPU-accelerated Kokoro TTS processes at ~8x realtime speed.
    private func estimatedSynthesisTime(for characterCount: Int) -> String {
        // Average speaking rate: ~150 words/minute = 2.5 words/second
        // Average word length: ~5 characters, so ~12.5 chars/second for speech
        // GPU TTS runs at ~8x realtime, so synthesis takes audioDuration/8
        // Formula: (characterCount / 12.5) / 8 = characterCount / 100
        // Add network overhead of ~3 seconds for micro-first preview
        let estimatedAudioDuration = Double(characterCount) / 12.5
        let estimatedSynthesisSeconds = (estimatedAudioDuration / 8.0) + 3.0

        if estimatedSynthesisSeconds < 10 {
            return "~5-10 seconds"
        } else if estimatedSynthesisSeconds < 30 {
            return "~\(Int(estimatedSynthesisSeconds / 5) * 5) seconds"
        } else if estimatedSynthesisSeconds < 60 {
            return "~\(Int(estimatedSynthesisSeconds / 10) * 10) seconds"
        } else if estimatedSynthesisSeconds < 120 {
            return "~1 minute"
        } else {
            let minutes = Int(estimatedSynthesisSeconds / 60)
            return "~\(minutes) minutes"
        }
    }

    /// Estimate synthesis time for cloned voice synthesis.
    /// Cloned voices are much slower than Kokoro - they run at sub-realtime speeds.
    private func estimatedClonedVoiceSynthesisTime(characterCount: Int, model: VoiceCloningModel) -> String {
        // Average speaking rate: ~12.5 chars/second for audio
        let estimatedAudioDuration = Double(characterCount) / 12.5

        // Cloned voice synthesis speeds (relative to realtime):
        // - XTTS: ~0.5x realtime (synthesis takes 2x the audio duration)
        // - Chatterbox: ~0.3x realtime (synthesis takes 3.3x the audio duration)
        let synthesisMultiplier: Double
        switch model {
        case .xtts:
            synthesisMultiplier = 2.0  // XTTS is faster
        case .chatterbox:
            synthesisMultiplier = 3.3  // Chatterbox is slower but higher quality
        }

        let estimatedSynthesisSeconds = estimatedAudioDuration * synthesisMultiplier + 5.0  // +5s overhead

        if estimatedSynthesisSeconds < 30 {
            return "~30 seconds"
        } else if estimatedSynthesisSeconds < 60 {
            return "~1 minute"
        } else if estimatedSynthesisSeconds < 120 {
            return "~2 minutes"
        } else if estimatedSynthesisSeconds < 300 {
            let minutes = Int(estimatedSynthesisSeconds / 60)
            return "~\(minutes) minutes"
        } else {
            let minutes = Int(estimatedSynthesisSeconds / 60)
            return "~\(minutes) min (long article)"
        }
    }

    // MARK: - Appearance Helpers

    /// Get the appropriate font based on user's fontType setting
    private func readerFont(size: CGFloat, isHeading: Bool = false) -> Font {
        if isHeading {
            return .title3.weight(.semibold)
        }

        switch fontType {
        case "Andika":
            return .custom("Andika", size: size)
        case "Barlow":
            return .custom("Barlow-Regular", size: size)
        case "Crimson Text":
            return .custom("CrimsonText-Regular", size: size)
        case "Open Dyslexic":
            return .custom("OpenDyslexic-Regular", size: size)
        case "Inter":
            return .custom("Inter-Regular", size: size)
        case "Tinos":
            return .custom("Tinos-Regular", size: size)
        case "Work Sans":
            return .custom("WorkSans-Regular", size: size)
        default:
            return .system(size: size)
        }
    }

    /// Get the highlight color based on user's highlightStyle setting
    private var highlightColor: Color {
        switch highlightStyle {
        case "Calm":
            return Color.blue
        case "Fresh":
            return Color.mint
        case "Natural":
            return Color.green
        case "Warm":
            return Color.orange
        case "Soothing":
            return Color.purple
        case "Neutral":
            return Color.gray
        default:
            return Color.yellow
        }
    }

    /// Get the preferred color scheme based on user's themeMode setting
    private var preferredColorScheme: ColorScheme? {
        switch themeMode {
        case "Light":
            return .light
        case "Dark":
            return .dark
        default:
            return nil // System default
        }
    }

    @ViewBuilder
    private func highlightedParagraph(text: String, index: Int) -> some View {
        // Highlight when this article is loaded (playing or paused)
        let isHighlighted = isCurrentArticle && currentHighlightIndex == index
        let isFirstParagraph = index == 0

        // Detect if this looks like a heading (short text, no period at end)
        let looksLikeHeading = text.count < 100 && !text.hasSuffix(".") && !text.contains("\n")

        let paragraphFont = readerFont(size: fontSize, isHeading: looksLikeHeading && isFirstParagraph)

        if isHighlighted {
            if highlightWordOnly {
                // Word-only mode: show underline indicator on paragraph + subtle border
                Text(text)
                    .font(paragraphFont)
                    .lineSpacing(lineSpacing)
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(highlightColor.opacity(0.5), lineWidth: 2)
                    )
                    .overlay(alignment: .leading) {
                        // Accent bar on the left side
                        RoundedRectangle(cornerRadius: 2)
                            .fill(highlightColor)
                            .frame(width: 3)
                            .padding(.vertical, 4)
                    }
            } else {
                // Full paragraph highlight mode
                Text(text)
                    .font(paragraphFont)
                    .lineSpacing(lineSpacing)
                    .padding(8)
                    .background(highlightColor.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }
        } else {
            Text(text)
                .font(paragraphFont)
                .lineSpacing(lineSpacing)
                .foregroundColor(looksLikeHeading ? .primary : Color.primary.opacity(0.9))
        }
    }

    // MARK: - Bottom Player Bar

    private var playerBar: some View {
        VStack(spacing: 0) {
            // Interactive seek slider
            seekSlider
                .padding(.horizontal)
                .padding(.top, 8)

            // Time labels with player mode badge
            HStack {
                Text(currentTimeString)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()

                // Player mode badge (Preview / Full)
                if urlPlayer.currentArticleID == article.id && urlPlayer.playerMode.isActive {
                    playerModeBadge
                }

                Spacer()

                Text(totalTimeString)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            }
            .padding(.horizontal)
            .padding(.top, 4)

            // Controls
            HStack(spacing: 0) {
                // Speed button
                Button {
                    cycleSpeed()
                } label: {
                    Text(speedDisplayString)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .frame(width: 50)
                }

                Spacer()

                // Skip backward
                Button {
                    handleSkipBackward()
                } label: {
                    ZStack {
                        Image(systemName: "gobackward")
                            .font(.title2)
                        Text("10")
                            .font(.system(size: 10, weight: .semibold))
                            .offset(y: 1)
                    }
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                }

                // Play/Pause
                Button {
                    if isPlayDisabledByQuota && !isCurrentlyPlaying {
                        // Tapping disabled play button shows quota sheet
                        showingQuotaLimitSheet = true
                    } else {
                        handlePlayPause()
                    }
                } label: {
                    if isSynthesizing {
                        ProgressView()
                            .frame(width: 64, height: 64)
                    } else {
                        // Show pause when playing, play when paused/stopped
                        Image(systemName: isCurrentlyPlaying ? "pause.fill" : "play.fill")
                            .font(.system(size: 28))
                            .foregroundStyle(isPlayDisabledByQuota && !isCurrentlyPlaying ? .gray : .black)
                            .frame(width: 64, height: 64)
                            .background(isPlayDisabledByQuota && !isCurrentlyPlaying
                                ? Color.gray.opacity(0.3)
                                : Color(red: 1, green: 0.85, blue: 0.4)) // Yellow/gold button, gray when quota blocked
                            .clipShape(Circle())
                            .overlay(
                                // Show lock icon when quota blocked
                                Group {
                                    if isPlayDisabledByQuota && !isCurrentlyPlaying {
                                        Image(systemName: "lock.fill")
                                            .font(.caption)
                                            .foregroundStyle(.white)
                                            .padding(4)
                                            .background(Color.red)
                                            .clipShape(Circle())
                                            .offset(x: 20, y: -20)
                                    }
                                }
                            )
                    }
                }
                .disabled(isSynthesizing)
                .padding(.horizontal, 16)

                // Skip forward
                Button {
                    handleSkipForward()
                } label: {
                    ZStack {
                        Image(systemName: "goforward")
                            .font(.title2)
                        Text("10")
                            .font(.system(size: 10, weight: .semibold))
                            .offset(y: 1)
                    }
                    .foregroundStyle(.primary)
                    .frame(width: 44, height: 44)
                }

                Spacer()

                // Voice/Character avatar
                Button {
                    showingVoicePicker = true
                } label: {
                    VoiceAvatarView()
                        .frame(width: 44, height: 44)
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            // Quota exceeded banner (only shown when blocked)
            if isPlayDisabledByQuota {
                quotaExceededBanner
            }
        }
        .background(Color(.systemBackground))
    }

    // MARK: - Quota Exceeded Banner

    /// Small banner shown in player bar when quota is exceeded
    private var quotaExceededBanner: some View {
        Button {
            showingQuotaLimitSheet = true
        } label: {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .foregroundStyle(.orange)

                Text(quotaErrorState.playDisabledMessage ?? "Daily limit reached")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Spacer()

                Text("Upgrade")
                    .font(.caption.bold())
                    .foregroundStyle(.blue)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 8)
            .background(Color.orange.opacity(0.1))
        }
        .buttonStyle(.plain)
    }

    // MARK: - Player Mode Badge

    /// Badge showing Preview vs Full audio mode, or loading state
    private var playerModeBadge: some View {
        Group {
            if urlPlayer.isAwaitingFullAudio {
                // Show loading indicator when preview ended but full isn't ready
                HStack(spacing: 4) {
                    ProgressView()
                        .scaleEffect(0.6)
                    Text("Loading full audio...")
                        .font(.caption2.weight(.medium))
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    Capsule()
                        .fill(Color.blue.opacity(0.2))
                )
                .foregroundStyle(.blue)
            } else {
                HStack(spacing: 4) {
                    // Icon indicating mode
                    Image(systemName: urlPlayer.playerMode == .preview ? "waveform.badge.exclamationmark" : "waveform")
                        .font(.system(size: 10))

                    Text(urlPlayer.playerMode.displayName)
                        .font(.caption2.weight(.medium))
                }
                .padding(.horizontal, 6)
                .padding(.vertical, 2)
                .background(
                    Capsule()
                        .fill(urlPlayer.playerMode == .preview ? Color.orange.opacity(0.2) : Color.green.opacity(0.2))
                )
                .foregroundStyle(urlPlayer.playerMode == .preview ? .orange : .green)
            }
        }
    }

    // MARK: - Seek Slider

    /// Whether URL player is actively playing/paused for this article (DRY helper)
    private var isURLPlayerActiveForArticle: Bool {
        urlPlayer.currentArticleID == article.id && urlPlayer.state.isActive
    }

    /// Current TTS job info from TTSJobManager (single source of truth)
    private var currentJobInfo: TTSJobManager.JobInfo? {
        TTSJobManager.shared.getJobInfo(articleId: article.id)
    }

    /// Whether a TTS job is actively being tracked for this article
    private var hasActiveJob: Bool {
        TTSJobManager.shared.isTracking(articleId: article.id)
    }

    /// Whether seek is disabled (during active streaming or preview with restrictions)
    private var isSeekDisabled: Bool {
        // Disabled during streaming
        if streamingTTS.currentArticleID == article.id && streamingTTS.isStreaming {
            return true
        }
        return false
    }

    /// Whether seek slider should show restricted behavior (preview mode)
    private var isSeekRestricted: Bool {
        urlPlayer.currentArticleID == article.id && urlPlayer.isSeekRestricted
    }

    /// Current slider progress (handles URL player, streaming, and regular playback)
    private var sliderProgress: Double {
        // Check URL player first (new job-based playback)
        if isURLPlayerActiveForArticle {
            guard urlPlayer.duration > 0 else { return 0 }
            let progress = urlPlayer.currentTime / urlPlayer.duration
            return progress.isNaN || progress.isInfinite ? 0 : min(1, progress)
        }
        // During streaming, calculate progress from streaming service
        if streamingTTS.currentArticleID == article.id && (streamingTTS.isPlaying || streamingTTS.isStreaming) {
            let totalDuration = streamingTTS.isStreaming ? streamingTTS.estimatedDuration : streamingTTS.duration
            guard totalDuration > 0 else { return 0 }
            let progress = streamingTTS.currentTime / totalDuration
            return progress.isNaN || progress.isInfinite ? 0 : min(1, progress)
        }
        return playbackProgress
    }

    /// Maximum seekable progress in preview mode (0.0 - 1.0)
    private var maxSeekableProgress: Double {
        guard isSeekRestricted else { return 1.0 }
        let maxTime = urlPlayer.maxSeekableTime
        let totalDuration = urlPlayer.duration
        guard totalDuration > 0 else { return 1.0 }
        let result = maxTime / totalDuration
        // Guard against NaN/Inf from division
        guard result.isFinite else { return 1.0 }
        return min(1.0, result)
    }

    private var seekSlider: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                // Background track
                Capsule()
                    .fill(Color(.systemGray5))
                    .frame(height: 4)

                // Preview boundary indicator (shows unavailable area in preview mode)
                if isSeekRestricted && maxSeekableProgress < 1.0 {
                    // Unavailable area (striped/dimmed)
                    Capsule()
                        .fill(Color.orange.opacity(0.2))
                        .frame(width: geometry.size.width * (1.0 - maxSeekableProgress), height: 4)
                        .offset(x: geometry.size.width * maxSeekableProgress)
                }

                // Progress fill
                Capsule()
                    .fill(Color(red: 1, green: 0.85, blue: 0.4)) // Yellow/gold color
                    .frame(width: geometry.size.width * (isSeeking ? seekPosition : sliderProgress), height: 4)

                // Preview boundary marker
                if isSeekRestricted && maxSeekableProgress < 1.0 {
                    Rectangle()
                        .fill(Color.orange)
                        .frame(width: 2, height: 8)
                        .offset(x: geometry.size.width * maxSeekableProgress - 1)
                }

                // Thumb (draggable circle)
                Circle()
                    .fill(isSeekDisabled ? Color(.systemGray3) : Color(red: 1, green: 0.85, blue: 0.4))
                    .frame(width: 14, height: 14)
                    .offset(x: (geometry.size.width - 14) * (isSeeking ? seekPosition : sliderProgress))
                    .shadow(color: .black.opacity(0.2), radius: 2, y: 1)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        guard !isSeekDisabled else { return }
                        isSeeking = true
                        var newPosition = max(0, min(1, value.location.x / geometry.size.width))
                        // Clamp to max seekable in preview mode
                        if isSeekRestricted {
                            newPosition = min(newPosition, maxSeekableProgress)
                        }
                        seekPosition = newPosition
                    }
                    .onEnded { value in
                        guard !isSeekDisabled else { return }
                        var newPosition = max(0, min(1, value.location.x / geometry.size.width))
                        // Clamp to max seekable in preview mode
                        if isSeekRestricted {
                            newPosition = min(newPosition, maxSeekableProgress)
                        }

                        // Use appropriate player for seeking (guard against zero duration)
                        if urlPlayer.currentArticleID == article.id && urlPlayer.state.isActive {
                            let duration = urlPlayer.duration
                            guard duration > 0 else {
                                isSeeking = false
                                return
                            }
                            let newTime = newPosition * duration
                            urlPlayer.seek(to: newTime)
                        } else {
                            let duration = playbackService.progress.duration
                            guard duration > 0 else {
                                isSeeking = false
                                return
                            }
                            let newTime = newPosition * duration
                            playbackService.seek(to: newTime)
                        }
                        isSeeking = false
                    }
            )
            .allowsHitTesting(!isSeekDisabled)
        }
        .frame(height: 14)
    }

    // MARK: - Computed Properties

    /// Returns true if this article is the current playback item (regardless of playing/paused state)
    private var isCurrentArticle: Bool {
        // Check URL player first (new job-based playback)
        if urlPlayer.currentArticleID == article.id && urlPlayer.state.isActive {
            return true
        }
        // Check streaming TTS (legacy)
        if streamingTTS.currentArticleID == article.id && (streamingTTS.isPlaying || streamingTTS.isStreaming) {
            return true
        }
        // Check standard playback service
        return playbackService.currentItem?.articleID == article.id
    }

    /// Returns true if this article is actively playing audio (not paused)
    private var isCurrentlyPlaying: Bool {
        // Check URL player first (new job-based playback)
        if urlPlayer.currentArticleID == article.id && urlPlayer.isPlaying {
            return true
        }
        // Check streaming TTS (legacy)
        if streamingTTS.currentArticleID == article.id && streamingTTS.isPlaying {
            return true
        }
        // Check standard playback service
        return isCurrentArticle && playbackService.state.isPlaying
    }

    /// Returns true if this article is loaded but paused
    private var isCurrentlyPaused: Bool {
        // Check URL player first (new job-based playback)
        if urlPlayer.currentArticleID == article.id && !urlPlayer.isPlaying && urlPlayer.state.isActive {
            return true
        }
        // Check streaming TTS - if streaming for this article but not playing, it's paused (legacy)
        if streamingTTS.currentArticleID == article.id && !streamingTTS.isPlaying && streamingTTS.isStreaming {
            return true
        }
        // Check standard playback service
        return isCurrentArticle && playbackService.state.isPaused
    }

    private var playbackProgress: Double {
        guard isCurrentArticle else { return 0 }
        let progress = playbackService.progress.progress
        return progress.isNaN || progress.isInfinite ? 0 : progress
    }

    private var currentHighlightIndex: Int? {
        // Check URL player first (new job-based playback)
        if urlPlayer.currentArticleID == article.id && urlPlayer.state.isActive {
            // In preview mode, only highlight the first paragraph since preview
            // audio only covers the beginning of the article (~150 chars)
            if urlPlayer.playerMode == .preview {
                return 0  // Always highlight first paragraph during preview
            }

            return calculateHighlightIndex(
                currentTime: urlPlayer.currentTime,
                totalDuration: urlPlayer.duration
            )
        }

        // Check streaming TTS (legacy)
        if streamingTTS.currentArticleID == article.id && (streamingTTS.isPlaying || streamingTTS.isStreaming) {
            // Use estimatedDuration for highlighting during streaming (more stable)
            // Once streaming completes, duration will have the actual total
            let totalDuration = streamingTTS.isStreaming ? streamingTTS.estimatedDuration : streamingTTS.duration
            return calculateHighlightIndex(
                currentTime: streamingTTS.currentTime,
                totalDuration: totalDuration > 0 ? totalDuration : streamingTTS.duration
            )
        }

        // Fall back to standard playback service
        guard isCurrentArticle else { return nil }

        return calculateHighlightIndex(
            currentTime: playbackService.progress.currentTime,
            totalDuration: playbackService.progress.duration
        )
    }

    /// Calculate which paragraph should be highlighted based on playback progress
    private func calculateHighlightIndex(currentTime: TimeInterval, totalDuration: TimeInterval) -> Int? {
        guard totalDuration > 0 else { return nil }

        // Calculate which paragraph should be highlighted based on progress
        // Weight by character count so longer paragraphs get proportionally more time
        let paragraphs = article.rawText.components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        guard !paragraphs.isEmpty else { return nil }

        let totalCharacters = paragraphs.reduce(0) { $0 + $1.count }
        guard totalCharacters > 0 else { return nil }

        let progressRatio = currentTime / totalDuration

        // Find which paragraph we're in based on character-weighted timing
        var cumulativeRatio: Double = 0
        for (index, paragraph) in paragraphs.enumerated() {
            let paragraphRatio = Double(paragraph.count) / Double(totalCharacters)
            cumulativeRatio += paragraphRatio

            if progressRatio < cumulativeRatio {
                return index
            }
        }

        return paragraphs.count - 1
    }

    private var currentTimeString: String {
        // Check URL player first (new job-based playback)
        if urlPlayer.currentArticleID == article.id && urlPlayer.state.isActive {
            return urlPlayer.currentTime.formattedDuration
        }
        // Check streaming TTS (legacy)
        if streamingTTS.currentArticleID == article.id && (streamingTTS.isPlaying || streamingTTS.isStreaming) {
            return streamingTTS.currentTime.formattedDuration
        }
        guard isCurrentArticle else { return "0:00" }
        return playbackService.progress.currentTime.formattedDuration
    }

    private var totalTimeString: String {
        // Check URL player first (new job-based playback)
        if urlPlayer.currentArticleID == article.id && urlPlayer.duration > 0 {
            return urlPlayer.duration.formattedDuration
        }
        // Check streaming TTS (legacy)
        if streamingTTS.currentArticleID == article.id && streamingTTS.duration > 0 {
            return streamingTTS.duration.formattedDuration
        }
        guard isCurrentArticle else {
            return article.estimatedDuration.formattedDuration
        }
        return playbackService.progress.duration.formattedDuration
    }

    private var speedDisplayString: String {
        guard isCurrentArticle else { return "1.0x" }
        return playbackService.playbackSpeed.displayName
    }

    // MARK: - Actions

    private func handlePlayPause() {
        // Check if URL player is actively playing or paused for this article
        // Only toggle if there's actual audio loaded (not just article ID set from prewarm)
        if isURLPlayerActiveForArticle {
            urlPlayer.togglePlayPause()
            return
        }

        // Check if streaming is active for this article (legacy)
        if streamingTTS.currentArticleID == article.id {
            if streamingTTS.isPlaying {
                streamingTTS.pause()
            } else {
                streamingTTS.resume()
            }
            return
        }

        if isCurrentArticle {
            // This article is loaded - toggle play/pause
            playbackService.togglePlayPause()
        } else {
            // Need to load and play this article
            startPlayback()
        }
    }

    private func handleSkipBackward() {
        // Check if URL player is active for this article (new job-based playback)
        if isURLPlayerActiveForArticle {
            urlPlayer.seek(by: -10)
            return
        }

        // Fall back to standard playback service (streaming TTS doesn't support seeking)
        playbackService.skipBackward()
    }

    private func handleSkipForward() {
        // Check if URL player is active for this article (new job-based playback)
        if isURLPlayerActiveForArticle {
            urlPlayer.seek(by: 10)
            return
        }

        // Fall back to standard playback service (streaming TTS doesn't support seeking)
        playbackService.skipForward()
    }

    /// Check if pre-synthesis completed and auto-play if waiting
    private func checkAndAutoPlayIfSynthesisComplete() {
        let latest = currentArticle
        guard latest.synthesisStatus.isComplete else { return }
        guard isSynthesizing else { return }
        guard !playbackService.state.isPlaying else { return }

        isSynthesizing = false
        if let audioURL = latest.audioFileURL,
           let validURL = AudioCacheManager.shared.findAudioFile(at: audioURL) {
            print("[ArticleReader] Pre-synthesis completed, starting playback")
            playAudio(url: validURL)
        }
    }

    private func startPlayback() {
        // Use currentArticle to get latest synthesis status from ArticleStore
        let latestArticle = currentArticle
        let status = latestArticle.synthesisStatus

        switch status {
        case .completed:
            // Audio already synthesized - check multiple cache locations
            // First check stored audioFileURL
            if let audioURL = latestArticle.audioFileURL,
               let validURL = AudioCacheManager.shared.findAudioFile(at: audioURL) {
                // Update stored URL if it was found with different extension
                if validURL != audioURL {
                    ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .completed, audioURL: validURL)
                }
                print("[ArticleReader] Playing pre-synthesized audio: \(validURL.lastPathComponent)")
                playAudio(url: validURL)
                return
            }

            // Check streaming TTS cache
            if let cachedStreamURL = streamingTTS.getSavedAudioURL(for: article.id) {
                print("[ArticleReader] Playing cached streaming audio: \(cachedStreamURL.lastPathComponent)")
                // Update the article's audioFileURL to the cached location
                ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .completed, audioURL: cachedStreamURL)
                playAudio(url: cachedStreamURL)
                return
            }

            // File missing locally - try to download from cloud storage
            print("[ArticleReader] Cached audio file missing, trying cloud download...")
            downloadFromCloudOrResynthesize()

        case .inProgress, .queued:
            // Pre-synthesis is already running in background
            print("[ArticleReader] Synthesis already in progress (status: \(status.displayText))")
            isSynthesizing = true

            // Check if TTSJobManager is tracking this article - UI reads from computed properties
            if TTSJobManager.shared.isTracking(articleId: article.id),
               let jobInfo = TTSJobManager.shared.getJobInfo(articleId: article.id) {
                print("[ArticleReader] TTSJobManager tracking job \(jobInfo.jobId), UI observes via computed properties")
                // Don't stop TTSJobManager - let it continue background polling
                // UI reads ttsJobId/ttsJobStatus via computed properties from TTSJobManager
                return
            }

            // Check ArticleStore for pending job ID (from prewarm)
            if let pendingJobId = latestArticle.pendingTTSJobId,
               let pendingVoiceId = latestArticle.pendingTTSVoiceId {
                // Check if the pending job is for the same voice (compare Kokoro IDs since prewarm uses them)
                let currentVoiceId = voicePresetManager.selectedPreset.kokoroVoiceID ?? voicePresetManager.selectedPreset.providerVoiceID
                if pendingVoiceId == currentVoiceId {
                    print("[ArticleReader] Found pending job \(pendingJobId) from prewarm, resuming polling")
                    // Start TTSJobManager tracking if not already (UI reads via computed properties)
                    if !TTSJobManager.shared.isTracking(articleId: article.id) {
                        TTSJobManager.shared.trackJob(
                            articleId: article.id,
                            jobId: pendingJobId,
                            voiceId: pendingVoiceId,
                            initialStatus: .processing
                        )
                    }
                    return
                } else {
                    // Voice changed - need new synthesis
                    print("[ArticleReader] Voice changed from prewarm (\(pendingVoiceId)) to (\(currentVoiceId)), starting new synthesis")
                    synthesizeAndPlay()
                    return
                }
            }

            // Fallback: ArticleStore says in progress but no job ID found - wait for updates

        case .failed:
            // Previous synthesis failed - retry with streaming
            print("[ArticleReader] Previous synthesis failed, retrying with streaming...")
            synthesizeAndPlay()

        case .notStarted, .cancelled:
            // Check if we have cached streaming audio before synthesizing
            if let cachedStreamURL = streamingTTS.getSavedAudioURL(for: article.id) {
                print("[ArticleReader] Found cached streaming audio: \(cachedStreamURL.lastPathComponent)")
                ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .completed, audioURL: cachedStreamURL)
                playAudio(url: cachedStreamURL)
                return
            }
            // Need to start synthesis
            print("[ArticleReader] Starting synthesis...")
            synthesizeAndPlay()
        }
    }

    private func downloadFromCloudOrResynthesize() {
        isSynthesizing = true
        synthesisError = nil

        Task {
            do {
                // Try to download from cloud storage first
                if let cloudService = TTSServiceFactory.listenAICloudService {
                    if let cloudURL = try await cloudService.downloadAudio(articleId: article.id.uuidString) {
                        print("[ArticleReader] Downloaded audio from cloud storage")
                        ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .completed, audioURL: cloudURL)
                        isSynthesizing = false
                        playAudio(url: cloudURL)
                        return
                    }
                }

                // Cloud download failed or not available, re-synthesize
                print("[ArticleReader] Cloud download unavailable, re-synthesizing...")
                isSynthesizing = false
                synthesizeAndPlay()
            } catch {
                print("[ArticleReader] Cloud download failed: \(error), falling back to synthesis")
                isSynthesizing = false
                synthesizeAndPlay()
            }
        }
    }

    private func playAudio(url: URL) {
        // Use the new URL-based player for simpler, more reliable playback
        Task {
            do {
                // Stop any streaming playback first
                streamingTTS.stopStreaming()

                let articleToMark = article
                try await urlPlayer.play(
                    url: url,
                    articleID: article.id,
                    title: article.displayTitle,
                    artist: article.author ?? article.siteName,
                    startPosition: nil,
                    mode: .full,  // Cached audio is always full
                    previewDuration: nil,
                    onComplete: {
                        // Mark as completed when playback finishes
                        Task { @MainActor in
                            ArticleStore.shared.markAsFinished(articleToMark)
                        }
                    }
                )

                // Apply the user's preferred playback speed
                urlPlayer.setRate(playbackService.playbackSpeed.rate)
            } catch {
                synthesisError = error.localizedDescription
            }
        }
    }

    /// Legacy method using AudioPlaybackService (kept for compatibility)
    private func playAudioLegacy(url: URL) {
        // Create NowPlayingItem for the playback service
        let nowPlayingItem = NowPlayingItem(
            id: UUID(),
            articleID: article.id,
            title: article.displayTitle,
            author: article.author,
            siteName: article.siteName,
            audioURL: url,
            duration: article.estimatedDuration,
            artworkURL: article.heroImageURL,
            artworkColor: article.sourceType.accentColor
        )

        Task {
            do {
                try await playbackService.play(item: nowPlayingItem, from: nil)
            } catch {
                synthesisError = error.localizedDescription
            }
        }
    }

    private func synthesizeAndPlay() {
        let currentVoice = voicePresetManager.selectedPreset

        // Offline AI: when the toggle is on and the device is eligible, route
        // through TTSCoordinator (which applies the Kokoro overlay) instead of
        // the cloud job API. The legacy path calls TTSCoordinator.synthesize
        // and plays the resulting URL — exactly what we need.
        if voicePresetManager.isOfflineAIActive,
           let kokoroID = currentVoice.kokoroVoiceID, !kokoroID.isEmpty {
            print("[ArticleReader] Offline AI active — routing synthesis on-device (voice: \(kokoroID))")
            performLegacySynthesis()
            return
        }

        // For on-device Apple voices, use the legacy synthesis path
        if currentVoice.provider == .apple {
            print("[ArticleReader] Using on-device synthesis for Apple voice")
            performLegacySynthesis()
            return
        }

        // For cloud voices, use the job-based API
        requestTTSJob()
    }

    /// Request TTS using the job-based API (POST /api/tts)
    /// - If response is status=ready with audioUrl -> play immediately
    /// - If response is status=processing with jobId -> set UI to "Generating..." and store jobId
    private func requestTTSJob() {
        guard let cloudService = TTSServiceFactory.listenAICloudService else {
            print("[ArticleReader] Cloud service not available, falling back to legacy synthesis")
            performLegacySynthesis()
            return
        }

        let currentVoice = voicePresetManager.selectedPreset

        // Check if this is a cloned voice - route to direct synthesis instead of job API
        let isClonedVoice = !currentVoice.isBuiltIn &&
                           currentVoice.category == .custom &&
                           currentVoice.kokoroVoiceID == nil

        if isClonedVoice {
            print("[ArticleReader] Cloned voice detected, using direct synthesis")
            requestClonedVoiceSynthesis(cloudService: cloudService, voice: currentVoice)
            return
        }

        // Reset job state and start synthesis
        ttsJobManager.stopTracking(articleId: article.id)
        ttsJobEstimatedWaitSec = nil
        isSynthesizing = true
        synthesisError = nil
        synthesisStartTime = Date()

        // Stop any currently playing audio
        if playbackService.state.isPlaying {
            playbackService.pause()
        }
        if urlPlayer.state.isActive {
            urlPlayer.stop()
        }
        streamingTTS.stopStreaming()

        // Update article status
        ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .inProgress(progress: 0))

        Task {
            do {
                // Use provider from settings (standard=Kokoro/selfhosted, premium=ElevenLabs)
                let provider = ttsProvider

                // Select voice ID based on provider:
                // - For selfhosted (Kokoro): use kokoroVoiceID
                // - For elevenlabs: use the ElevenLabs providerVoiceID
                let voiceIdForJob: String
                if provider == .elevenlabs {
                    voiceIdForJob = currentVoice.providerVoiceID
                } else {
                    voiceIdForJob = currentVoice.kokoroVoiceID ?? currentVoice.providerVoiceID
                }

                print("[ArticleReader] Requesting TTS job for \(article.rawText.count) chars, voice: \(voiceIdForJob), provider: \(provider.rawValue)")

                // Call POST /api/tts
                let response = try await cloudService.requestTTS(
                    text: article.rawText,
                    voiceId: voiceIdForJob,
                    provider: provider,
                    speed: Double(playbackService.playbackSpeed.rate)
                )

                // Persist job ID for this article+voice combo (for resume after app restart)
                persistJobId(response.jobId, for: article.id, voiceId: voiceIdForJob)

                print("[ArticleReader] TTS job response: status=\(response.status.rawValue), jobId=\(response.jobId)")

                switch response.status {
                case .ready:
                    // Audio is immediately available (cache hit) - play it without polling UI flash
                    if let audioUrlString = response.audioUrl, let audioUrl = URL(string: audioUrlString) {
                        print("[ArticleReader] Audio ready immediately (cache hit), playing from: \(audioUrlString)")

                        isSynthesizing = false

                        // Record usage
                        UsageTrackerService.shared.recordUsage(
                            characterCount: article.rawText.count,
                            provider: currentVoice.provider,
                            voiceID: currentVoice.providerVoiceID,
                            articleID: article.id,
                            articleTitle: article.displayTitle,
                            wasSuccessful: true
                        )

                        // Update article status
                        ArticleStore.shared.updateSynthesisStatus(
                            for: article.id,
                            status: .completed,
                            audioURL: audioUrl
                        )

                        // Persist the full audio URL for instant replay when returning to article
                        persistFullAudioUrl(audioUrlString, for: article.id, voiceId: currentVoice.providerVoiceID)

                        // Report latency
                        let latencyMs = synthesisStartTime.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
                        Task {
                            await cloudService.reportLatency(
                                textLength: article.rawText.count,
                                latencyMs: latencyMs,
                                provider: provider,
                                voiceId: currentVoice.providerVoiceID
                            )
                        }

                        // Play the audio with full mode
                        playAudioWithMode(url: audioUrl, mode: .full)
                    } else {
                        throw TTSJobError.unknown(message: "Status is ready but no audio URL provided")
                    }

                case .queued, .processing, .partialReady:
                    // Job is still processing - start tracking with TTSJobManager
                    print("[ArticleReader] TTS job is processing (status: \(response.status.rawValue)), starting tracking")

                    // Update estimated wait time
                    if let waitTime = response.estimatedWaitSec {
                        ttsJobEstimatedWaitSec = waitTime
                    }

                    // Persist job status for resume
                    persistJobStatus(response.status, for: article.id, voiceId: currentVoice.providerVoiceID)

                    // Start TTSJobManager tracking (handles polling and callbacks)
                    ttsJobManager.trackJob(
                        articleId: article.id,
                        jobId: response.jobId,
                        voiceId: voiceIdForJob,
                        initialStatus: response.status
                    )

                    // Start timer to show "Notify when ready" option after 5 seconds
                    showNotifyWhenReadyOption = false
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 5_000_000_000)
                        if self.isSynthesizing {
                            self.showNotifyWhenReadyOption = true
                        }
                    }

                case .failed:
                    throw TTSJobError.jobFailed(jobId: response.jobId, reason: "Job failed during request")

                case .cancelled:
                    throw TTSJobError.jobCancelled(jobId: response.jobId)
                }

            } catch let error as TTSJobError {
                handleTTSJobError(error)
            } catch {
                handleTTSJobError(TTSJobError.unknown(message: error.localizedDescription))
            }
        }
    }

    /// Handle errors from job-based TTS API
    private func handleTTSJobError(_ error: TTSJobError) {
        isSynthesizing = false
        // Stop any TTSJobManager tracking (clears job state)
        ttsJobManager.stopTracking(articleId: article.id)

        let currentVoice = voicePresetManager.selectedPreset

        // Record failed usage (only for non-quota errors, quota errors didn't consume anything)
        if !error.isQuotaError {
            UsageTrackerService.shared.recordUsage(
                characterCount: article.rawText.count,
                provider: currentVoice.provider,
                voiceID: currentVoice.providerVoiceID,
                articleID: article.id,
                articleTitle: article.displayTitle,
                wasSuccessful: false,
                errorMessage: error.localizedDescription
            )
        }

        // For quota/payment/rate limit errors: show paywall with upgrade + on-device options
        if error.isQuotaError || error.isRetryable {
            if case .rateLimited = error {
                // For rate limiting, just show a brief message and continue
                print("[ArticleReader] Rate limited: \(error.localizedDescription)")
            }
            print("[ArticleReader] Showing paywall for: \(error.localizedDescription)")
            quotaLimitError = error
            showingQuotaLimitSheet = true
            quotaErrorState.handleQuotaError(error)
            return
        }

        synthesisError = error.localizedDescription
        ArticleStore.shared.updateSynthesisStatus(
            for: article.id,
            status: .failed(message: error.localizedDescription)
        )

        print("[ArticleReader] TTS job error: \(error.localizedDescription)")
    }

    /// Persist job ID for later resume (e.g., when user navigates away and comes back)
    private func persistJobId(_ jobId: String, for articleId: UUID, voiceId: String) {
        let key = "ttsJob_\(articleId.uuidString)_\(voiceId)"
        UserDefaults.standard.set(jobId, forKey: key)
        print("[ArticleReader] Persisted job ID: \(jobId) for key: \(key)")
    }

    /// Retrieve persisted job ID for an article+voice combo
    private func retrievePersistedJobId(for articleId: UUID, voiceId: String) -> String? {
        let key = "ttsJob_\(articleId.uuidString)_\(voiceId)"
        return UserDefaults.standard.string(forKey: key)
    }

    /// Clear persisted job ID (when job completes or fails)
    private func clearPersistedJobId(for articleId: UUID, voiceId: String) {
        let key = "ttsJob_\(articleId.uuidString)_\(voiceId)"
        UserDefaults.standard.removeObject(forKey: key)
        print("[ArticleReader] Cleared persisted job ID for key: \(key)")
    }

    /// Persist job status for resume after navigation
    private func persistJobStatus(_ status: TTSJobStatus, for articleId: UUID, voiceId: String) {
        let key = "ttsJobStatus_\(articleId.uuidString)_\(voiceId)"
        UserDefaults.standard.set(status.rawValue, forKey: key)
    }

    /// Retrieve persisted job status
    private func retrievePersistedJobStatus(for articleId: UUID, voiceId: String) -> TTSJobStatus? {
        let key = "ttsJobStatus_\(articleId.uuidString)_\(voiceId)"
        guard let rawValue = UserDefaults.standard.string(forKey: key) else { return nil }
        return TTSJobStatus(rawValue: rawValue)
    }

    /// Clear persisted job status
    private func clearPersistedJobStatus(for articleId: UUID, voiceId: String) {
        let key = "ttsJobStatus_\(articleId.uuidString)_\(voiceId)"
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// Persist the full audio URL for an article+voice combo (for instant replay on return)
    private func persistFullAudioUrl(_ urlString: String, for articleId: UUID, voiceId: String) {
        let key = "ttsFullAudioUrl_\(articleId.uuidString)_\(voiceId)"
        UserDefaults.standard.set(urlString, forKey: key)
        print("[ArticleReader] Persisted full audio URL for key: \(key)")
    }

    /// Retrieve persisted full audio URL
    private func retrievePersistedFullAudioUrl(for articleId: UUID, voiceId: String) -> String? {
        let key = "ttsFullAudioUrl_\(articleId.uuidString)_\(voiceId)"
        return UserDefaults.standard.string(forKey: key)
    }

    /// Clear persisted full audio URL
    private func clearPersistedFullAudioUrl(for articleId: UUID, voiceId: String) {
        let key = "ttsFullAudioUrl_\(articleId.uuidString)_\(voiceId)"
        UserDefaults.standard.removeObject(forKey: key)
    }

    /// Clear all persisted job data for an article+voice combo
    private func clearAllPersistedJobData(for articleId: UUID, voiceId: String) {
        clearPersistedJobId(for: articleId, voiceId: voiceId)
        clearPersistedJobStatus(for: articleId, voiceId: voiceId)
        // Note: We keep the full audio URL persisted for instant replay
    }

    // MARK: - Job Polling

    /// Check for a persisted job and resume polling if needed.
    /// Also checks for persisted full audio URL for instant replay.
    private func checkAndResumePersistedJob() {
        let currentVoice = voicePresetManager.selectedPreset
        // Use Kokoro ID for voice matching since job API uses Kokoro voices
        let voiceId = currentVoice.kokoroVoiceID ?? currentVoice.providerVoiceID

        // First, check if TTSJobManager has completed audio for this article
        if let jobInfo = TTSJobManager.shared.getJobInfo(articleId: article.id),
           let localPath = jobInfo.localAudioPath,
           jobInfo.status == .ready {
            print("[ArticleReader] TTSJobManager has ready audio at: \(localPath.lastPathComponent)")
            // Audio was downloaded in background - ready for playback
            TTSJobManager.shared.stopTracking(articleId: article.id)
            return
        }

        // Check if TTSJobManager is still tracking this article
        if TTSJobManager.shared.isTracking(articleId: article.id),
           let jobInfo = TTSJobManager.shared.getJobInfo(articleId: article.id) {
            print("[ArticleReader] TTSJobManager is tracking job \(jobInfo.jobId), UI reads via computed properties")
            // TTSJobManager handles polling; UI reads state via computed properties
            isSynthesizing = true

            // Set estimated time string for cloned voices
            if jobInfo.progress > 0 {
                let currentVoice = voicePresetManager.selectedPreset
                let isClonedVoice = !currentVoice.isBuiltIn && currentVoice.category == .custom && currentVoice.kokoroVoiceID == nil

                if isClonedVoice {
                    let cloningModel = VoicePresetManager.shared.voiceCloningModel
                    estimatedTimeString = estimatedClonedVoiceSynthesisTime(
                        characterCount: article.rawText.count,
                        model: cloningModel
                    )
                }
            }
            // TTSJobManager continues background polling; UI observes via computed properties
            return
        }

        // Check ArticleStore for pending job from prewarm (stored when ImportCoordinator kicks off synthesis)
        let currentArticle = ArticleStore.shared.article(withID: article.id) ?? article
        if let pendingJobId = currentArticle.pendingTTSJobId,
           let pendingVoiceId = currentArticle.pendingTTSVoiceId,
           pendingVoiceId == voiceId {
            print("[ArticleReader] Found pending job \(pendingJobId) from ArticleStore, resuming tracking")
            // Start TTSJobManager tracking for this job (handles polling; UI reads via computed properties)
            TTSJobManager.shared.trackJob(
                articleId: article.id,
                jobId: pendingJobId,
                voiceId: pendingVoiceId,
                initialStatus: .processing
            )
            isSynthesizing = true

            // Set estimated time string for cloned voices
            let isClonedVoice = !currentVoice.isBuiltIn && currentVoice.category == .custom && currentVoice.kokoroVoiceID == nil
            if isClonedVoice {
                let cloningModel = VoicePresetManager.shared.voiceCloningModel
                estimatedTimeString = estimatedClonedVoiceSynthesisTime(
                    characterCount: article.rawText.count,
                    model: cloningModel
                )
            }
            // TTSJobManager handles polling; UI observes via computed properties
            return
        }

        // Check if we have a persisted full audio URL for this voice - use it instantly
        if let savedFullUrlString = retrievePersistedFullAudioUrl(for: article.id, voiceId: voiceId),
           let savedUrl = URL(string: savedFullUrlString) {
            print("[ArticleReader] Found persisted full audio URL for current voice, updating ArticleStore: \(savedFullUrlString)")
            // Update ArticleStore so startPlayback() will find this URL
            ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .completed, audioURL: savedUrl)
            return
        }

        // Check if there's a persisted job for this article+voice
        guard let jobId = retrievePersistedJobId(for: article.id, voiceId: voiceId) else {
            return
        }

        // Check if we have a persisted status
        let persistedStatus = retrievePersistedJobStatus(for: article.id, voiceId: voiceId)

        // Only resume polling if job was in progress
        guard persistedStatus?.isInProgress == true else {
            // Job completed or failed - clean up
            if persistedStatus == .ready || persistedStatus == .failed || persistedStatus == .cancelled {
                clearAllPersistedJobData(for: article.id, voiceId: voiceId)
            }
            return
        }

        print("[ArticleReader] Found persisted job: \(jobId), verifying it still exists...")

        // Verify job still exists before showing "synthesizing" UI
        // If job expired, we'll re-request (which will check cache)
        Task { @MainActor in
            guard let cloudService = TTSServiceFactory.listenAICloudService else {
                print("[ArticleReader] Cloud service not available, cannot verify job")
                return
            }

            do {
                // Try to fetch job status
                let statusResponse = try await cloudService.fetchJobStatus(jobId: jobId)

                // Job exists - check its status
                if statusResponse.status.isInProgress {
                    // Job still in progress - resume with TTSJobManager
                    print("[ArticleReader] Job still in progress, starting TTSJobManager tracking")
                    TTSJobManager.shared.trackJob(
                        articleId: article.id,
                        jobId: jobId,
                        voiceId: voiceId,
                        initialStatus: statusResponse.status
                    )
                    isSynthesizing = true
                } else if statusResponse.status == .ready {
                    // Job already completed - use the audio URL
                    print("[ArticleReader] Job already completed, using cached audio")
                    if let audioUrl = statusResponse.bestAudioUrl {
                        persistFullAudioUrl(audioUrl, for: article.id, voiceId: voiceId)
                    }
                    clearPersistedJobId(for: article.id, voiceId: voiceId)
                    clearPersistedJobStatus(for: article.id, voiceId: voiceId)
                } else {
                    // Job failed or cancelled - clean up
                    print("[ArticleReader] Job failed/cancelled, cleaning up")
                    clearAllPersistedJobData(for: article.id, voiceId: voiceId)
                }
            } catch let error as TTSJobError {
                if case .jobNotFound = error {
                    // Job expired/not found - auto-request TTS to check cache and resume generation
                    print("[ArticleReader] Persisted job not found (expired?), auto-requesting TTS to check cache")
                    clearAllPersistedJobData(for: article.id, voiceId: voiceId)

                    // Auto-request TTS - this will:
                    // 1. Check backend cache - if hit, play immediately
                    // 2. If no cache, start new generation with new tracking ID
                    requestTTSJob()
                } else {
                    print("[ArticleReader] Error verifying job: \(error)")
                    // Network error or other issue - try TTSJobManager tracking anyway
                    TTSJobManager.shared.trackJob(
                        articleId: article.id,
                        jobId: jobId,
                        voiceId: voiceId,
                        initialStatus: persistedStatus ?? .processing
                    )
                    isSynthesizing = true
                }
            } catch {
                print("[ArticleReader] Error verifying job: \(error)")
                // Network error - try TTSJobManager tracking, it will handle errors
                TTSJobManager.shared.trackJob(
                    articleId: article.id,
                    jobId: jobId,
                    voiceId: voiceId,
                    initialStatus: persistedStatus ?? .processing
                )
                isSynthesizing = true
            }
        }
    }

    /// Start polling for job status
    private func startPollingJobStatus(jobId: String) {
        // Cancel any existing polling
        cancelPolling()

        print("[ArticleReader] Starting polling for job: \(jobId)")

        pollingTask = Task { @MainActor in
            let pollingInterval: UInt64 = 1_000_000_000 // 1 second in nanoseconds

            while !Task.isCancelled {
                do {
                    // Wait before next poll (except first time)
                    try await Task.sleep(nanoseconds: pollingInterval)

                    // Check if cancelled
                    if Task.isCancelled { break }

                    // Fetch job status
                    guard let cloudService = TTSServiceFactory.listenAICloudService else {
                        print("[ArticleReader] Cloud service not available, stopping polling")
                        break
                    }

                    let statusResponse = try await cloudService.fetchJobStatus(jobId: jobId)

                    // Update UI
                    handleJobStatusUpdate(statusResponse)

                    // Stop polling if job is complete or failed
                    if !statusResponse.status.isInProgress {
                        print("[ArticleReader] Job completed with status: \(statusResponse.status.rawValue), stopping polling")
                        break
                    }

                } catch is CancellationError {
                    print("[ArticleReader] Polling cancelled")
                    break
                } catch let error as TTSJobError {
                    // Special handling for job not found - the job may have expired/completed
                    // while the app was closed. Re-request TTS which will check the cache.
                    if case .jobNotFound = error {
                        print("[ArticleReader] Job not found (expired?), re-requesting TTS to check cache")
                        clearAllPersistedJobData(for: article.id, voiceId: voicePresetManager.selectedPreset.providerVoiceID)
                        isSynthesizing = false
                        ttsJobManager.stopTracking(articleId: article.id)  // Clear job state
                        // Re-request TTS - this will hit cache if the audio was already generated
                        requestTTSJob()
                        break
                    }
                    handleTTSJobError(error)
                    break
                } catch {
                    print("[ArticleReader] Polling error: \(error)")
                    // Continue polling on transient errors
                    continue
                }
            }
        }
    }

    /// Handle job status update from polling (deprecated - use TTSJobManager callbacks)
    private func handleJobStatusUpdate(_ response: TTSJobStatusResponse) {
        let currentVoice = voicePresetManager.selectedPreset

        // Note: ttsJobStatus, ttsJobProgressSec, etc. are now computed properties from TTSJobManager
        // This function is only used for legacy local polling (cloned voice path)

        // Update estimated wait time (only non-computed property)
        if let estimatedWait = response.estimatedWaitSec {
            ttsJobEstimatedWaitSec = estimatedWait
        }

        // Start/update progress interpolation for smooth animation
        updateProgressInterpolation(
            currentProgressSec: response.progress.progressSec,
            totalDurationSec: response.progress.durationSec ?? estimatedAudioDurationForArticle,
            estimatedRemainingSec: response.progress.estimatedRemainingSec
        )

        // Persist updated status
        persistJobStatus(response.status, for: article.id, voiceId: currentVoice.providerVoiceID)

        switch response.status {
        case .ready:
            // Job complete - stop progress interpolation
            stopProgressInterpolation()

            // Job complete - check if we need to swap from preview to full audio
            if let audioUrlString = response.bestAudioUrl, let audioUrl = URL(string: audioUrlString) {
                print("[ArticleReader] Job ready, audio URL: \(audioUrlString)")

                isSynthesizing = false

                // Record usage (only if not already recorded for preview)
                if urlPlayer.playerMode != .preview {
                    UsageTrackerService.shared.recordUsage(
                        characterCount: article.rawText.count,
                        provider: currentVoice.provider,
                        voiceID: currentVoice.providerVoiceID,
                        articleID: article.id,
                        articleTitle: article.displayTitle,
                        wasSuccessful: true
                    )
                }

                // Update article status
                ArticleStore.shared.updateSynthesisStatus(
                    for: article.id,
                    status: .completed,
                    audioURL: audioUrl
                )

                // Persist the full audio URL for instant replay when returning to article
                persistFullAudioUrl(audioUrlString, for: article.id, voiceId: currentVoice.providerVoiceID)

                // Report latency
                if let startTime = synthesisStartTime {
                    let latencyMs = Int(Date().timeIntervalSince(startTime) * 1000)
                    let provider: ListenAICloudService.TTSProvider = currentVoice.provider == .selfhosted ? .selfhosted : .elevenlabs
                    if let cloudService = TTSServiceFactory.listenAICloudService {
                        Task {
                            await cloudService.reportLatency(
                                textLength: article.rawText.count,
                                latencyMs: latencyMs,
                                provider: provider,
                                voiceId: currentVoice.providerVoiceID
                            )
                        }
                    }
                }

                // Clear persisted job data (but keep fullUrl for instant replay)
                clearAllPersistedJobData(for: article.id, voiceId: currentVoice.providerVoiceID)

                // Send notification if generating in background
                if isGeneratingInBackground {
                    Task {
                        await sendSynthesisCompleteNotification(audioURL: audioUrl)
                    }
                }

                // Clear notify option state
                showNotifyWhenReadyOption = false
                
                // Check if we're currently playing preview - swap to full audio
                if urlPlayer.currentArticleID == article.id && urlPlayer.playerMode == .preview {
                    // Seamlessly swap from preview to full audio
                    swapToFullAudio(url: audioUrl)
                } else if !isGeneratingInBackground {
                    // Not currently playing preview - just play the full audio (unless in background mode)
                    playAudioWithMode(url: audioUrl, mode: .full)
                }

            } else {
                // No audio URL - treat as error
                handleTTSJobError(TTSJobError.unknown(message: "Job ready but no audio URL"))
            }

        case .partialReady:
            // Preview audio is available - start playing if not already
            if let previewUrlString = response.previewUrl, let previewUrl = URL(string: previewUrlString) {
                // Only start preview playback if we're not already playing preview for this article
                if urlPlayer.currentArticleID != article.id || urlPlayer.playerMode != .preview {
                    print("[ArticleReader] partial_ready - starting preview playback from: \(previewUrlString)")

                    // Record usage at preview start
                    UsageTrackerService.shared.recordUsage(
                        characterCount: article.rawText.count,
                        provider: currentVoice.provider,
                        voiceID: currentVoice.providerVoiceID,
                        articleID: article.id,
                        articleTitle: article.displayTitle,
                        wasSuccessful: true
                    )

                    // Start preview playback
                    playAudioWithMode(
                        url: previewUrl,
                        mode: .preview,
                        previewDuration: response.progress.progressSec
                    )

                    // Update banner to show we're now playing
                    isSynthesizing = false
                } else {
                    // Already playing preview - just update progress using backend percentage
                    let progress = Float(response.percentage) / 100.0
                    ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .inProgress(progress: progress))

                    // Update preview duration as more audio becomes available
                    let newPreviewDuration = response.progress.progressSec
                    urlPlayer.setPlayerMode(.preview, previewDuration: newPreviewDuration)
                }
            } else {
                // No preview URL yet - just update progress using backend percentage
                let progress = Float(response.percentage) / 100.0
                ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .inProgress(progress: progress))
            }

        case .failed:
            // Job failed - stop progress interpolation
            stopProgressInterpolation()
            let error = TTSJobError.fromJobStatus(response) ?? TTSJobError.jobFailed(jobId: response.jobId, reason: response.error?.message ?? "Unknown error")
            handleTTSJobError(error)
            clearAllPersistedJobData(for: article.id, voiceId: currentVoice.providerVoiceID)

        case .cancelled:
            // Job was cancelled - stop progress interpolation
            stopProgressInterpolation()
            isSynthesizing = false
            ttsJobManager.stopTracking(articleId: article.id)  // Clear job state
            synthesisError = "Generation was cancelled"
            clearAllPersistedJobData(for: article.id, voiceId: currentVoice.providerVoiceID)

        case .queued, .processing:
            // Still in progress - update article status with progress using backend percentage
            let progress = Float(response.percentage) / 100.0
            ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .inProgress(progress: progress))
        }
    }

    /// Play audio with a specific player mode (preview or full)
    private func playAudioWithMode(url: URL, mode: URLPlayerMode, previewDuration: Double? = nil) {
        Task {
            do {
                // Stop any streaming playback first
                streamingTTS.stopStreaming()

                let articleToMark = article

                // Pass mode directly to play() - this sets it AFTER stop() so it persists
                try await urlPlayer.play(
                    url: url,
                    articleID: article.id,
                    title: article.displayTitle,
                    artist: article.author ?? article.siteName,
                    startPosition: nil,
                    mode: mode,
                    previewDuration: previewDuration,
                    onComplete: {
                        // Mark as completed when playback finishes (only for full mode)
                        Task { @MainActor in
                            if mode == .full {
                                ArticleStore.shared.markAsFinished(articleToMark)
                            }
                        }
                    }
                )

                // Apply the user's preferred playback speed
                urlPlayer.setRate(playbackService.playbackSpeed.rate)

                print("[ArticleReader] Started playback in \(mode.rawValue) mode")
            } catch {
                synthesisError = error.localizedDescription
            }
        }
    }

    /// Seamlessly swap from preview to full audio while preserving playback position
    private func swapToFullAudio(url: URL) {
        Task {
            do {
                print("[ArticleReader] Swapping from preview to full audio")
                try await urlPlayer.swapAudioURL(to: url, mode: .full, preservePosition: true)
                print("[ArticleReader] Successfully swapped to full audio")
            } catch {
                print("[ArticleReader] Failed to swap audio: \(error)")
                // Fallback: stop and play fresh
                playAudioWithMode(url: url, mode: .full)
            }
        }
    }

    /// Setup TTSJobManager callbacks for immediate playback from remote URLs.
    /// This enables:
    /// 1. Immediate playback when partial_ready (no download wait)
    /// 2. Seamless swap to full audio preserving playback position
    private func setupTTSJobManagerCallbacks() {
        let articleId = article.id

        // Called when preview is ready - start playback immediately from remote URL
        TTSJobManager.shared.onPreviewReady = { [weak urlPlayer, weak streamingTTS] receivedArticleId, previewURL, previewDuration in
            guard receivedArticleId == articleId else { return }

            print("[ArticleReader] Preview ready callback - starting immediate playback from: \(previewURL)")

            Task { @MainActor in
                // Stop any streaming playback first
                streamingTTS?.stopStreaming()

                do {
                    // Pass mode directly to play() - this sets it AFTER stop() so it persists
                    try await urlPlayer?.play(
                        url: previewURL,
                        articleID: articleId,
                        title: self.article.displayTitle,
                        artist: self.article.author ?? self.article.siteName,
                        startPosition: nil,
                        mode: .preview,
                        previewDuration: previewDuration,
                        onComplete: nil  // Don't mark as finished for preview
                    )
                    print("[ArticleReader] Preview playback started from remote URL, mode: \(String(describing: urlPlayer?.playerMode))")
                } catch {
                    print("[ArticleReader] Failed to start preview playback: \(error)")
                }
            }
        }

        // Called when full audio is ready - swap to full audio preserving position
        TTSJobManager.shared.onFullAudioReady = { [weak urlPlayer] receivedArticleId, fullURL in
            guard receivedArticleId == articleId else { return }

            print("[ArticleReader] Full audio ready callback - swapping to: \(fullURL)")

            Task { @MainActor in
                let currentID = urlPlayer?.currentArticleID
                let currentMode = urlPlayer?.playerMode
                let currentState = urlPlayer?.state
                print("[ArticleReader] Full audio swap check - currentArticleID: \(String(describing: currentID)), playerMode: \(String(describing: currentMode)), state: \(String(describing: currentState))")

                // Check if we were playing preview for this article (or just finished preview)
                if currentID == articleId && currentMode == .preview {
                    // Seamless swap preserving playback position
                    // The swapAudioURL will auto-resume if preview was playing or had completed
                    do {
                        try await urlPlayer?.swapAudioURL(to: fullURL, mode: .full, preservePosition: true)
                        print("[ArticleReader] Swapped to full audio, position preserved")
                    } catch {
                        print("[ArticleReader] Failed to swap audio: \(error)")
                        // Fallback: play fresh from full URL
                        try? await urlPlayer?.play(
                            url: fullURL,
                            articleID: articleId,
                            title: self.article.displayTitle,
                            artist: self.article.author ?? self.article.siteName,
                            startPosition: nil,
                            mode: .full,
                            previewDuration: nil,
                            onComplete: {
                                Task { @MainActor in
                                    ArticleStore.shared.markAsFinished(self.article)
                                }
                            }
                        )
                    }
                } else if currentID != articleId {
                    // Not playing this article yet - full audio is ready
                    // Auto-start playback since the job just completed for this article
                    // and nothing else is currently playing
                    print("[ArticleReader] Full audio ready - auto-starting playback")
                    try? await urlPlayer?.play(
                        url: fullURL,
                        articleID: articleId,
                        title: self.article.displayTitle,
                        artist: self.article.author ?? self.article.siteName,
                        startPosition: nil,
                        mode: .full,
                        previewDuration: nil,
                        onComplete: {
                            Task { @MainActor in
                                ArticleStore.shared.markAsFinished(self.article)
                            }
                        }
                    )
                } else {
                    // Same article but not in preview mode (e.g., already swapped, or mode is .none/.full)
                    print("[ArticleReader] Full audio ready but playerMode is \(String(describing: currentMode)), not swapping")
                }
            }
        }

        // Called when job fails
        TTSJobManager.shared.onJobFailed = { receivedArticleId, errorMessage in
            guard receivedArticleId == articleId else { return }

            print("[ArticleReader] Job failed callback: \(errorMessage)")

            Task { @MainActor in
                self.isSynthesizing = false
                self.synthesisError = errorMessage
                // Note: ttsJobError is now a computed property reading from TTSJobManager
            }
        }

        // Called when job is not found (expired/cleaned up on server)
        // Auto-retry to check cache and potentially restart generation
        TTSJobManager.shared.onJobExpired = { receivedArticleId, voiceId in
            guard receivedArticleId == articleId else { return }

            Task { @MainActor in
                // Clear persisted data for this article+voice
                clearAllPersistedJobData(for: articleId, voiceId: voiceId)

                // Only auto-request if the current voice matches the expired job's voice
                // This prevents interference if user switched voices while job was expiring
                let currentVoiceId = voicePresetManager.selectedPreset.providerVoiceID
                guard voiceId == currentVoiceId || voiceId.isEmpty else {
                    print("[ArticleReader] Job expired for different voice (\(voiceId)), skipping auto-request (current: \(currentVoiceId))")
                    return
                }

                print("[ArticleReader] Job expired callback, auto-requesting TTS to check cache")

                // Auto-request TTS - this will:
                // 1. Check backend cache - if hit, play immediately
                // 2. If no cache, start new generation with new tracking ID
                requestTTSJob()
            }
        }
    }

    /// Handle voice change: stop current audio and cancel polling for old voice
    private func handleVoiceChange(previousVoiceId: String) {
        print("[ArticleReader] Handling voice change from: \(previousVoiceId)")

        // Stop current audio if playing this article
        if urlPlayer.currentArticleID == article.id {
            urlPlayer.stop()
        }
        if streamingTTS.currentArticleID == article.id {
            streamingTTS.stopStreaming()
        }

        // Cancel polling for the old voice's job
        cancelPolling()

        // Cancel the job on the server if we have one for the old voice
        if let jobId = ttsJobId {
            Task {
                do {
                    if let cloudService = TTSServiceFactory.listenAICloudService {
                        try await cloudService.cancelJob(jobId: jobId)
                        print("[ArticleReader] Cancelled job for old voice: \(jobId)")
                    }
                } catch {
                    print("[ArticleReader] Failed to cancel job: \(error)")
                }
            }
        }

        // Clear in-progress job data for old voice, but KEEP the full audio URL
        // so we can use it if user switches back to this voice
        clearAllPersistedJobData(for: article.id, voiceId: previousVoiceId)
        // Note: intentionally NOT clearing persistedFullAudioUrl to enable instant replay when switching back

        // Reset state via TTSJobManager (DRY)
        resetTTSJobState()
    }

    /// Cancel polling (but don't cancel the job on the server)
    private func cancelPolling() {
        pollingTask?.cancel()
        pollingTask = nil
        print("[ArticleReader] Polling cancelled")
    }

    /// Reset all TTS job state (DRY helper)
    /// Clears TTSJobManager tracking and local state
    private func resetTTSJobState() {
        ttsJobManager.stopTracking(articleId: article.id)
        ttsJobEstimatedWaitSec = nil
        isSynthesizing = false
        synthesisError = nil
        stopProgressInterpolation()
    }

    /// Update progress interpolation for smooth animation between backend updates
    /// This simulates incremental progress while the backend synthesizes remaining audio
    private func updateProgressInterpolation(
        currentProgressSec: Double,
        totalDurationSec: Double,
        estimatedRemainingSec: Int?
    ) {
        // Stop any existing interpolation timer
        progressInterpolationTimer?.invalidate()
        progressInterpolationTimer = nil

        // Update the base progress from backend
        interpolatedProgressSec = currentProgressSec
        lastProgressUpdateTime = Date()

        // Only interpolate if we have remaining time and there's more audio to synthesize
        guard let remainingSec = estimatedRemainingSec,
              remainingSec > 0,
              totalDurationSec > 0,
              currentProgressSec < totalDurationSec else {
            return
        }

        let remainingAudioSec = totalDurationSec - currentProgressSec
        let synthesisRateMultiplier = remainingAudioSec / Double(remainingSec)
        let startTime = Date()

        // Create timer to increment interpolated progress smoothly
        // Update every 0.1 seconds for smooth animation
        progressInterpolationTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { timer in
            // Calculate time elapsed since interpolation started
            let elapsedSec = Date().timeIntervalSince(startTime)

            // Estimate how much audio would have been synthesized
            // Use the synthesis rate calculated from remaining time estimate
            let additionalProgressSec = elapsedSec * synthesisRateMultiplier

            // Calculate new progress (cap at 98% to avoid overshooting)
            let newProgress = min(currentProgressSec + additionalProgressSec, totalDurationSec * 0.98)

            // Update on main thread
            DispatchQueue.main.async {
                self.interpolatedProgressSec = newProgress
            }
        }
    }

    /// Stop progress interpolation and reset state
    private func stopProgressInterpolation() {
        progressInterpolationTimer?.invalidate()
        progressInterpolationTimer = nil
        interpolatedProgressSec = 0
        lastProgressUpdateTime = nil
    }

    /// Cancel the TTS job entirely (user pressed cancel)
    private func cancelTTSJob() {
        let currentVoice = voicePresetManager.selectedPreset

        // Cancel polling first
        cancelPolling()

        // Reset state
        isSynthesizing = false
        synthesisError = nil
        // Note: ttsJobError is computed from TTSJobManager, cleared by stopTracking() below

        // Cancel job on server if we have a job ID
        if let jobId = ttsJobId {
            Task {
                do {
                    if let cloudService = TTSServiceFactory.listenAICloudService {
                        try await cloudService.cancelJob(jobId: jobId)
                        print("[ArticleReader] Job cancelled on server: \(jobId)")
                    }
                } catch {
                    print("[ArticleReader] Failed to cancel job on server: \(error)")
                }
            }
        }

        // Clear state via TTSJobManager (DRY)
        ttsJobManager.stopTracking(articleId: article.id)
        ttsJobEstimatedWaitSec = nil
        stopProgressInterpolation()

        // Clear persisted data
        clearAllPersistedJobData(for: article.id, voiceId: currentVoice.providerVoiceID)

        // Update article status
        ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .cancelled)

        // Clear notify option state
        showNotifyWhenReadyOption = false
        isGeneratingInBackground = false

        print("[ArticleReader] TTS job cancelled by user")
    }

    /// Bail out of the cloud queue and switch to on-device Kokoro synthesis.
    /// Triggered by the "Use offline AI instead" CTA on `CloudTTSProgressView`
    /// when `queue_depth > 5` and the device is eligible (≥4GB RAM, iOS 17+).
    private func switchToOfflineSynthesis() {
        guard KokoroModelManager.isDeviceEligible else {
            synthesisError = "This device can't run offline synthesis. Please wait for the cloud queue."
            return
        }

        // Cancel current cloud job — same teardown path as user-tap cancel.
        cancelTTSJob()

        // Re-trigger generation; the existing TTSCoordinator will use whatever
        // provider Settings is configured for. If user has Offline AI enabled,
        // Kokoro picks up automatically. Otherwise, we surface a hint.
        Task { @MainActor in
            // Tiny delay so the cancel teardown lands before we kick off a new job.
            try? await Task.sleep(nanoseconds: 200_000_000)
            switchToOnDeviceAndSynthesize()
        }
        print("[ArticleReader] User opted into offline synthesis from busy-queue CTA")
    }

    /// Bail out of an in-flight on-device run and route the same article
    /// through the cloud TTS pipeline. Used when offline synthesis is too slow
    /// or hits a per-chunk failure on a low-RAM device.
    private func switchToCloudSynthesis() {
        // Tear down the current Kokoro generation. KokoroOnDeviceTTSService
        // hears this via TTSCoordinator's cancel path — same path the cancel
        // button uses.
        TTSCoordinator.shared.cancelSynthesis()
        isSynthesizing = false

        // Flip the toggle off so the cloud path takes over. Persists into
        // UserDefaults; the user can re-enable Offline AI in Settings later.
        // Tapping "Switch to cloud" mid-job is a deliberate vote against
        // on-device for this device.
        voicePresetManager.useOfflineAI = false

        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 200_000_000)
            synthesizeAndPlay()
        }
        print("[ArticleReader] User opted out of offline synthesis → cloud path")
    }

    /// Enable background notification for when synthesis completes
    private func enableBackgroundNotification() async {
        // Request notification permission if needed
        let authorized = await NotificationManager.shared.requestAuthorization()

        guard authorized else {
            synthesisError = "Please enable notifications in Settings to use this feature."
            return
        }

        // Mark as generating in background
        isGeneratingInBackground = true
        showNotifyWhenReadyOption = false

        // The polling continues in the background
        // We'll send a notification when synthesis completes

        print("[ArticleReader] Background notification enabled for article: \(article.id)")
    }

    /// Send notification when synthesis is complete (called from polling completion)
    private func sendSynthesisCompleteNotification(audioURL: URL?) async {
        guard isGeneratingInBackground else { return }

        await NotificationManager.shared.notifySynthesisComplete(
            articleId: article.id.uuidString,
            articleTitle: article.displayTitle,
            audioURL: audioURL
        )

        // Reset background state
        isGeneratingInBackground = false

        print("[ArticleReader] Sent synthesis complete notification for: \(article.displayTitle)")
    }

    // Client-side quota checks removed - server handles all quota enforcement
    // The backend returns quota info in response headers (X-Daily-Used, X-Daily-Limit, etc.)
    // and will return 402 QuotaExceeded error if limits are reached

    private func switchToOnDeviceAndSynthesize() {
        // Switch to an on-device Apple voice
        let appleVoices = TTSCoordinator.shared.voices(provider: .apple)
        if let appleVoice = appleVoices.first(where: { $0.language.starts(with: "en") }) ?? appleVoices.first {
            TTSCoordinator.shared.selectVoice(appleVoice)
            print("[ArticleReader] Switched to on-device voice: \(appleVoice.name)")
        }
        performLegacySynthesis()
    }

    /// Synthesize using a cloned voice via job-based API with progress tracking.
    /// This uses the /api/tts/job-cloned endpoint for async synthesis with polling.
    private func requestClonedVoiceSynthesis(cloudService: ListenAICloudService, voice: VoicePreset) {
        // Reset state - clear any previous job tracking
        ttsJobManager.stopTracking(articleId: article.id)
        isSynthesizing = true
        synthesisError = nil
        synthesisStartTime = Date()

        // Set estimated time for cloned voice synthesis
        // Cloned voices are much slower than Kokoro - about 0.5x realtime for XTTS, 0.3x for Chatterbox
        let cloningModel = VoicePresetManager.shared.voiceCloningModel
        estimatedTimeString = estimatedClonedVoiceSynthesisTime(
            characterCount: article.rawText.count,
            model: cloningModel
        )

        // Stop any currently playing audio
        if playbackService.state.isPlaying {
            playbackService.pause()
        }
        if urlPlayer.state.isActive {
            urlPlayer.stop()
        }
        streamingTTS.stopStreaming()

        // Update article status
        ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .inProgress(progress: 0))

        Task {
            do {
                let voiceId = voice.providerVoiceID

                // Fetch cloned voice details to get the audio URL
                let clonedVoices = try await VoiceCloningService.shared.listClonedVoices()
                guard let clonedVoice = clonedVoices.first(where: { $0.id == voiceId }),
                      let voiceUrl = clonedVoice.audioUrl else {
                    print("[ArticleReader] Cloned voice not found or no audio URL: \(voiceId)")
                    await MainActor.run {
                        self.isSynthesizing = false
                        self.synthesisError = "Cloned voice not found"
                        ArticleStore.shared.updateSynthesisStatus(
                            for: article.id,
                            status: .failed(message: "Cloned voice not found")
                        )
                    }
                    return
                }

                // Get user's preferred cloning model
                let cloningModelRaw = VoicePresetManager.shared.voiceCloningModel.rawValue
                print("[ArticleReader] Requesting cloned voice job: \(voiceId), model: \(cloningModelRaw), text: \(article.rawText.count) chars")

                // Call job-based cloned voice synthesis endpoint
                let response = try await cloudService.requestClonedVoiceTTS(
                    text: article.rawText,
                    voiceId: voiceId,
                    voiceUrl: voiceUrl,
                    speed: Double(playbackService.playbackSpeed.rate),
                    model: cloningModelRaw,
                    articleId: article.id.uuidString,
                    articleTitle: article.displayTitle
                )

                // Persist job ID for this article+voice combo (for resume after app restart)
                persistJobId(response.jobId, for: article.id, voiceId: voiceId)

                print("[ArticleReader] Cloned voice job response: status=\(response.status.rawValue), jobId=\(response.jobId)")

                switch response.status {
                case .ready:
                    // Audio is immediately available (cache hit) - play it
                    if let audioUrlString = response.audioUrl, let audioUrl = URL(string: audioUrlString) {
                        print("[ArticleReader] Cloned voice audio ready immediately (cache hit), playing from: \(audioUrlString)")

                        isSynthesizing = false

                        // Record usage
                        UsageTrackerService.shared.recordUsage(
                            characterCount: article.rawText.count,
                            provider: voice.provider,
                            voiceID: voice.providerVoiceID,
                            articleID: article.id,
                            articleTitle: article.displayTitle,
                            wasSuccessful: true
                        )

                        // Update article status
                        ArticleStore.shared.updateSynthesisStatus(
                            for: article.id,
                            status: .completed,
                            audioURL: audioUrl
                        )

                        // Persist the full audio URL for instant replay
                        persistFullAudioUrl(audioUrlString, for: article.id, voiceId: voice.providerVoiceID)

                        // Play the audio with full mode
                        playAudioWithMode(url: audioUrl, mode: .full)
                    } else {
                        throw TTSJobError.unknown(message: "Status is ready but no audio URL provided")
                    }

                case .queued, .processing, .partialReady:
                    // Job is processing - start tracking with TTSJobManager
                    print("[ArticleReader] Cloned voice job is processing (status: \(response.status.rawValue)), starting tracking")

                    // Update estimated wait time
                    if let waitTime = response.estimatedWaitSec {
                        ttsJobEstimatedWaitSec = waitTime
                    }

                    // Persist job status for resume
                    persistJobStatus(response.status, for: article.id, voiceId: voice.providerVoiceID)

                    // Start TTSJobManager tracking (handles polling and callbacks)
                    ttsJobManager.trackJob(
                        articleId: article.id,
                        jobId: response.jobId,
                        voiceId: voice.providerVoiceID,
                        initialStatus: response.status
                    )

                    // Start timer to show "Notify when ready" option after 5 seconds
                    // (cloned voice synthesis takes longer so this is especially useful)
                    showNotifyWhenReadyOption = false
                    Task { @MainActor in
                        try? await Task.sleep(nanoseconds: 5_000_000_000)
                        if self.isSynthesizing {
                            self.showNotifyWhenReadyOption = true
                        }
                    }

                case .failed:
                    throw TTSJobError.jobFailed(jobId: response.jobId, reason: "Job failed during request")

                case .cancelled:
                    throw TTSJobError.jobCancelled(jobId: response.jobId)
                }

            } catch let error as TTSJobError {
                handleTTSJobError(error)
            } catch {
                print("[ArticleReader] Cloned voice job request failed: \(error)")
                await MainActor.run {
                    self.isSynthesizing = false
                    self.synthesisError = error.localizedDescription
                    ArticleStore.shared.updateSynthesisStatus(
                        for: article.id,
                        status: .failed(message: error.localizedDescription)
                    )
                }
            }
        }
    }

    /// Legacy synthesis using TTSCoordinator (for on-device Apple voices)
    /// Cloud voices now use job-based API via requestTTSJob()
    private func performLegacySynthesis(forceNonStreaming: Bool = false) {
        isSynthesizing = true
        synthesisError = nil
        synthesisStartTime = Date()

        // Log if this is a fallback from streaming
        if forceNonStreaming {
            print("[ArticleReader] Using non-streaming synthesis (fallback mode)")
        }

        // Fetch estimated time from server asynchronously
        Task {
            if let cloudService = TTSServiceFactory.listenAICloudService {
                let estimate = await cloudService.getEstimatedTimeString(textLength: article.rawText.count)
                await MainActor.run {
                    self.estimatedTimeString = estimate
                }
            } else {
                // Use local estimate as fallback
                await MainActor.run {
                    self.estimatedTimeString = estimatedSynthesisTime(for: article.rawText.count)
                }
            }
        }

        Task {
            do {
                // Stop any currently playing audio
                if playbackService.state.isPlaying {
                    playbackService.pause()
                }
                // Stop URL player if active
                if urlPlayer.state.isActive {
                    urlPlayer.stop()
                }
                // Also stop any streaming playback (legacy)
                streamingTTS.stopStreaming()

                ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .inProgress(progress: 0))

                let currentVoice = voicePresetManager.selectedPreset

                // Synthesize using TTSCoordinator
                let audioURL = try await TTSCoordinator.shared.synthesize(
                    text: article.rawText,
                    voice: nil,
                    options: nil
                )

                // Record usage for cloud voices
                if currentVoice.provider != .apple {
                    UsageTrackerService.shared.recordUsage(
                        characterCount: article.rawText.count,
                        provider: currentVoice.provider,
                        voiceID: currentVoice.providerVoiceID,
                        articleID: article.id,
                        articleTitle: article.displayTitle,
                        wasSuccessful: true
                    )
                }

                ArticleStore.shared.updateSynthesisStatus(
                    for: article.id,
                    status: .completed,
                    audioURL: audioURL
                )

                // Calculate and report latency
                let latencyMs = synthesisStartTime.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
                let textLength = article.rawText.count

                isSynthesizing = false

                // Now play the synthesized audio
                playAudio(url: audioURL)

                // Report latency to server for analytics (non-blocking)
                if let cloudService = TTSServiceFactory.listenAICloudService {
                    let provider: ListenAICloudService.TTSProvider = currentVoice.provider == .selfhosted ? .selfhosted : .elevenlabs
                    Task {
                        await cloudService.reportLatency(
                            textLength: textLength,
                            latencyMs: latencyMs,
                            provider: provider,
                            voiceId: currentVoice.providerVoiceID
                        )
                    }
                }

                // Upload to cloud storage in background for backup
                uploadToCloudStorage(audioURL: audioURL)

            } catch {
                isSynthesizing = false

                // Record failed usage attempt for cloud voices
                let currentVoice = voicePresetManager.selectedPreset
                if currentVoice.provider != .apple {
                    UsageTrackerService.shared.recordUsage(
                        characterCount: article.rawText.count,
                        provider: currentVoice.provider,
                        voiceID: currentVoice.providerVoiceID,
                        articleID: article.id,
                        articleTitle: article.displayTitle,
                        wasSuccessful: false,
                        errorMessage: error.localizedDescription
                    )
                }

                synthesisError = error.localizedDescription
                ArticleStore.shared.updateSynthesisStatus(
                    for: article.id,
                    status: .failed(message: error.localizedDescription)
                )
            }
        }
    }

    private func uploadToCloudStorage(audioURL: URL) {
        Task {
            do {
                guard let cloudService = TTSServiceFactory.listenAICloudService else {
                    print("[ArticleReader] Cloud service not available, skipping backup")
                    return
                }

                let audioData = try Data(contentsOf: audioURL)
                try await cloudService.uploadAudio(articleId: article.id.uuidString, audioData: audioData)
                print("[ArticleReader] Audio backed up to cloud storage")
            } catch {
                // Non-critical error, just log it
                print("[ArticleReader] Cloud backup failed (non-critical): \(error)")
            }
        }
    }

    // MARK: - Streaming TTS Synthesis

    /// Perform streaming TTS synthesis - audio starts playing as chunks arrive
    private func performStreamingSynthesis() {
        isSynthesizing = true
        synthesisError = nil
        synthesisStartTime = Date()
        estimatedTimeString = "Starting stream..."

        Task {
            do {
                // Stop any currently playing audio from the regular playback service
                if playbackService.state.isPlaying {
                    playbackService.pause()
                }
                // StreamingTTSService.startStreaming() already calls stopStreaming() internally

                ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .inProgress(progress: 0))

                let currentVoice = voicePresetManager.selectedPreset

                // Configure streaming service if needed
                if !streamingTTS.isConfigured {
                    if let cloudService = TTSServiceFactory.listenAICloudService {
                        streamingTTS.configure(
                            backendURL: cloudService.baseURL,
                            authTokenProvider: { try await cloudService.getAuthToken() }
                        )
                    } else {
                        throw TTSError.invalidConfiguration(reason: "Cloud service not available")
                    }
                }

                print("[ArticleReader] Starting streaming synthesis with voice: \(currentVoice.name)")

                // Start streaming - this will start playback as soon as first chunk arrives
                // Pass article ID for caching and highlighting coordination
                try await streamingTTS.startStreaming(
                    text: article.rawText,
                    voice: currentVoice,
                    speed: currentVoice.styleParameters.speakingRate,
                    articleID: article.id
                )

                // Record usage for cloud voices
                if currentVoice.provider != .apple {
                    UsageTrackerService.shared.recordUsage(
                        characterCount: article.rawText.count,
                        provider: currentVoice.provider,
                        voiceID: currentVoice.providerVoiceID,
                        articleID: article.id,
                        articleTitle: article.displayTitle,
                        wasSuccessful: true
                    )
                }

                // Get cached audio URL if available
                let cachedAudioURL = streamingTTS.getSavedAudioURL(for: article.id)

                ArticleStore.shared.updateSynthesisStatus(
                    for: article.id,
                    status: .completed,
                    audioURL: cachedAudioURL  // Save cached audio URL for future plays
                )

                // Calculate and report latency
                let latencyMs = synthesisStartTime.map { Int(Date().timeIntervalSince($0) * 1000) } ?? 0
                let textLength = article.rawText.count

                isSynthesizing = false

                // Report latency to server for analytics (non-blocking)
                if let cloudService = TTSServiceFactory.listenAICloudService {
                    Task {
                        await cloudService.reportLatency(
                            textLength: textLength,
                            latencyMs: latencyMs,
                            provider: .selfhosted,  // Streaming always uses selfhosted
                            voiceId: currentVoice.kokoroVoiceID ?? currentVoice.providerVoiceID
                        )
                    }
                }

                print("[ArticleReader] Streaming synthesis completed in \(latencyMs)ms")

            } catch {
                isSynthesizing = false

                // Record failed usage attempt for cloud voices
                let currentVoice = voicePresetManager.selectedPreset
                if currentVoice.provider != .apple {
                    UsageTrackerService.shared.recordUsage(
                        characterCount: article.rawText.count,
                        provider: currentVoice.provider,
                        voiceID: currentVoice.providerVoiceID,
                        articleID: article.id,
                        articleTitle: article.displayTitle,
                        wasSuccessful: false,
                        errorMessage: error.localizedDescription
                    )
                }

                synthesisError = error.localizedDescription
                ArticleStore.shared.updateSynthesisStatus(
                    for: article.id,
                    status: .failed(message: error.localizedDescription)
                )

                print("[ArticleReader] Streaming synthesis failed: \(error)")

                // Fallback to non-streaming synthesis for this request only
                // Don't permanently disable streaming - just use non-streaming for this synthesis
                print("[ArticleReader] Falling back to non-streaming synthesis")
                performLegacySynthesis(forceNonStreaming: true)
            }
        }
    }

    private func cycleSpeed() {
        let speeds: [PlaybackSpeed] = PlaybackSpeed.speeds
        guard let currentIndex = speeds.firstIndex(of: playbackService.playbackSpeed) else { return }
        let nextIndex = (currentIndex + 1) % speeds.count
        let newSpeed = speeds[nextIndex]

        // Update playback service (for legacy playback and state tracking)
        playbackService.setPlaybackSpeed(newSpeed)

        // Update URL player if it's active (new job-based playback)
        if urlPlayer.currentArticleID == article.id && urlPlayer.state.isActive {
            urlPlayer.setRate(newSpeed.rate)
        }
    }

    private func toggleFavorite() {
        ArticleStore.shared.toggleFavorite(article)
    }

    private func addToLibrary() {
        // Save to library via ImportCoordinator
        ImportCoordinator.shared.saveToLibrary(article)
        showingAddedToLibrary = true
    }

    private func regenerateAudio() {
        Task {
            // Stop any current playback
            if isCurrentlyPlaying {
                await playbackService.stop()
            }

            // Clear existing audio and reset synthesis status
            ArticleStore.shared.updateSynthesisStatus(for: article.id, status: .notStarted)

            // Update the voice tracking
            lastUsedVoiceID = voicePresetManager.selectedPreset.id
            lastUsedProviderVoiceID = voicePresetManager.selectedPreset.providerVoiceID

            // Start fresh synthesis
            synthesizeAndPlay()
        }
    }

    private func shareArticle() {
        let text = "\(article.displayTitle)\n\n\(article.rawText.prefix(500))..."
        let activityVC = UIActivityViewController(activityItems: [text], applicationActivities: nil)

        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first,
           let rootVC = window.rootViewController {
            if let popover = activityVC.popoverPresentationController {
                popover.sourceView = window
                popover.sourceRect = CGRect(x: window.bounds.midX, y: window.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            rootVC.present(activityVC, animated: true)
        }
    }

    private func addToQueue() {
        queueManager.addToQueue(article)
    }

    private func markAsFinished() {
        ArticleStore.shared.markAsFinished(article)
    }

    private func exportAudio() {
        guard let audioURL = article.audioFileURL else { return }
        let activityVC = UIActivityViewController(activityItems: [audioURL], applicationActivities: nil)

        if let windowScene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = windowScene.windows.first,
           let rootVC = window.rootViewController {
            if let popover = activityVC.popoverPresentationController {
                popover.sourceView = window
                popover.sourceRect = CGRect(x: window.bounds.midX, y: window.bounds.midY, width: 0, height: 0)
                popover.permittedArrowDirections = []
            }
            rootVC.present(activityVC, animated: true)
        }
    }

    private func deleteArticle() {
        ArticleStore.shared.delete(article)
        dismiss()
    }
}

// MARK: - Voice Avatar View

struct VoiceAvatarView: View {
    @StateObject private var presetManager = VoicePresetManager.shared
    var size: CGFloat = 32

    var body: some View {
        ZStack {
            Circle()
                .fill(Color(hex: presetManager.selectedPreset.accentColorHex ?? "#6B7280").gradient)

            // Use emoji if available, otherwise fallback to icon
            if let emoji = presetManager.selectedPreset.avatarEmoji {
                Text(emoji)
                    .font(.system(size: size * 0.55))
            } else if let iconName = presetManager.selectedPreset.iconName {
                Image(systemName: iconName)
                    .font(.body)
                    .foregroundStyle(.white)
            } else {
                Image(systemName: "waveform")
                    .font(.body)
                    .foregroundStyle(.white)
            }
        }
        .frame(width: size, height: size)
    }
}

// MARK: - Text Settings Sheet

struct TextSettingsSheet: View {
    @Binding var fontSize: Double
    @Binding var lineSpacing: Double
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 24) {
                // Font size
                VStack(alignment: .leading, spacing: 8) {
                    Text("Text Size")
                        .font(.subheadline.weight(.medium))

                    HStack {
                        Text("A")
                            .font(.caption)
                        Slider(value: $fontSize, in: 14...28, step: 2)
                        Text("A")
                            .font(.title2)
                    }
                }

                // Line spacing
                VStack(alignment: .leading, spacing: 8) {
                    Text("Line Spacing")
                        .font(.subheadline.weight(.medium))

                    Slider(value: $lineSpacing, in: 4...16, step: 2)
                }

                Spacer()
            }
            .padding()
            .navigationTitle("Text Settings")
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

// MARK: - Appearance Settings Sheet

struct AppearanceSettingsSheet: View {
    @Binding var fontSize: Double
    @Binding var lineSpacing: Double
    @Binding var fontType: String
    @Binding var highlightStyle: String
    @Binding var highlightWordOnly: Bool
    @Binding var themeMode: String
    @Environment(\.dismiss) private var dismiss

    @State private var showingFontPicker = false
    @State private var showingHighlightPicker = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Font Section
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Font")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        // Font Type Row
                        Button {
                            showingFontPicker = true
                        } label: {
                            HStack {
                                Text("Type")
                                    .foregroundStyle(.primary)
                                Spacer()
                                Text(fontType)
                                    .foregroundStyle(.secondary)
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding()
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }

                        // Font Size Slider
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("Size")
                                    .foregroundStyle(.primary)
                                Spacer()
                                Text("\(Int(fontSize))pt")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            HStack {
                                Text("A")
                                    .font(.caption)
                                Slider(value: $fontSize, in: 14...28, step: 1)
                                Text("A")
                                    .font(.title2)
                            }
                        }
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))

                        // Line Spacing Slider
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text("Line Spacing")
                                    .foregroundStyle(.primary)
                                Spacer()
                                Text(lineSpacing < 6 ? "Compact" : lineSpacing < 10 ? "Normal" : "Relaxed")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }

                            HStack {
                                Image(systemName: "text.alignleft")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                                Slider(value: $lineSpacing, in: 4...16, step: 2)
                                Image(systemName: "text.alignleft")
                                    .font(.body)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    // Color Section
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Color")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        // Reading Highlight Row
                        Button {
                            showingHighlightPicker = true
                        } label: {
                            HStack {
                                Text("Reading Highlight")
                                    .foregroundStyle(.primary)
                                Spacer()
                                HighlightPreviewBadge(style: highlightStyle)
                                Image(systemName: "chevron.right")
                                    .font(.caption)
                                    .foregroundStyle(.tertiary)
                            }
                            .padding()
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }

                    // Mode Section
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Mode")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)

                        HStack(spacing: 12) {
                            ThemeModeButton(title: "System", isSelected: themeMode == "System") {
                                themeMode = "System"
                            }
                            ThemeModeButton(title: "Light", isSelected: themeMode == "Light") {
                                themeMode = "Light"
                            }
                            ThemeModeButton(title: "Dark", isSelected: themeMode == "Dark") {
                                themeMode = "Dark"
                            }
                        }
                    }
                }
                .padding()
                .padding(.bottom, 40) // Extra bottom padding to prevent cut-off
            }
            .navigationTitle("Appearance")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.body.weight(.medium))
                    }
                }
            }
            .sheet(isPresented: $showingFontPicker) {
                FontTypePickerSheet(selectedFont: $fontType)
                    .presentationDetents([.medium])
            }
            .sheet(isPresented: $showingHighlightPicker) {
                HighlightStylePickerSheet(
                    selectedStyle: $highlightStyle,
                    highlightWordOnly: $highlightWordOnly
                )
                .presentationDetents([.medium, .large])
            }
        }
    }
}

// MARK: - Theme Mode Button

struct ThemeModeButton: View {
    let title: String
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                RoundedRectangle(cornerRadius: 8)
                    .fill(backgroundColor)
                    .frame(height: 60)
                    .overlay(
                        Text("Aa")
                            .font(.title2.weight(.medium))
                            .foregroundStyle(textColor)
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 8)
                            .stroke(isSelected ? Color.yellow : Color.clear, lineWidth: 2)
                    )

                Text(title)
                    .font(.caption)
                    .foregroundStyle(isSelected ? .yellow : .primary)
            }
        }
        .buttonStyle(.plain)
    }

    private var backgroundColor: Color {
        switch title {
        case "Light": return .white
        case "Dark": return Color(.darkGray)
        default: return Color(.systemGray5)
        }
    }

    private var textColor: Color {
        switch title {
        case "Light": return .black
        case "Dark": return .white
        default: return .primary
        }
    }
}

// MARK: - Highlight Preview Badge

struct HighlightPreviewBadge: View {
    let style: String

    var body: some View {
        Text("Aa")
            .font(.caption.weight(.medium))
            .padding(.horizontal, 8)
            .padding(.vertical, 4)
            .background(highlightColor.opacity(0.3))
            .foregroundStyle(highlightColor)
            .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    private var highlightColor: Color {
        switch style {
        case "Calm": return .blue
        case "Fresh": return .mint
        case "Natural": return .green
        case "Warm": return .orange
        case "Soothing": return .purple
        case "Neutral": return .gray
        default: return .yellow
        }
    }
}

// MARK: - Font Type Picker Sheet

struct FontTypePickerSheet: View {
    @Binding var selectedFont: String
    @Environment(\.dismiss) private var dismiss

    let fonts = ["System", "Andika", "Barlow", "Crimson Text", "Open Dyslexic", "Inter", "Tinos", "Work Sans"]

    var body: some View {
        NavigationStack {
            List {
                ForEach(fonts, id: \.self) { font in
                    Button {
                        selectedFont = font
                        dismiss()
                    } label: {
                        HStack {
                            Text(font)
                                .font(fontForName(font))
                                .foregroundStyle(.primary)
                            Spacer()
                            if selectedFont == font {
                                Image(systemName: "checkmark")
                                    .foregroundStyle(.yellow)
                            }
                        }
                    }
                }
            }
            .navigationTitle("Font Type")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                    }
                }
            }
        }
    }

    private func fontForName(_ name: String) -> Font {
        switch name {
        case "Andika": return .custom("Andika", size: 17)
        case "Barlow": return .custom("Barlow", size: 17)
        case "Crimson Text": return .custom("CrimsonText-Regular", size: 17)
        case "Open Dyslexic": return .custom("OpenDyslexic", size: 17)
        case "Inter": return .custom("Inter", size: 17)
        case "Tinos": return .custom("Tinos", size: 17)
        case "Work Sans": return .custom("WorkSans", size: 17)
        default: return .body
        }
    }
}

// MARK: - Highlight Style Picker Sheet

struct HighlightStylePickerSheet: View {
    @Binding var selectedStyle: String
    @Binding var highlightWordOnly: Bool
    @Environment(\.dismiss) private var dismiss

    let styles: [(name: String, description: String, color: Color)] = [
        ("Calm", "warm, relaxing, easy to follow", .blue),
        ("Fresh", "refreshing, good for focus", .mint),
        ("Natural", "gentle, balanced for long reading", .green),
        ("Warm", "cozy, energizing", .orange),
        ("Soothing", "calming, reduces eye strain", .purple),
        ("Neutral", "minimal distraction, very subtle", .gray)
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Preview text
                previewTextView
                    .padding()
                    .background(Color(.secondarySystemBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .padding()

                // Word-only toggle
                Toggle("Only Highlight Word", isOn: $highlightWordOnly)
                    .padding(.horizontal)
                    .padding(.bottom)

                Divider()

                // Style list
                List {
                    ForEach(styles, id: \.name) { style in
                        Button {
                            selectedStyle = style.name
                        } label: {
                            HStack(spacing: 12) {
                                Text("Aa")
                                    .font(.headline.weight(.medium))
                                    .foregroundStyle(style.color)
                                    .frame(width: 40)

                                VStack(alignment: .leading, spacing: 2) {
                                    Text(style.name)
                                        .font(.body.weight(.medium))
                                        .foregroundStyle(.primary)
                                    Text(style.description)
                                        .font(.caption)
                                        .foregroundStyle(.secondary)
                                }

                                Spacer()

                                if selectedStyle == style.name {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(style.color)
                                }
                            }
                        }
                    }
                }
                .listStyle(.plain)
            }
            .navigationTitle("Reading Highlight")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                    }
                }
            }
        }
    }

    private var previewTextView: some View {
        VStack(alignment: .leading, spacing: 8) {
            if highlightWordOnly {
                // Word-only mode: show text with one word highlighted
                Text("The sun slowly rose over the horizon, painting the sky in brilliant colors.")
                    .font(.subheadline)
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(selectedColor.opacity(0.5), lineWidth: 2)
                    )
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(selectedColor)
                            .frame(width: 3)
                            .padding(.vertical, 4)
                    }
            } else {
                // Full paragraph mode: show text with full background highlight
                Text("The sun slowly rose over the horizon, painting the sky in brilliant colors.")
                    .font(.subheadline)
                    .padding(8)
                    .background(selectedColor.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }

            // Non-highlighted paragraph for context
            Text("Birds began their morning songs as the city slowly awakened.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var selectedColor: Color {
        styles.first { $0.name == selectedStyle }?.color ?? .yellow
    }
}

// MARK: - More Options Sheet

struct MoreOptionsSheet: View {
    let article: Article
    let isInLibrary: Bool
    let onAddToLibrary: () -> Void
    let onAddToQueue: () -> Void
    let onMarkAsFinished: () -> Void
    let onToggleFavorite: () -> Void
    let onExportAudio: () -> Void
    let onDeleteFile: () -> Void
    let onRegenerateAudio: () -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 0) {
                    // Article header
                    HStack(spacing: 12) {
                        // Source icon
                        Image(systemName: article.sourceType.iconName)
                            .font(.title2)
                            .foregroundStyle(.secondary)
                            .frame(width: 50, height: 50)
                            .background(Color(.secondarySystemBackground))
                            .clipShape(RoundedRectangle(cornerRadius: 8))

                        VStack(alignment: .leading, spacing: 2) {
                            Text(article.displayTitle)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(2)
                            Text(article.sourceType.rawValue.uppercased())
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }

                        Spacer()

                        // Edit button
                        Button {
                            // Edit action
                        } label: {
                            Image(systemName: "square.and.pencil")
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding()

                    Divider()

                    // Download Audio option
                    if article.synthesisStatus.isComplete {
                        MoreOptionsRow(
                            icon: "arrow.down.circle",
                            title: "Download Audio",
                            subtitle: "Allows you to listen offline within the app.",
                            trailing: {
                                HStack(spacing: 4) {
                                    Image(systemName: "waveform")
                                        .font(.caption2)
                                    Text(VoicePresetManager.shared.selectedPreset.name)
                                        .font(.caption2)
                                }
                                .foregroundStyle(.secondary)
                            }
                        ) {
                            // Already downloaded
                        }
                    }

                    Divider().padding(.leading, 60)

                    // Notes
                    MoreOptionsRow(icon: "note.text", title: "Notes") {
                        // Notes action
                    }

                    // Summarize
                    MoreOptionsRow(icon: "sparkles", title: "Summarize") {
                        // Summarize action
                    }

                    Divider().padding(.leading, 60)

                    // Add to Queue
                    MoreOptionsRow(icon: "text.line.first.and.arrowtriangle.forward", title: "Add to Queue") {
                        onAddToQueue()
                        dismiss()
                    }

                    // Mark as Finished
                    MoreOptionsRow(icon: "checkmark.circle", title: "Mark as Finished") {
                        onMarkAsFinished()
                        dismiss()
                    }

                    // Add to Favorites
                    MoreOptionsRow(
                        icon: article.isFavorite ? "heart.fill" : "heart",
                        title: article.isFavorite ? "Remove from Favorites" : "Add to Favorites"
                    ) {
                        onToggleFavorite()
                        dismiss()
                    }

                    Divider().padding(.leading, 60)

                    // Sleep Timer
                    MoreOptionsRow(icon: "moon.zzz", title: "Sleep Timer") {
                        // Sleep timer action
                    }

                    // Export Audio
                    if article.synthesisStatus.isComplete {
                        MoreOptionsRow(
                            icon: "square.and.arrow.up",
                            title: "Export Audio",
                            subtitle: "Save audio to device or share it directly."
                        ) {
                            onExportAudio()
                            dismiss()
                        }
                    }

                    Divider().padding(.leading, 60)

                    // Delete File
                    MoreOptionsRow(
                        icon: "trash",
                        title: "Delete File",
                        isDestructive: true
                    ) {
                        onDeleteFile()
                    }
                }
            }
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
    }
}

// MARK: - More Options Row

struct MoreOptionsRow<Trailing: View>: View {
    let icon: String
    let title: String
    var subtitle: String? = nil
    var isDestructive: Bool = false
    var trailing: (() -> Trailing)? = nil
    let action: () -> Void

    init(
        icon: String,
        title: String,
        subtitle: String? = nil,
        isDestructive: Bool = false,
        @ViewBuilder trailing: @escaping () -> Trailing,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.isDestructive = isDestructive
        self.trailing = trailing
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Image(systemName: icon)
                    .font(.title3)
                    .foregroundStyle(isDestructive ? .red : .primary)
                    .frame(width: 28)

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(isDestructive ? .red : .primary)

                    if let subtitle = subtitle {
                        Text(subtitle)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                if let trailing = trailing {
                    trailing()
                }
            }
            .padding(.horizontal)
            .padding(.vertical, 14)
        }
        .buttonStyle(.plain)
    }
}

extension MoreOptionsRow where Trailing == EmptyView {
    init(
        icon: String,
        title: String,
        subtitle: String? = nil,
        isDestructive: Bool = false,
        action: @escaping () -> Void
    ) {
        self.icon = icon
        self.title = title
        self.subtitle = subtitle
        self.isDestructive = isDestructive
        self.trailing = nil
        self.action = action
    }
}

// MARK: - AI Chat Speech Controller

/// Simple speech controller for reading AI responses aloud
final class AIChatSpeechController: NSObject, ObservableObject, AVSpeechSynthesizerDelegate {
    @Published var isSpeaking = false

    private let synthesizer = AVSpeechSynthesizer()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) {
        // Stop any current speech
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }

        // Configure audio session for playback
        #if os(iOS)
        let audioSession = AVAudioSession.sharedInstance()
        do {
            try audioSession.setCategory(.playback, mode: .spokenAudio, options: [])
            try audioSession.setActive(true)
        } catch {
            print("[AIChatSpeech] Audio session error: \(error)")
        }
        #endif

        let utterance = AVSpeechUtterance(string: text)
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate
        utterance.pitchMultiplier = 1.0
        utterance.volume = 1.0

        // Use default voice for user's language
        if let voice = AVSpeechSynthesisVoice(language: Locale.current.language.languageCode?.identifier ?? "en-US") {
            utterance.voice = voice
        }

        isSpeaking = true
        synthesizer.speak(utterance)
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        isSpeaking = false
    }

    // MARK: - AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            self.isSpeaking = false
        }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        DispatchQueue.main.async {
            self.isSpeaking = false
        }
    }
}

// MARK: - AI Chat View

struct AIChatView: View {
    let article: Article
    @Environment(\.dismiss) private var dismiss
    @StateObject private var speechController = AIChatSpeechController()

    @State private var messageText: String = ""
    @State private var aiResponse: String?
    @State private var isLoading = false
    @State private var showingSummarizeInChat = false

    /// The preamble text shown when no AI response exists yet
    private let preambleText = "Hi there! Whatever you're wondering, just ask me or if you'd like, I can read your document and give you a quick, easy-to-digest summary."

    var body: some View {
        VStack(spacing: 0) {
            // Header
            HStack {
                Button {
                    dismiss()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)
                        .frame(width: 32, height: 32)
                }

                // Link icon button
                Button {
                    // Open source URL if available
                    if let url = article.sourceURL {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    Image(systemName: "link")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(8)
                        .background(Color(.secondarySystemBackground))
                        .clipShape(Circle())
                }

                // Title
                VStack(alignment: .leading, spacing: 2) {
                    Text(article.displayTitle)
                        .font(.subheadline.weight(.medium))
                        .lineLimit(1)
                    Text(article.sourceType.displayName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                // Play/Stop button for reading AI response
                Button {
                    if speechController.isSpeaking {
                        speechController.stop()
                    } else {
                        // Read AI response if available, otherwise read preamble
                        let textToRead = aiResponse ?? preambleText
                        speechController.speak(textToRead)
                    }
                } label: {
                    Image(systemName: speechController.isSpeaking ? "stop.fill" : "play.fill")
                        .font(.body)
                        .foregroundStyle(.yellow)
                        .padding(10)
                        .background(
                            Circle()
                                .stroke(Color.yellow, lineWidth: 2)
                        )
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)

            Divider()

            // Chat content
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // Welcome message
                    if aiResponse == nil && !isLoading {
                        Text(preambleText + " ✨📄")
                            .font(.body)
                            .padding(.horizontal)
                            .padding(.top, 16)

                        // Summarize Text button
                        Button {
                            performSummarize()
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "doc.text.magnifyingglass")
                                    .font(.subheadline)
                                Text("Summarize Text")
                                    .font(.subheadline.weight(.medium))
                            }
                            .foregroundStyle(.blue)
                            .padding(.horizontal, 16)
                            .padding(.vertical, 10)
                            .background(
                                RoundedRectangle(cornerRadius: 20)
                                    .stroke(Color.blue.opacity(0.5), lineWidth: 1)
                            )
                        }
                        .padding(.horizontal)
                    }

                    // Loading state
                    if isLoading {
                        HStack(spacing: 12) {
                            ProgressView()
                            Text("Analyzing article...")
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        .padding()
                    }

                    // AI Response
                    if let response = aiResponse {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Image(systemName: "sparkles")
                                    .foregroundStyle(.yellow)
                                Text("Summary")
                                    .font(.subheadline.weight(.semibold))
                            }

                            Text(response)
                                .font(.body)
                        }
                        .padding()
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(12)
                        .padding(.horizontal)
                    }

                    Spacer(minLength: 100)
                }
            }

            Spacer()

            // Bottom input area
            VStack(spacing: 12) {
                // Text input
                HStack {
                    TextField("Type a message...", text: $messageText)
                        .textFieldStyle(.plain)
                        .padding(.horizontal, 16)
                        .padding(.vertical, 12)
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(24)

                    // Send button
                    Button {
                        if !messageText.isEmpty {
                            performCustomQuery(messageText)
                            messageText = ""
                        }
                    } label: {
                        Image(systemName: "arrow.up")
                            .font(.body.weight(.semibold))
                            .foregroundStyle(.white)
                            .frame(width: 36, height: 36)
                            .background(messageText.isEmpty ? Color.gray : Color.black)
                            .clipShape(Circle())
                    }
                    .disabled(messageText.isEmpty)
                }

                // Quick action chip
                HStack {
                    Button {
                        performSummarize()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: "doc.text.magnifyingglass")
                                .font(.caption)
                            Text("Summarize")
                                .font(.caption.weight(.medium))
                        }
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                        .background(Color(.secondarySystemBackground))
                        .foregroundStyle(.primary)
                        .clipShape(Capsule())
                    }

                    Spacer()
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color(.systemBackground))
        }
        .background(Color(.systemBackground))
        .onDisappear {
            // Stop speech when leaving the view
            speechController.stop()
        }
    }

    private func performSummarize() {
        isLoading = true
        aiResponse = nil

        Task {
            do {
                guard let cloudService = TTSServiceFactory.listenAICloudService else {
                    throw ListenAICloudError.noAuthToken
                }

                let response = try await cloudService.summarize(
                    text: article.rawText,
                    action: .summarize
                )

                await MainActor.run {
                    aiResponse = response
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    aiResponse = generateFallback(error: error)
                    isLoading = false
                }
            }
        }
    }

    private func performCustomQuery(_ query: String) {
        isLoading = true
        aiResponse = nil

        Task {
            do {
                guard let cloudService = TTSServiceFactory.listenAICloudService else {
                    throw ListenAICloudError.noAuthToken
                }

                let response = try await cloudService.summarize(
                    text: article.rawText,
                    action: .custom,
                    customPrompt: query
                )

                await MainActor.run {
                    aiResponse = response
                    isLoading = false
                }
            } catch {
                await MainActor.run {
                    aiResponse = generateFallback(error: error)
                    isLoading = false
                }
            }
        }
    }

    private func generateFallback(error: Error) -> String {
        let wordCount = article.wordCount
        let readingTime = max(1, wordCount / 200)
        return "Unable to connect to AI service. This article \"\(article.displayTitle)\" contains approximately \(wordCount) words and would take about \(readingTime) minutes to read."
    }
}

// MARK: - AI Chat Quick Button

struct AIChatQuickButton: View {
    let title: String
    let icon: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: icon)
                    .font(.caption)
                Text(title)
                    .font(.caption.weight(.medium))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color(.secondarySystemBackground))
            .foregroundStyle(.primary)
            .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Source Type Color Extension

extension SourceType {
    var codableColor: CodableColor {
        switch self {
        case .web: return CodableColor(red: 0, green: 0.478, blue: 1)
        case .pdf: return CodableColor(red: 1, green: 0.231, blue: 0.188)
        case .clipboard: return CodableColor(red: 0.686, green: 0.322, blue: 0.871)
        case .file: return CodableColor(red: 1, green: 0.584, blue: 0)
        case .manual: return CodableColor(red: 0.298, green: 0.686, blue: 0.314)
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        ArticleReaderView(article: Article(
            sourceType: .web,
            title: "Sample Article",
            author: "John Doe",
            rawText: "Mainstream fail: Few Apple customers have turned store demos into Vision Pro sales.\n\nCredit: Cheng Xin/Getty Images\n\nThe new year has barely begun, and already we have a strong contender for our annual dead tech list, 2026 edition — the Apple Vision Pro.\n\nNot that the iPhone maker's Augmented Reality (AR) headset has passed on yet, exactly. The Apple Vision Pro (starting at $3,499) has been, to paraphrase Monty Python, just resting production at its Chinese manufacturer, Luxcorp.\n\nThat's according to analysts at International Data Corp, which estimates Apple only sold 4,500 headsets worldwide in the holiday quarter of 2025 — new M5 chip version (which is reportedly made in Vietnam) included.\n\nFor comparison, that's less than one-tenth of the half-million Vision Pros..."
        ))
        .environmentObject(AudioPlaybackService.shared)
        .environmentObject(QueueManager.shared)
    }
}
