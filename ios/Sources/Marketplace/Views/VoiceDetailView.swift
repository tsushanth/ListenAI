import SwiftUI
import AVFoundation

// MARK: - Voice Detail View

/// Detailed view for a shared voice with play preview, rating, and report options.
struct VoiceDetailView: View {
    @Environment(\.dismiss) private var dismiss
    let voice: VoiceMarketplaceService.SharedVoice

    @StateObject private var viewModel = VoiceDetailViewModel()
    @State private var showingRateSheet = false
    @State private var showingReportSheet = false
    @State private var showingUseConfirmation = false

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Header
                headerSection

                Divider()

                // Stats
                statsSection

                // Tags
                if !voice.tags.isEmpty {
                    tagsSection
                }

                // Description
                if let description = voice.description, !description.isEmpty {
                    descriptionSection(description)
                }

                Divider()

                // Actions
                actionsSection
            }
            .padding()
        }
        .navigationTitle("Voice Details")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button {
                    dismiss()
                }  label: {
                    Image(systemName: "xmark")
                        .font(.body)
                }
            }
        }
        .sheet(isPresented: $showingRateSheet) {
            RateVoiceSheet(voiceId: voice.id, voiceName: voice.displayName)
        }
        .sheet(isPresented: $showingReportSheet) {
            ReportVoiceSheet(voiceId: voice.id, voiceName: voice.displayName)
        }
        .alert("Use This Voice", isPresented: $showingUseConfirmation) {
            Button("Cancel", role: .cancel) {}
            Button("Use Voice") {
                useVoice()
            }
        } message: {
            Text("This will set \"\(voice.displayName)\" as your active voice for text-to-speech.")
        }
        .alert("Error", isPresented: $viewModel.showError) {
            Button("OK") {}
        } message: {
            Text(viewModel.errorMessage)
        }
    }

    // MARK: - Header Section

    private var headerSection: some View {
        VStack(spacing: 16) {
            // Avatar
            ZStack {
                Circle()
                    .fill(avatarGradient)
                    .frame(width: 100, height: 100)

                Image(systemName: "waveform")
                    .font(.system(size: 40))
                    .foregroundStyle(.white)
            }

            // Name
            VStack(spacing: 4) {
                HStack(spacing: 8) {
                    Text(voice.displayName)
                        .font(.title2.bold())

                    if voice.isOwn {
                        Text("YOUR VOICE")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 4)
                            .background(Color.blue)
                            .cornerRadius(4)
                    }
                }

                Text("Shared \(voice.createdAt.formatted(.relative(presentation: .named)))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Play button
            Button {
                Task { await viewModel.playPreview(voice) }
            } label: {
                HStack(spacing: 8) {
                    if viewModel.isLoading {
                        ProgressView()
                            .progressViewStyle(CircularProgressViewStyle(tint: .black))
                            .scaleEffect(0.8)
                    } else {
                        Image(systemName: viewModel.isPlaying ? "stop.fill" : "play.fill")
                            .font(.body.weight(.semibold))
                    }

                    Text(viewModel.isPlaying ? "Stop Preview" : "Play Preview")
                        .font(.body.weight(.semibold))
                }
                .foregroundStyle(.black)
                .padding(.horizontal, 32)
                .padding(.vertical, 14)
                .background(Color.yellow)
                .cornerRadius(25)
            }
            .disabled(voice.previewAudioUrl == nil)
        }
    }

    // MARK: - Stats Section

    private var statsSection: some View {
        HStack(spacing: 32) {
            // Rating
            VStack(spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: "star.fill")
                        .foregroundStyle(.yellow)
                    Text(String(format: "%.1f", voice.avgRating))
                        .font(.title2.bold())
                }
                Text("\(voice.ratingCount) ratings")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Divider
            Rectangle()
                .fill(Color(.separator))
                .frame(width: 1, height: 40)

            // Usage
            VStack(spacing: 4) {
                HStack(spacing: 4) {
                    Image(systemName: "play.fill")
                        .foregroundStyle(.blue)
                    Text("\(voice.usageCount)")
                        .font(.title2.bold())
                }
                Text("times used")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            // Duration
            if let duration = voice.previewDurationSec {
                Rectangle()
                    .fill(Color(.separator))
                    .frame(width: 1, height: 40)

                VStack(spacing: 4) {
                    HStack(spacing: 4) {
                        Image(systemName: "waveform")
                            .foregroundStyle(.purple)
                        Text("\(Int(duration))s")
                            .font(.title2.bold())
                    }
                    Text("sample")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 8)
    }

    // MARK: - Tags Section

    private var tagsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tags")
                .font(.headline)

            FlowLayout(spacing: 8) {
                ForEach(voice.tags, id: \.self) { tag in
                    Text(tag)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 6)
                        .background(Color(.tertiarySystemBackground))
                        .cornerRadius(12)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Description Section

    private func descriptionSection(_ description: String) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Description")
                .font(.headline)

            Text(description)
                .font(.body)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // MARK: - Actions Section

    private var actionsSection: some View {
        VStack(spacing: 12) {
            if !voice.isOwn {
                // Use this voice
                Button {
                    showingUseConfirmation = true
                } label: {
                    HStack {
                        Image(systemName: "waveform.badge.plus")
                        Text("Use This Voice")
                    }
                    .font(.headline)
                    .foregroundStyle(.white)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color.blue)
                    .cornerRadius(12)
                }

                HStack(spacing: 12) {
                    // Rate
                    Button {
                        showingRateSheet = true
                    } label: {
                        HStack {
                            Image(systemName: "star")
                            Text("Rate")
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.primary)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(10)
                    }

                    // Report
                    Button {
                        showingReportSheet = true
                    } label: {
                        HStack {
                            Image(systemName: "flag")
                            Text("Report")
                        }
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(.red)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 14)
                        .background(Color(.secondarySystemBackground))
                        .cornerRadius(10)
                    }
                }
            } else {
                Text("This is your shared voice")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
                    .background(Color(.secondarySystemBackground))
                    .cornerRadius(12)
            }
        }
    }

    // MARK: - Helpers

    private var avatarGradient: LinearGradient {
        let hash = voice.id.hashValue
        let hue = Double(abs(hash) % 360) / 360.0
        let color = Color(hue: hue, saturation: 0.6, brightness: 0.8)
        return LinearGradient(
            colors: [color, color.opacity(0.7)],
            startPoint: .topLeading,
            endPoint: .bottomTrailing
        )
    }

    private func useVoice() {
        // Create a VoicePreset from the shared voice and set it as active
        // This requires integration with VoicePresetManager
        // For now, we'll just show a success message
        // TODO: Actually set the voice as active
    }
}

// MARK: - Voice Detail View Model

@MainActor
class VoiceDetailViewModel: NSObject, ObservableObject, AVAudioPlayerDelegate {
    @Published var isLoading = false
    @Published var isPlaying = false
    @Published var showError = false
    @Published var errorMessage = ""

    private var audioPlayer: AVAudioPlayer?

    func playPreview(_ voice: VoiceMarketplaceService.SharedVoice) async {
        if isPlaying {
            stopPlayback()
            return
        }

        guard let urlString = voice.previewAudioUrl,
              let url = URL(string: urlString) else {
            errorMessage = "No preview available"
            showError = true
            return
        }

        isLoading = true

        do {
            try AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
            try AVAudioSession.sharedInstance().setActive(true)

            let (data, _) = try await URLSession.shared.data(from: url)

            let tempURL = FileManager.default.temporaryDirectory
                .appendingPathComponent("preview_\(voice.id).wav")
            try data.write(to: tempURL)

            audioPlayer = try AVAudioPlayer(contentsOf: tempURL)
            audioPlayer?.delegate = self
            audioPlayer?.prepareToPlay()
            audioPlayer?.play()

            isLoading = false
            isPlaying = true
        } catch {
            isLoading = false
            errorMessage = "Failed to play preview"
            showError = true
        }
    }

    func stopPlayback() {
        audioPlayer?.stop()
        audioPlayer = nil
        isPlaying = false
    }

    nonisolated func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        Task { @MainActor in
            self.isPlaying = false
        }
    }
}

