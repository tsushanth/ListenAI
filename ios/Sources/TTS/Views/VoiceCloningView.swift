import SwiftUI
import AVFoundation
import PhotosUI

// MARK: - Voice Cloning View

/// Main view for voice cloning - shows list of cloned voices or empty state.
/// Matches the reference design with empty state, voice list, and "Clone Voice" button.
struct VoiceCloningView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = VoiceCloningViewModel()
    @StateObject private var storeManager = StoreKitManager.shared
    @State private var showingCloneFlow = false
    @State private var showingUpgradePrompt = false
    @State private var isEditing = false

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if viewModel.isLoading {
                    Spacer()
                    ProgressView()
                    Spacer()
                } else if viewModel.clonedVoices.isEmpty {
                    // Empty state
                    emptyStateView
                } else {
                    // List of cloned voices
                    clonedVoicesListView
                }

                // Clone Voice Button
                Button {
                    startCloningFlow()
                } label: {
                    Text("Clone Voice")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 16)
                .background(Color(.systemBackground))
            }
            .navigationTitle("Voice Cloning")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button {
                        dismiss()
                    } label: {
                        Image(systemName: "chevron.left")
                            .font(.body.weight(.medium))
                            .foregroundStyle(.primary)
                            .padding(8)
                            .background(Color(.systemGray5))
                            .clipShape(Circle())
                    }
                }

                if !viewModel.clonedVoices.isEmpty {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(isEditing ? "Done" : "Edit") {
                            withAnimation {
                                isEditing.toggle()
                            }
                        }
                        .foregroundStyle(.orange)
                    }
                }
            }
            .task {
                await viewModel.loadVoices()
            }
            .refreshable {
                await viewModel.loadVoices()
            }
            .alert("Error", isPresented: $viewModel.showError) {
                Button("OK") {}
            } message: {
                Text(viewModel.errorMessage)
            }
            .fullScreenCover(isPresented: $showingCloneFlow) {
                VoiceCloningFlowView(onComplete: {
                    Task {
                        await viewModel.loadVoices()
                    }
                })
            }
            .sheet(isPresented: $showingUpgradePrompt) {
                VoiceCloningLimitView()
            }
        }
    }

    // MARK: - Empty State

    private var emptyStateView: some View {
        VStack(spacing: 24) {
            Spacer()

            // Microphone icon with waveform
            ZStack {
                Image(systemName: "mic.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(Color(.systemGray3))

                Image(systemName: "waveform")
                    .font(.system(size: 24))
                    .foregroundStyle(Color(.systemGray4))
                    .offset(x: 30, y: 10)
            }

            VStack(spacing: 8) {
                Text("No cloned voice here")
                    .font(.title2.bold())
                    .foregroundStyle(.primary)

                Text("You haven't created any voice clones yet.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Spacer()
        }
        .padding(.horizontal, 40)
    }

    // MARK: - Cloned Voices List

    private var clonedVoicesListView: some View {
        ScrollView {
            LazyVStack(spacing: 12) {
                ForEach(viewModel.clonedVoices) { voice in
                    ClonedVoiceCard(
                        voice: voice,
                        isPlaying: viewModel.playingVoiceId == voice.id && !viewModel.isPreviewLoading,
                        isLoading: viewModel.playingVoiceId == voice.id && viewModel.isPreviewLoading,
                        isEditing: isEditing,
                        onPreview: {
                            Task {
                                await viewModel.previewVoice(voice)
                            }
                        },
                        onDelete: {
                            Task {
                                await viewModel.deleteVoice(voice)
                            }
                        }
                    )
                }
            }
            .padding(.horizontal, 20)
            .padding(.vertical, 16)
        }
    }

    // MARK: - Actions

    private func startCloningFlow() {
        // Check if user can create more clones based on subscription
        let clonedCount = viewModel.clonedVoices.count
        let maxFreeClones = 0 // Free users get 0 clones
        let maxProClones = 10

        if !storeManager.isPremium && clonedCount >= maxFreeClones {
            showingUpgradePrompt = true
        } else if storeManager.isPremium && clonedCount >= maxProClones {
            viewModel.errorMessage = "You've reached the maximum number of voice clones (\(maxProClones))."
            viewModel.showError = true
        } else {
            showingCloneFlow = true
        }
    }
}

// MARK: - Cloned Voice Card

private struct ClonedVoiceCard: View {
    let voice: VoiceCloningService.ClonedVoice
    let isPlaying: Bool
    let isLoading: Bool
    let isEditing: Bool
    let onPreview: () -> Void
    let onDelete: () -> Void

    @State private var showDeleteConfirmation = false

    var body: some View {
        HStack(spacing: 16) {
            // Avatar placeholder
            RoundedRectangle(cornerRadius: 12)
                .fill(Color(.systemGray5))
                .frame(width: 64, height: 64)
                .overlay {
                    Image(systemName: "person.fill")
                        .font(.title)
                        .foregroundStyle(Color(.systemGray3))
                }

            // Voice info
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(voice.name)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)

                    Image(systemName: "mic.fill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(isLoading ? "Generating preview..." : "Cloned Voice • Multilingual")
                    .font(.caption)
                    .foregroundStyle(isLoading ? .orange : .secondary)

                // Waveform visualization
                HStack(spacing: 1) {
                    ForEach(0..<24, id: \.self) { index in
                        RoundedRectangle(cornerRadius: 0.5)
                            .fill(isLoading ? Color.orange : (isPlaying ? Color.yellow : Color(.systemGray4)))
                            .frame(width: 2, height: waveformHeight(for: index, isAnimating: isPlaying || isLoading))
                    }
                }
                .frame(height: 16)
                .animation(isPlaying || isLoading ? .easeInOut(duration: 0.3).repeatForever(autoreverses: true) : .default, value: isPlaying || isLoading)
            }

            Spacer()

            if isEditing {
                // Delete button when editing
                Button {
                    showDeleteConfirmation = true
                } label: {
                    Image(systemName: "trash.fill")
                        .font(.title3)
                        .foregroundStyle(.red)
                }
            } else {
                // Play button
                Button(action: onPreview) {
                    ZStack {
                        Circle()
                            .fill(Color.yellow)
                            .frame(width: 44, height: 44)

                        if isLoading {
                            ProgressView()
                                .progressViewStyle(CircularProgressViewStyle(tint: .black))
                                .scaleEffect(0.8)
                        } else {
                            Image(systemName: isPlaying ? "stop.fill" : "play.fill")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundStyle(.black)
                                .offset(x: isPlaying ? 0 : 2)
                        }
                    }
                }
                .buttonStyle(.plain)
                .disabled(isLoading)
            }
        }
        .padding(16)
        .background(Color(.secondarySystemBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .confirmationDialog("Delete Voice Clone?", isPresented: $showDeleteConfirmation, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                onDelete()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This will permanently delete '\(voice.name)'. This action cannot be undone.")
        }
    }

    private func waveformHeight(for index: Int, isAnimating: Bool = false) -> CGFloat {
        let heights: [CGFloat] = [6, 10, 14, 10, 8, 12, 16, 12, 8, 14, 10, 6, 8, 12, 10, 14, 8, 10, 12, 8, 6, 10, 8, 6]
        let baseHeight = heights[index % heights.count]
        if isAnimating {
            return baseHeight * CGFloat.random(in: 0.7...1.3)
        }
        return baseHeight
    }
}

// MARK: - Voice Cloning Limit View (Upgrade Prompt)

private struct VoiceCloningLimitView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var storeManager = StoreKitManager.shared
    @State private var showingUpgrade = false

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Lock icon with sparkles
            ZStack {
                // Sparkles
                ForEach(0..<6, id: \.self) { index in
                    Image(systemName: "sparkle")
                        .font(.caption)
                        .foregroundStyle(.yellow)
                        .offset(
                            x: CGFloat([-30, 30, -20, 25, -25, 20][index]),
                            y: CGFloat([-30, -25, 0, 0, 25, 30][index])
                        )
                }

                // Lock
                Image(systemName: "lock.fill")
                    .font(.system(size: 48))
                    .foregroundStyle(.yellow)
            }
            .padding(.vertical, 20)

            VStack(spacing: 12) {
                Text("You've reached the limit!")
                    .font(.title2.bold())
                    .foregroundStyle(.primary)

                Text("Voice cloning is a premium feature. Upgrade to PRO to create voice clones!")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 32)

            Spacer()

            VStack(spacing: 12) {
                Button {
                    showingUpgrade = true
                } label: {
                    Text("Upgrade Now!")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                Button {
                    dismiss()
                } label: {
                    Text("Cancel")
                        .font(.headline)
                        .foregroundStyle(.primary)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
        }
        .background(Color(.systemBackground))
        .sheet(isPresented: $showingUpgrade) {
            UpgradePromptView()
        }
        .onChange(of: storeManager.isPremium) { _, isPremium in
            // Auto-dismiss when user becomes premium (after purchase)
            if isPremium {
                dismiss()
            }
        }
    }
}

// MARK: - Voice Cloning Flow View

/// Full-screen flow for creating a voice clone.
/// Steps: Intro -> Profile Setup -> Recording -> Processing -> Success
struct VoiceCloningFlowView: View {
    let onComplete: () -> Void

    @Environment(\.dismiss) private var dismiss
    @StateObject private var flowViewModel = VoiceCloningFlowViewModel()
    @State private var showingImagePicker = false

    var body: some View {
        NavigationStack {
            Group {
                switch flowViewModel.currentStep {
                case .intro:
                    VoiceCloningIntroView(onContinue: {
                        withAnimation {
                            flowViewModel.currentStep = .profile
                        }
                    })

                case .profile:
                    VoiceProfileSetupView(
                        voiceName: $flowViewModel.voiceName,
                        selectedImage: $flowViewModel.profileImage,
                        showingImagePicker: $showingImagePicker,
                        onContinue: {
                            withAnimation {
                                flowViewModel.currentStep = .recording
                            }
                        }
                    )

                case .recording:
                    VoiceRecordingView(
                        recordingDuration: $flowViewModel.recordingDuration,
                        isRecording: $flowViewModel.isRecording,
                        recordedAudioURL: $flowViewModel.recordedAudioURL,
                        isPaused: flowViewModel.isPaused,
                        onStartRecording: { flowViewModel.startRecording() },
                        onStopRecording: { flowViewModel.stopRecording() },
                        onPauseRecording: { flowViewModel.pauseRecording() },
                        onResumeRecording: { flowViewModel.resumeRecording() },
                        onContinue: {
                            Task {
                                await flowViewModel.createClone()
                            }
                        }
                    )

                case .processing:
                    VoiceCloningProgressView()

                case .success:
                    VoiceCloningSuccessView(
                        voiceName: flowViewModel.voiceName,
                        onDone: {
                            onComplete()
                            dismiss()
                        }
                    )

                case .error:
                    VoiceCloningErrorView(
                        errorMessage: flowViewModel.errorMessage,
                        onRetry: {
                            withAnimation {
                                flowViewModel.currentStep = .recording
                            }
                        },
                        onCancel: {
                            dismiss()
                        }
                    )
                }
            }
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    if flowViewModel.currentStep != .processing && flowViewModel.currentStep != .success {
                        Button {
                            if flowViewModel.currentStep == .intro {
                                dismiss()
                            } else {
                                withAnimation {
                                    flowViewModel.goBack()
                                }
                            }
                        } label: {
                            Image(systemName: "chevron.left")
                                .font(.body.weight(.medium))
                                .foregroundStyle(.primary)
                                .padding(8)
                                .background(Color(.systemGray5))
                                .clipShape(Circle())
                        }
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    if flowViewModel.currentStep != .processing && flowViewModel.currentStep != .success {
                        Button {
                            dismiss()
                        } label: {
                            Image(systemName: "xmark")
                                .font(.body.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
            .onChange(of: flowViewModel.cloneCreated) { _, created in
                if created {
                    withAnimation {
                        flowViewModel.currentStep = .success
                    }
                }
            }
            .onChange(of: flowViewModel.isCreating) { _, isCreating in
                if isCreating {
                    withAnimation {
                        flowViewModel.currentStep = .processing
                    }
                }
            }
            .sheet(isPresented: $showingImagePicker) {
                ImagePicker(image: $flowViewModel.profileImage)
            }
        }
    }
}

// MARK: - Voice Cloning Intro View

private struct VoiceCloningIntroView: View {
    let onContinue: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            // Header illustration
            ZStack {
                // Gradient background
                LinearGradient(
                    colors: [Color.orange.opacity(0.3), Color.purple.opacity(0.3)],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing
                )
                .frame(height: 200)

                // Waveform visualization
                HStack(spacing: 4) {
                    ForEach(0..<20, id: \.self) { index in
                        RoundedRectangle(cornerRadius: 2)
                            .fill(Color.orange.opacity(0.6))
                            .frame(width: 4, height: waveformHeight(for: index))
                    }
                }

                // Face silhouette
                Image(systemName: "person.crop.circle")
                    .font(.system(size: 80))
                    .foregroundStyle(.white.opacity(0.8))
            }

            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    // Title
                    VStack(alignment: .leading, spacing: 8) {
                        Text("INTRODUCE")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                            .tracking(1)

                        Text("Voice Cloning")
                            .font(.largeTitle.bold())
                            .foregroundStyle(.primary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)

                    // Features
                    VStack(alignment: .leading, spacing: 20) {
                        FeatureRow(
                            icon: "mic.fill",
                            title: "Clone your voice by recording audio"
                        )

                        FeatureRow(
                            icon: "waveform.circle.fill",
                            title: "Listen your content in any voice you've cloned."
                        )

                        FeatureRow(
                            icon: "checkmark.shield.fill",
                            title: "Stored securely, never shared, and deletable whenever you want."
                        )
                    }

                    // Consent text
                    Text("By continuing, you agree to the collection and use of your voice for the purpose of creating a digital voice clone. Your recordings may be stored and processed")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.top, 16)
                }
                .padding(.horizontal, 24)
                .padding(.top, 24)
            }

            // Continue button
            Button(action: onContinue) {
                Text("Agree & Continue")
                    .font(.headline)
                    .foregroundStyle(.black)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color.yellow)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
        }
        .background(Color(.systemBackground))
    }

    private func waveformHeight(for index: Int) -> CGFloat {
        let heights: [CGFloat] = [20, 35, 50, 40, 25, 45, 60, 45, 30, 50, 40, 25, 35, 55, 40, 30, 45, 35, 25, 40]
        return heights[index % heights.count]
    }
}

private struct FeatureRow: View {
    let icon: String
    let title: String

    var body: some View {
        HStack(alignment: .top, spacing: 16) {
            Image(systemName: icon)
                .font(.title2)
                .foregroundStyle(.primary)
                .frame(width: 28)

            Text(title)
                .font(.body)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Voice Profile Setup View

private struct VoiceProfileSetupView: View {
    @Binding var voiceName: String
    @Binding var selectedImage: UIImage?
    @Binding var showingImagePicker: Bool
    let onContinue: () -> Void

    private var canContinue: Bool {
        !voiceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        VStack(spacing: 0) {
            // Progress bar
            ProgressBar(progress: 0.33)
                .padding(.horizontal, 60)
                .padding(.top, 8)

            ScrollView {
                VStack(spacing: 32) {
                    // Title
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Create voice profile")
                            .font(.title.bold())
                            .foregroundStyle(.primary)

                        Text("We need this data to create better results.")
                            .font(.body)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 24)

                    // Profile image
                    Button {
                        showingImagePicker = true
                    } label: {
                        ZStack(alignment: .bottomTrailing) {
                            if let image = selectedImage {
                                Image(uiImage: image)
                                    .resizable()
                                    .scaledToFill()
                                    .frame(width: 140, height: 140)
                                    .clipShape(RoundedRectangle(cornerRadius: 20))
                            } else {
                                RoundedRectangle(cornerRadius: 20)
                                    .fill(Color(.systemGray5))
                                    .frame(width: 140, height: 140)
                                    .overlay {
                                        Image(systemName: "person.fill")
                                            .font(.system(size: 48))
                                            .foregroundStyle(Color(.systemGray3))
                                    }
                            }

                            // Camera button
                            Circle()
                                .fill(Color.black)
                                .frame(width: 36, height: 36)
                                .overlay {
                                    Image(systemName: "camera.fill")
                                        .font(.system(size: 14))
                                        .foregroundStyle(.white)
                                }
                                .offset(x: 4, y: 4)
                        }
                    }
                    .buttonStyle(.plain)

                    // Voice name input
                    VStack(alignment: .leading, spacing: 8) {
                        TextField("Voice Name", text: $voiceName)
                            .font(.body)
                            .padding()
                            .background(Color(.systemGray6))
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    Spacer(minLength: 100)
                }
                .padding(.horizontal, 24)
            }

            // Continue button
            Button(action: onContinue) {
                Text("Continue")
                    .font(.headline)
                    .foregroundStyle(canContinue ? .white : .secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(canContinue ? Color.black : Color(.systemGray4))
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(!canContinue)
            .padding(.horizontal, 24)
            .padding(.vertical, 16)
        }
        .background(Color(.systemBackground))
    }
}

// MARK: - Voice Recording View

private struct VoiceRecordingView: View {
    @Binding var recordingDuration: TimeInterval
    @Binding var isRecording: Bool
    @Binding var recordedAudioURL: URL?
    let isPaused: Bool
    let onStartRecording: () -> Void
    let onStopRecording: () -> Void
    let onPauseRecording: () -> Void
    let onResumeRecording: () -> Void
    let onContinue: () -> Void

    private let sampleParagraphs = [
        "Welcome to ReadAloud. I'm recording my voice so the app can create a personalized voice clone that sounds just like me. This is an exciting feature that uses advanced artificial intelligence to capture the unique qualities of my voice.",

        "The technology behind voice cloning analyzes the patterns, tone, and rhythm of my speech. It learns how I pronounce different words, the natural pauses I make, and the emotional qualities that make my voice distinctive.",

        "Reading aloud has always been a wonderful way to enjoy content. Whether it's news articles, blog posts, research papers, or even emails, having them read in a familiar voice makes the experience so much more personal and engaging.",

        "I particularly enjoy listening to content during my morning commute, while exercising, or when my eyes need a rest from screens. The ability to have any text converted to natural-sounding speech has changed how I consume information.",

        "With my own voice clone, I can now listen to my favorite content as if I were reading it to myself. It's like having a personal narrator who speaks exactly how I would. This makes long documents feel less like a chore and more like a conversation.",

        "Thank you for letting me be part of this amazing technology. I'm looking forward to hearing my cloned voice bring articles and stories to life."
    ]

    /// Minimum duration required to continue (matches ElevenLabs minimum)
    private let minimumDuration: TimeInterval = 30
    /// Recommended duration for best quality
    private let recommendedDuration: TimeInterval = 60

    /// Reading speed in words per second (~90 words per minute = 1.5 wps for comfortable reading aloud)
    private let wordsPerSecond: Double = 1.5

    private var canContinue: Bool {
        recordedAudioURL != nil && recordingDuration >= minimumDuration
    }

    private var isRecommendedDuration: Bool {
        recordingDuration >= recommendedDuration
    }

    /// All words across all paragraphs for global word index calculation
    private var allWords: [String] {
        sampleParagraphs.flatMap { $0.components(separatedBy: " ").filter { !$0.isEmpty } }
    }

    /// Calculate which word should currently be highlighted based on recording duration
    private var currentWordIndex: Int {
        guard isRecording && !isPaused else { return -1 }
        return min(Int(recordingDuration * wordsPerSecond), allWords.count - 1)
    }

    /// Calculate which paragraph we're currently in based on word index
    private var currentParagraphIndex: Int {
        guard currentWordIndex >= 0 else { return 0 }
        var wordCount = 0
        for (index, paragraph) in sampleParagraphs.enumerated() {
            let paragraphWordCount = paragraph.components(separatedBy: " ").filter { !$0.isEmpty }.count
            wordCount += paragraphWordCount
            if currentWordIndex < wordCount {
                return index
            }
        }
        return sampleParagraphs.count - 1
    }

    var body: some View {
        VStack(spacing: 0) {
            // Progress bar
            ProgressBar(progress: 0.66)
                .padding(.horizontal, 60)
                .padding(.top, 8)

            ScrollViewReader { proxy in
                ScrollView {
                    VStack(spacing: 24) {
                        // Title
                        VStack(alignment: .leading, spacing: 8) {
                            Text("Record your voice")
                                .font(.title.bold())
                                .foregroundStyle(.primary)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.top, 24)

                        // Instructions banner
                        HStack(spacing: 12) {
                            Image(systemName: "info.circle.fill")
                                .foregroundStyle(.orange)

                            Text("Record at least **30 seconds** (60+ recommended for best quality). Read naturally in any language you're comfortable with.")
                                .font(.caption)
                                .foregroundStyle(.primary)
                        }
                        .padding()
                        .background(Color.yellow.opacity(0.2))
                        .clipShape(RoundedRectangle(cornerRadius: 12))

                        // Sample text with paragraph-based highlighting
                        HighlightedParagraphsView(
                            paragraphs: sampleParagraphs,
                            currentWordIndex: currentWordIndex
                        )
                        .frame(maxWidth: .infinity, alignment: .leading)

                        Spacer(minLength: 100)
                    }
                    .padding(.horizontal, 24)
                }
                .onChange(of: currentParagraphIndex) { oldParagraph, newParagraph in
                    // Scroll when we move to a new paragraph
                    if newParagraph > oldParagraph {
                        withAnimation(.easeInOut(duration: 0.4)) {
                            proxy.scrollTo("paragraph-\(newParagraph)", anchor: .top)
                        }
                    }
                }
            }

            // Recording controls
            VStack(spacing: 16) {
                // Timer
                Text(formatDuration(recordingDuration))
                    .font(.title3.monospacedDigit())
                    .foregroundStyle(isRecording && !isPaused ? .red : .secondary)

                if isRecording && !isPaused {
                    // Waveform animation
                    RecordingWaveform()
                        .frame(height: 24)
                } else if isPaused {
                    Text("Recording paused")
                        .font(.caption)
                        .foregroundStyle(.orange)
                } else {
                    Text("Tap to start record")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                // Record button
                HStack(spacing: 24) {
                    if isRecording {
                        // Pause/Resume button
                        Button {
                            if isPaused {
                                onResumeRecording()
                            } else {
                                onPauseRecording()
                            }
                        } label: {
                            Image(systemName: isPaused ? "play.fill" : "pause.fill")
                                .font(.title2)
                                .foregroundStyle(isPaused ? .white : .primary)
                                .frame(width: 56, height: 56)
                                .background(isPaused ? Color.orange : Color(.systemGray5))
                                .clipShape(Circle())
                        }

                        // Stop button
                        Button(action: onStopRecording) {
                            Image(systemName: "stop.fill")
                                .font(.title2)
                                .foregroundStyle(.white)
                                .frame(width: 56, height: 56)
                                .background(Color.red)
                                .clipShape(Circle())
                        }
                    } else {
                        // Record button
                        Button(action: onStartRecording) {
                            ZStack {
                                Circle()
                                    .fill(Color.yellow)
                                    .frame(width: 72, height: 72)

                                Image(systemName: "mic.fill")
                                    .font(.title)
                                    .foregroundStyle(.black)
                            }
                        }
                    }
                }

                // Continue button (when recording is done)
                if canContinue && !isRecording {
                    VStack(spacing: 8) {
                        if !isRecommendedDuration {
                            Text("Longer recordings produce better voice clones")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }

                        Button(action: onContinue) {
                            Text(isRecommendedDuration ? "Continue" : "Continue Anyway")
                                .font(.headline)
                                .foregroundStyle(.white)
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 16)
                                .background(isRecommendedDuration ? Color.black : Color.gray)
                                .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                    }
                    .padding(.horizontal, 24)
                }
            }
            .padding(.vertical, 24)
        }
        .background(Color(.systemBackground))
    }

    private func formatDuration(_ duration: TimeInterval) -> String {
        let minutes = Int(duration) / 60
        let seconds = Int(duration) % 60
        return String(format: "%d:%02d", minutes, seconds)
    }
}

// MARK: - Highlighted Paragraphs View

/// Displays paragraphs with word-by-word highlighting, preserving paragraph structure
private struct HighlightedParagraphsView: View {
    let paragraphs: [String]
    let currentWordIndex: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            ForEach(Array(paragraphs.enumerated()), id: \.offset) { index, paragraph in
                Text(attributedTextForParagraph(paragraph, paragraphIndex: index))
                    .font(.body)
                    .lineSpacing(6)
                    .id("paragraph-\(index)")
            }
        }
    }

    /// Calculate the global word index offset for a given paragraph
    private func wordOffsetForParagraph(_ paragraphIndex: Int) -> Int {
        var offset = 0
        for i in 0..<paragraphIndex {
            offset += paragraphs[i].components(separatedBy: " ").filter { !$0.isEmpty }.count
        }
        return offset
    }

    /// Get attributed text for a specific paragraph with highlighting
    private func attributedTextForParagraph(_ paragraph: String, paragraphIndex: Int) -> AttributedString {
        var result = AttributedString()
        let words = paragraph.components(separatedBy: " ").filter { !$0.isEmpty }
        let offset = wordOffsetForParagraph(paragraphIndex)

        for (localIndex, word) in words.enumerated() {
            let globalIndex = offset + localIndex
            var wordAttr = AttributedString(word)
            let isHighlighted = globalIndex <= currentWordIndex && currentWordIndex >= 0
            let isCurrentWord = globalIndex == currentWordIndex

            if isCurrentWord {
                wordAttr.backgroundColor = .yellow
                wordAttr.foregroundColor = .black
            } else if isHighlighted {
                // Use a lighter yellow for already-read words
                wordAttr.backgroundColor = Color(red: 1.0, green: 1.0, blue: 0.6)
                wordAttr.foregroundColor = .black
            }

            result.append(wordAttr)

            // Add space after word (except last in paragraph)
            if localIndex < words.count - 1 {
                result.append(AttributedString(" "))
            }
        }

        return result
    }
}

// MARK: - Recording Waveform Animation

private struct RecordingWaveform: View {
    @State private var animationPhase: Double = 0

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<20, id: \.self) { index in
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.green)
                    .frame(width: 4, height: barHeight(for: index))
                    .animation(
                        .easeInOut(duration: 0.3)
                        .repeatForever(autoreverses: true)
                        .delay(Double(index) * 0.05),
                        value: animationPhase
                    )
            }
        }
        .onAppear {
            animationPhase = 1
        }
    }

    private func barHeight(for index: Int) -> CGFloat {
        let base: CGFloat = 8
        let variation = sin(Double(index) + animationPhase * .pi) * 8
        let height = base + CGFloat(variation)
        // Ensure the height is a valid finite value
        guard height.isFinite else { return base }
        return max(4, height)
    }
}

// MARK: - Voice Cloning Progress View

private struct VoiceCloningProgressView: View {
    @State private var rotation: Double = 0

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Animated infinity symbol
            ZStack {
                // Infinity shape animation
                Image(systemName: "infinity")
                    .font(.system(size: 80, weight: .light))
                    .foregroundStyle(Color.yellow)
                    .rotationEffect(.degrees(rotation))
            }
            .onAppear {
                withAnimation(.linear(duration: 3).repeatForever(autoreverses: false)) {
                    rotation = 360
                }
            }

            Text("Cloning your voice...")
                .font(.title2.weight(.medium))
                .foregroundStyle(.primary)

            Text("This may take a moment")
                .font(.body)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .background(Color(.systemBackground))
    }
}

// MARK: - Voice Cloning Success View

private struct VoiceCloningSuccessView: View {
    let voiceName: String
    let onDone: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Success icon
            ZStack {
                Circle()
                    .fill(Color.green.opacity(0.15))
                    .frame(width: 100, height: 100)

                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 60))
                    .foregroundStyle(.green)
            }

            VStack(spacing: 8) {
                Text("Voice Clone Created!")
                    .font(.title2.bold())
                    .foregroundStyle(.primary)

                Text("'\(voiceName)' is now ready to use.")
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
            }

            Spacer()

            Button(action: onDone) {
                Text("Done")
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color.black)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
        }
        .background(Color(.systemBackground))
    }
}

