import SwiftUI

// MARK: - Share Voice View

/// View for sharing a cloned voice to the marketplace.
/// Requires authentication to share voices.
struct ShareVoiceView: View {
    @Environment(\.dismiss) private var dismiss
    @StateObject private var viewModel = ShareVoiceViewModel()
    @ObservedObject private var authService = AuthService.shared

    @State private var selectedVoice: VoiceCloningService.ClonedVoice?
    @State private var displayName = ""
    @State private var description = ""
    @State private var tagInput = ""
    @State private var tags: [String] = []
    @State private var acceptedTerms = false
    @State private var showingVoicePicker = false

    private let attestationText = "I confirm that this is my own voice or I have explicit permission from the voice owner to share it publicly. I understand that sharing someone else's voice without permission may result in removal and account suspension."

    var body: some View {
        shareVoiceContent
            .navigationTitle("Share Voice")
            .navigationBarTitleDisplayMode(.inline)
    }

    // MARK: - Share Voice Content (when authenticated)

    private var shareVoiceContent: some View {
        Form {
            // Voice selection
            voiceSelectionSection

            // Details
            if selectedVoice != nil {
                detailsSection
                tagsSection
                termsSection
            }
        }
        .toolbar {
            ToolbarItem(placement: .topBarLeading) {
                Button("Cancel") {
                    dismiss()
                }
            }

            ToolbarItem(placement: .topBarTrailing) {
                Button("Share") {
                    Task { await shareVoice() }
                }
                .disabled(!canShare)
                .fontWeight(.semibold)
            }
        }
        .task {
            await viewModel.loadClonedVoices()
        }
        .alert("Success", isPresented: $viewModel.showSuccess) {
            Button("OK") { dismiss() }
        } message: {
            Text("Your voice has been shared to the marketplace! Others can now discover and use it.")
        }
        .alert("Error", isPresented: $viewModel.showError) {
            Button("OK") {}
        } message: {
            Text(viewModel.errorMessage)
        }
        .overlay {
            if viewModel.isSharing {
                Color.black.opacity(0.3)
                    .ignoresSafeArea()
                    .overlay {
                        VStack(spacing: 16) {
                            ProgressView()
                            Text("Sharing voice...")
                                .font(.subheadline)
                                .foregroundStyle(.white)
                        }
                        .padding(24)
                        .background(Color(.systemBackground))
                        .cornerRadius(16)
                    }
            }
        }
    }

    // MARK: - Earnings Incentive Section

    private var earningsIncentiveSection: some View {
        Section {
            VStack(spacing: 16) {
                // Header with gift icon
                HStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(Color.green.opacity(0.15))
                            .frame(width: 48, height: 48)

                        Image(systemName: "gift.fill")
                            .font(.title2)
                            .foregroundStyle(.green)
                    }

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Earn Rewards")
                            .font(.headline)

                        Text("Get free minutes when others use your voice")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }

                    Spacer()
                }