// MARK: - Rate Voice Sheet

struct RateVoiceSheet: View {
    @Environment(\.dismiss) private var dismiss
    let voiceId: String
    let voiceName: String

    @State private var rating = 0
    @State private var review = ""
    @State private var isSubmitting = false
    @State private var showError = false
    @State private var errorMessage = ""

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 16) {
                        Text("Rate \"\(voiceName)\"")
                            .font(.headline)

                        // Star rating
                        HStack(spacing: 8) {
                            ForEach(1...5, id: \.self) { star in
                                Button {
                                    rating = star
                                } label: {
                                    Image(systemName: star <= rating ? "star.fill" : "star")
                                        .font(.title)
                                        .foregroundStyle(star <= rating ? .yellow : .secondary)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 8)
                }

                Section {
                    TextField("Write a review (optional)", text: $review, axis: .vertical)
                        .lineLimit(3...6)
                } header: {
                    Text("Review")
                }
            }
            .navigationTitle("Rate Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button("Submit") {
                        Task { await submitRating() }
                    }
                    .disabled(rating == 0 || isSubmitting)
                    .fontWeight(.semibold)
                }
            }
            .overlay {
                if isSubmitting {
                    Color.black.opacity(0.3)
                        .ignoresSafeArea()
                        .overlay(ProgressView())
                }
            }
            .alert("Error", isPresented: $showError) {
                Button("OK") {}
            } message: {
                Text(errorMessage)
            }
        }
    }

    private func submitRating() async {
        isSubmitting = true
        defer { isSubmitting = false }

        do {
            try await VoiceMarketplaceService.shared.rateVoice(
                id: voiceId,
                rating: rating,
                review: review.isEmpty ? nil : review
            )
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}

// MARK: - Report Voice Sheet

struct ReportVoiceSheet: View {
    @Environment(\.dismiss) private var dismiss
    let voiceId: String
    let voiceName: String

    @State private var selectedReason: VoiceMarketplaceService.ReportReason?
    @State private var description = ""
    @State private var isSubmitting = false
    @State private var showError = false
    @State private var errorMessage = ""
    @State private var showSuccess = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    ForEach(VoiceMarketplaceService.ReportReason.allCases, id: \.self) { reason in
                        Button {
                            selectedReason = reason
                        } label: {
                            HStack {
                                Text(reason.displayName)
                                    .foregroundStyle(.primary)

                                Spacer()

                                if selectedReason == reason {
                                    Image(systemName: "checkmark")
                                        .foregroundStyle(.blue)
                                }
                            }
                        }
                        .buttonStyle(.plain)
                    }
                } header: {
                    Text("Reason for Report")
                }

                Section {
                    TextField("Please provide details...", text: $description, axis: .vertical)
                        .lineLimit(4...8)
                } header: {
                    Text("Description")
                } footer: {
                    Text("Minimum 10 characters required.")
                }
            }
            .navigationTitle("Report Voice")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Button("Cancel") {
                        dismiss()
                    }
                }

                ToolbarItem(placement: .topBarTrailing) {
                    Button("Submit") {
                        Task { await submitReport() }
                    }
                    .disabled(selectedReason == nil || description.count < 10 || isSubmitting)
                    .fontWeight(.semibold)
                }
            }
            .overlay {
                if isSubmitting {
                    Color.black.opacity(0.3)
                        .ignoresSafeArea()
                        .overlay(ProgressView())
                }
            }
            .alert("Report Submitted", isPresented: $showSuccess) {
                Button("OK") { dismiss() }
            } message: {
                Text("Thank you for your report. We will review it and take appropriate action.")
            }
            .alert("Error", isPresented: $showError) {
                Button("OK") {}
            } message: {
                Text(errorMessage)
            }
        }
    }

    private func submitReport() async {
        guard let reason = selectedReason else { return }

        isSubmitting = true
        defer { isSubmitting = false }

        do {
            try await VoiceMarketplaceService.shared.reportVoice(
                id: voiceId,
                reason: reason,
                description: description
            )
            showSuccess = true
        } catch {
            errorMessage = error.localizedDescription
            showError = true
        }
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        VoiceDetailView(voice: VoiceMarketplaceService.SharedVoice(
            id: "test-id",
            displayName: "Test Voice",
            description: "A test voice for preview purposes.",
            tags: ["calm", "male", "narrator"],
            previewAudioUrl: nil,
            previewDurationSec: 10,
            usageCount: 42,
            avgRating: 4.5,
            ratingCount: 12,
            ownerUserId: "user-123",
            createdAt: Date(),
            isOwn: false
        ))
    }
}