// MARK: - Voice Cloning Error View

private struct VoiceCloningErrorView: View {
    let errorMessage: String
    let onRetry: () -> Void
    let onCancel: () -> Void

    var body: some View {
        VStack(spacing: 24) {
            Spacer()

            // Error icon
            ZStack {
                Circle()
                    .fill(Color.red.opacity(0.15))
                    .frame(width: 100, height: 100)

                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 50))
                    .foregroundStyle(.red)
            }

            VStack(spacing: 8) {
                Text("Cloning Failed")
                    .font(.title2.bold())
                    .foregroundStyle(.primary)

                Text(errorMessage)
                    .font(.body)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 32)
            }

            Spacer()

            VStack(spacing: 12) {
                Button(action: onRetry) {
                    Text("Try Again")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 16)
                        .background(Color.black)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                }

                Button(action: onCancel) {
                    Text("Cancel")
                        .font(.headline)
                        .foregroundStyle(.primary)
                }
            }
            .padding(.horizontal, 24)
            .padding(.bottom, 32)
        }
        .background(Color(.systemBackground))
    }
}

// MARK: - Progress Bar

private struct ProgressBar: View {
    let progress: Double

    /// Safely bounded progress value
    private var safeProgress: Double {
        let value = progress.isNaN || progress.isInfinite ? 0 : progress
        return min(max(value, 0), 1)
    }