                // Benefits list
                VStack(alignment: .leading, spacing: 8) {
                    EarningsBenefitRow(
                        icon: "waveform",
                        text: "Earn minutes every time someone generates audio with your voice"
                    )

                    EarningsBenefitRow(
                        icon: "arrow.up.right",
                        text: "Popular voices earn more - quality and uniqueness matter"
                    )

                    EarningsBenefitRow(
                        icon: "clock.arrow.circlepath",
                        text: "Rewards are credited automatically - claim anytime"
                    )
                }
            }
            .padding(.vertical, 8)
        }
    }

    // MARK: - Voice Selection Section

    private var voiceSelectionSection: some View {
        Section {
            if viewModel.isLoading {
                HStack {
                    Spacer()
                    ProgressView()
                    Spacer()
                }
                .padding(.vertical, 8)
            } else if viewModel.clonedVoices.isEmpty {
                VStack(spacing: 12) {
                    Image(systemName: "mic.slash")
                        .font(.title)
                        .foregroundStyle(.secondary)

                    Text("No Cloned Voices")
                        .font(.headline)

                    Text("Create a voice clone first before sharing.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 24)
            } else {
                ForEach(viewModel.clonedVoices) { voice in
                    VoiceSelectionRow(
                        voice: voice,
                        isSelected: selectedVoice?.id == voice.id,
                        isAlreadyShared: viewModel.sharedVoiceIds.contains(voice.id)
                    ) {
                        if !viewModel.sharedVoiceIds.contains(voice.id) {
                            selectedVoice = voice
                            displayName = voice.name
                        }
                    }
                }
            }
        } header: {
            Text("Select Voice")
        } footer: {
            if !viewModel.clonedVoices.isEmpty {
                Text("Choose which voice you want to share with the community.")
            }
        }
    }

    // MARK: - Details Section

    private var detailsSection: some View {
        Section {
            TextField("Display Name", text: $displayName)
                .textInputAutocapitalization(.words)

            TextField("Description (optional)", text: $description, axis: .vertical)
                .lineLimit(3...6)
        } header: {
            Text("Details")
        } footer: {
            Text("Give your voice a memorable name and describe its characteristics.")
        }
    }

    // MARK: - Tags Section

    private var tagsSection: some View {
        Section {
            // Tag input
            HStack {
                TextField("Add tag...", text: $tagInput)
                    .textInputAutocapitalization(.never)
                    .onSubmit {
                        addTag()
                    }

                Button("Add") {
                    addTag()
                }
                .disabled(tagInput.trimmingCharacters(in: .whitespaces).isEmpty || tags.count >= 10)
            }

            // Tag list
            if !tags.isEmpty {
                FlowLayout(spacing: 8) {
                    ForEach(tags, id: \.self) { tag in
                        TagChip(tag: tag) {
                            tags.removeAll { $0 == tag }
                        }
                    }
                }
                .padding(.vertical, 4)
            }

            // Suggested tags
            if tags.count < 5 {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Suggestions:")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    FlowLayout(spacing: 6) {
                        ForEach(suggestedTags, id: \.self) { tag in
                            Button {
                                if !tags.contains(tag) && tags.count < 10 {
                                    tags.append(tag)
                                }
                            } label: {
                                Text(tag)
                                    .font(.caption)
                                    .foregroundColor(tags.contains(tag) ? .secondary : .blue)
                                    .padding(.horizontal, 10)
                                    .padding(.vertical, 4)
                                    .background(Color(.tertiarySystemBackground))
                                    .cornerRadius(12)
                            }
                            .buttonStyle(.plain)
                            .disabled(tags.contains(tag))
                        }
                    }
                }
            }
        } header: {
            Text("Tags")
        } footer: {
            Text("Add up to 10 tags to help others find your voice.")
        }
    }

    // MARK: - Terms Section

    private var termsSection: some View {
        Section {
            VStack(alignment: .leading, spacing: 12) {
                Text("Terms & Conditions")
                    .font(.subheadline.weight(.semibold))

                Text(attestationText)
                    .font(.caption)
                    .foregroundStyle(.secondary)

                Toggle("I agree to the terms above", isOn: $acceptedTerms)
            }
            .padding(.vertical, 4)
        } header: {
            Text("Legal")
        }
    }

    // MARK: - Helpers

    private var suggestedTags: [String] {
        ["male", "female", "neutral", "calm", "energetic", "narrator", "character", "american", "british", "deep", "soft", "friendly"]
    }

    private var canShare: Bool {
        selectedVoice != nil &&
        !displayName.trimmingCharacters(in: .whitespaces).isEmpty &&
        acceptedTerms &&
        !viewModel.isSharing
    }

    private func addTag() {
        let tag = tagInput.trimmingCharacters(in: .whitespaces).lowercased()
        if !tag.isEmpty && !tags.contains(tag) && tags.count < 10 {
            tags.append(tag)
        }
        tagInput = ""
    }

    private func shareVoice() async {
        guard let voice = selectedVoice else { return }

        await viewModel.shareVoice(
            clonedVoiceId: voice.id,
            displayName: displayName.trimmingCharacters(in: .whitespaces),
            description: description.trimmingCharacters(in: .whitespaces),
            tags: tags,
            attestation: attestationText
        )
    }
}

// MARK: - Voice Selection Row

private struct VoiceSelectionRow: View {
    let voice: VoiceCloningService.ClonedVoice
    let isSelected: Bool
    let isAlreadyShared: Bool
    let onSelect: () -> Void