    var body: some View {
        GeometryReader { geometry in
            let safeWidth = geometry.size.width.isFinite ? geometry.size.width : 0
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 2)
                    .fill(Color(.systemGray5))
                    .frame(height: 4)

                RoundedRectangle(cornerRadius: 2)
                    .fill(Color.yellow)
                    .frame(width: safeWidth * safeProgress, height: 4)
            }
        }
        .frame(height: 4)
    }
}

// MARK: - Image Picker

private struct ImagePicker: UIViewControllerRepresentable {
    @Binding var image: UIImage?
    @Environment(\.dismiss) private var dismiss

    func makeUIViewController(context: Context) -> PHPickerViewController {
        var config = PHPickerConfiguration()
        config.filter = .images
        config.selectionLimit = 1

        let picker = PHPickerViewController(configuration: config)
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ uiViewController: PHPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(self)
    }

    class Coordinator: NSObject, PHPickerViewControllerDelegate {
        let parent: ImagePicker

        init(_ parent: ImagePicker) {
            self.parent = parent
        }

        func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
            parent.dismiss()

            guard let provider = results.first?.itemProvider,
                  provider.canLoadObject(ofClass: UIImage.self) else { return }

            provider.loadObject(ofClass: UIImage.self) { [weak self] image, _ in
                DispatchQueue.main.async {
                    self?.parent.image = image as? UIImage
                }
            }
        }
    }
}

// MARK: - View Models

@MainActor
class VoiceCloningViewModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var clonedVoices: [VoiceCloningService.ClonedVoice] = []
    @Published var isLoading = false
    @Published var showError = false
    @Published var errorMessage = ""
    @Published var playingVoiceId: String?
    @Published var isPreviewLoading = false

    private var audioPlayer: AVAudioPlayer?
    private var previewTask: Task<Void, Never>?

    /// Sample text for cloned voice preview synthesis
    private let sampleText = "Hello, this is a preview of your cloned voice. I can read your articles with this unique sound."

    /// Local cache directory for cloned voice previews
    private var previewCacheDirectory: URL {
        let cacheDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let previewDir = cacheDir.appendingPathComponent("cloned_voice_previews", isDirectory: true)
        try? FileManager.default.createDirectory(at: previewDir, withIntermediateDirectories: true)
        return previewDir
    }

    override init() {
        super.init()
    }

    func loadVoices() async {
        isLoading = true
        defer { isLoading = false }

        do {
            clonedVoices = try await VoiceCloningService.shared.listClonedVoices(forceRefresh: true)
        } catch {
            // Don't show error for not configured - just show empty state
            if case VoiceCloningService.VoiceCloningError.notConfigured = error {
                clonedVoices = []
            } else {
                errorMessage = error.localizedDescription
                showError = true
            }
        }
    }

    /// Preview a cloned voice - uses cached audio if available, otherwise synthesizes and caches
    func previewVoice(_ voice: VoiceCloningService.ClonedVoice) async {
        if playingVoiceId == voice.id {
            stopPreview()
            return
        }

        stopPreview()
        playingVoiceId = voice.id

        // Check for cached preview first
        let cachedURL = getCachedPreviewURL(for: voice.id)
        if FileManager.default.fileExists(atPath: cachedURL.path) {
            // Play from cache - no loading needed
            do {
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
                try? AVAudioSession.sharedInstance().setActive(true)

                audioPlayer = try AVAudioPlayer(contentsOf: cachedURL)
                audioPlayer?.delegate = self
                audioPlayer?.prepareToPlay()
                audioPlayer?.play()
                return
            } catch {
                // Cache file might be corrupted, delete and re-synthesize
                try? FileManager.default.removeItem(at: cachedURL)
            }
        }

        // No cached preview - synthesize and cache
        isPreviewLoading = true

        previewTask = Task {
            do {
                // Configure audio session
                try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
                try? AVAudioSession.sharedInstance().setActive(true)

                // Synthesize sample text using the cloned voice
                let audioURL = try await synthesizeClonedVoicePreview(voiceId: voice.id)

                if Task.isCancelled { return }

                // Copy to cache for future use
                try? FileManager.default.copyItem(at: audioURL, to: cachedURL)

                audioPlayer = try AVAudioPlayer(contentsOf: audioURL)
                audioPlayer?.delegate = self
                audioPlayer?.prepareToPlay()
                audioPlayer?.play()

                await MainActor.run {
                    isPreviewLoading = false
                }
            } catch {
                await MainActor.run {
                    isPreviewLoading = false
                    playingVoiceId = nil
                    errorMessage = "Failed to preview voice: \(error.localizedDescription)"
                    showError = true
                }
            }
        }
    }

    /// Get the cached preview URL for a voice ID
    private func getCachedPreviewURL(for voiceId: String) -> URL {
        previewCacheDirectory.appendingPathComponent("preview_\(voiceId).mp3")
    }

    /// Clear cached preview for a voice (call when voice is deleted or updated)
    func clearCachedPreview(for voiceId: String) {
        let cachedURL = getCachedPreviewURL(for: voiceId)
        try? FileManager.default.removeItem(at: cachedURL)
    }

    /// Synthesize sample text using a cloned voice
    private func synthesizeClonedVoicePreview(voiceId: String) async throws -> URL {
        let coordinator = TTSCoordinator.shared

        // Create a temporary voice preset for the cloned voice
        let tempPreset = VoicePreset(
            name: "Preview",
            isBuiltIn: false,
            isCharacterVoice: false,
            provider: .elevenLabs,
            providerVoiceID: voiceId,
            providerModelID: "eleven_multilingual_v2",
            language: "en-US",
            supportedLanguages: ["en-US"],
            gender: .neutral,
            age: .adult,
            style: .conversational,
            category: .custom,
            voiceDescription: "Cloned voice preview",
            tier: .premium,
            sampleText: sampleText
        )

        // Synthesize the sample text using premium quality (ElevenLabs) since it's a cloned voice
        let audioURL = try await coordinator.synthesizeWithQuality(
            text: sampleText,
            voice: tempPreset,
            quality: .premium
        )

        return audioURL
    }

    func stopPreview() {
        previewTask?.cancel()
        previewTask = nil
        audioPlayer?.stop()
        audioPlayer = nil
        playingVoiceId = nil
        isPreviewLoading = false
    }

    // MARK: - AVAudioPlayerDelegate

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.playingVoiceId = nil
        }
    }

    nonisolated func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        Task { @MainActor in
            self.playingVoiceId = nil
        }
    }

    func deleteVoice(_ voice: VoiceCloningService.ClonedVoice) async {
        do {
            try await VoiceCloningService.shared.deleteClonedVoice(voice.id)
            clonedVoices.removeAll { $0.id == voice.id }
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}

enum VoiceCloningStep {
    case intro
    case profile
    case recording
    case processing
    case success
    case error
}

@MainActor
class VoiceCloningFlowViewModel: ObservableObject {
    @Published var currentStep: VoiceCloningStep = .intro
    @Published var voiceName = ""
    @Published var profileImage: UIImage?
    @Published var isRecording = false
    @Published var isPaused = false
    @Published var recordingDuration: TimeInterval = 0
    @Published var recordedAudioURL: URL?
    @Published var isCreating = false
    @Published var cloneCreated = false
    @Published var errorMessage = ""

    private var audioRecorder: AVAudioRecorder?
    private var recordingTimer: Timer?

    func goBack() {
        switch currentStep {
        case .profile:
            currentStep = .intro
        case .recording:
            currentStep = .profile
        case .error:
            currentStep = .recording
        default:
            break
        }
    }

    func startRecording() {
        let audioSession = AVAudioSession.sharedInstance()

        do {
            try audioSession.setCategory(.playAndRecord, mode: .default)
            try audioSession.setActive(true)

            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("voice_clone_\(UUID().uuidString).m4a")

            let settings: [String: Any] = [
                AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
                AVSampleRateKey: 44100.0,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue
            ]

            audioRecorder = try AVAudioRecorder(url: tempURL, settings: settings)
            audioRecorder?.record()
            isRecording = true
            isPaused = false
            recordingDuration = 0
            recordedAudioURL = tempURL

            startTimer()

        } catch {
            errorMessage = "Failed to start recording: \(error.localizedDescription)"
            currentStep = .error
        }
    }

    func pauseRecording() {
        audioRecorder?.pause()
        isPaused = true
        recordingTimer?.invalidate()
        recordingTimer = nil
    }

    func resumeRecording() {
        audioRecorder?.record()
        isPaused = false
        startTimer()
    }

    func stopRecording() {
        audioRecorder?.stop()
        isRecording = false
        isPaused = false
        recordingTimer?.invalidate()
        recordingTimer = nil
    }

    private func startTimer() {
        recordingTimer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.recordingDuration += 0.1
            }
        }
    }

    func createClone() async {
        guard let audioURL = recordedAudioURL else { return }

        isCreating = true

        do {
            _ = try await VoiceCloningService.shared.createInstantClone(
                name: voiceName.trimmingCharacters(in: .whitespacesAndNewlines),
                audioSampleURL: audioURL
            )
            cloneCreated = true
        } catch {
            isCreating = false
            errorMessage = error.localizedDescription
            currentStep = .error
        }
    }

    func cleanup() {
        audioRecorder?.stop()
        recordingTimer?.invalidate()

        if let url = recordedAudioURL {
            try? FileManager.default.removeItem(at: url)
        }
    }

    deinit {
        recordingTimer?.invalidate()
    }
}

// MARK: - Preview

#Preview {
    VoiceCloningView()
}