    var body: some View {
        Button(action: onSelect) {
            HStack(spacing: 12) {
                // Avatar
                RoundedRectangle(cornerRadius: 8)
                    .fill(Color(.systemGray5))
                    .frame(width: 44, height: 44)
                    .overlay {
                        Image(systemName: "person.fill")
                            .font(.title3)
                            .foregroundStyle(Color(.systemGray3))
                    }

                // Info
                VStack(alignment: .leading, spacing: 2) {
                    Text(voice.name)
                        .font(.body.weight(.medium))
                        .foregroundStyle(.primary)

                    if isAlreadyShared {
                        Text("Already shared")
                            .font(.caption)
                            .foregroundStyle(.orange)
                    } else if let duration = voice.durationSec {
                        Text("\(Int(duration))s sample")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }

                Spacer()

                // Selection indicator
                if isAlreadyShared {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.orange)
                } else if isSelected {
                    Image(systemName: "checkmark.circle.fill")
                        .foregroundStyle(.blue)
                } else {
                    Image(systemName: "circle")
                        .foregroundStyle(.secondary)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isAlreadyShared)
        .opacity(isAlreadyShared ? 0.6 : 1)
    }
}

// MARK: - Earnings Benefit Row

private struct EarningsBenefitRow: View {
    let icon: String
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: icon)
                .font(.caption)
                .foregroundStyle(.green)
                .frame(width: 16)

            Text(text)
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

// MARK: - Tag Chip

private struct TagChip: View {
    let tag: String
    let onRemove: () -> Void

    var body: some View {
        HStack(spacing: 4) {
            Text(tag)
                .font(.caption)

            Button(action: onRemove) {
                Image(systemName: "xmark.circle.fill")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color.blue.opacity(0.1))
        .foregroundStyle(.blue)
        .cornerRadius(12)
    }
}

// MARK: - Flow Layout

struct FlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let result = layout(proposal: proposal, subviews: subviews)
        return result.size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let result = layout(proposal: proposal, subviews: subviews)
        for (index, placement) in result.placements.enumerated() {
            subviews[index].place(at: CGPoint(x: bounds.minX + placement.x, y: bounds.minY + placement.y), proposal: .unspecified)
        }
    }

    private func layout(proposal: ProposedViewSize, subviews: Subviews) -> (size: CGSize, placements: [CGPoint]) {
        let maxWidth = proposal.width ?? .infinity
        var placements: [CGPoint] = []
        var currentX: CGFloat = 0
        var currentY: CGFloat = 0
        var lineHeight: CGFloat = 0

        for subview in subviews {
            let size = subview.sizeThatFits(.unspecified)

            if currentX + size.width > maxWidth && currentX > 0 {
                currentX = 0
                currentY += lineHeight + spacing
                lineHeight = 0
            }

            placements.append(CGPoint(x: currentX, y: currentY))
            currentX += size.width + spacing
            lineHeight = max(lineHeight, size.height)
        }

        let totalHeight = currentY + lineHeight
        return (CGSize(width: maxWidth, height: totalHeight), placements)
    }
}

// MARK: - View Model

@MainActor
class ShareVoiceViewModel: ObservableObject {
    @Published var clonedVoices: [VoiceCloningService.ClonedVoice] = []
    @Published var sharedVoiceIds: Set<String> = []
    @Published var isLoading = false
    @Published var isSharing = false
    @Published var showSuccess = false
    @Published var showError = false
    @Published var errorMessage = ""

    func loadClonedVoices() async {
        isLoading = true
        defer { isLoading = false }

        do {
            // Load cloned voices
            clonedVoices = try await VoiceCloningService.shared.listClonedVoices(forceRefresh: true)

            // Load already shared voices to disable them
            let myShares = try await VoiceMarketplaceService.shared.getMyShares()
            sharedVoiceIds = Set(myShares.filter { $0.status == "active" || $0.status == "pending_review" }.map { share in
                // We need to match by cloned_voice_id, but MySharedVoice doesn't have it
                // For now, we'll just track by display name as a workaround
                // TODO: Add cloned_voice_id to MySharedVoice response
                share.displayName
            })

            // Actually, let's load all shares and mark voices with matching names as shared
            // This is a temporary solution until we add cloned_voice_id to the response
            let shareNames = Set(myShares.filter { $0.status == "active" || $0.status == "pending_review" }.map { $0.displayName })
            sharedVoiceIds = Set(clonedVoices.filter { shareNames.contains($0.name) }.map { $0.id })
        } catch {
            // Silently fail - just show empty state
        }
    }

    func shareVoice(
        clonedVoiceId: String,
        displayName: String,
        description: String?,
        tags: [String],
        attestation: String
    ) async {
        isSharing = true
        defer { isSharing = false }

        do {
            _ = try await VoiceMarketplaceService.shared.shareVoice(
                clonedVoiceId: clonedVoiceId,
                displayName: displayName,
                description: description,
                tags: tags,
                attestation: attestation
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
        ShareVoiceView()
    }
}
