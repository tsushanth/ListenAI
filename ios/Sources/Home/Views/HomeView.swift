import SwiftUI

// MARK: - Home View

/// Main home screen with welcome message and quick action cards for importing content.
struct HomeView: View {
    @EnvironmentObject var playbackService: AudioPlaybackService
    @EnvironmentObject var queueManager: QueueManager
    @Environment(\.colorScheme) private var colorScheme
    private var premiumManager: PremiumManager { PremiumManager.shared }

    @State private var showingImportSheet = false
    @State private var selectedImportType: ImportType?
    @State private var showUpgradeSheet = false

    var body: some View {
        ScrollView {
            VStack(spacing: 24) {
                // Promotional Banner (hide for premium users)
                if !premiumManager.isPremium {
                    promoBanner
                }

                // Quick Actions Section with header
                quickActionsSection
            }
            .padding()
        }
        .background(Color(.systemGroupedBackground))
        .navigationTitle("")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                ProBadgeButton()
            }
        }
        .sheet(item: $selectedImportType) { importType in
            ImportSheetView(initialType: importType)
        }
        .onChange(of: selectedImportType) { _, newValue in
            // Reset mini player visibility when import sheet is dismissed
            if newValue == nil {
                playbackService.isArticleReaderActive = false
            }
        }
        .sheet(isPresented: $showUpgradeSheet) {
            RemotePaywallView(triggerSource: "home_banner")
        }
    }

    // MARK: - Promotional Banner

    private var promoBanner: some View {
        HStack(spacing: 16) {
            // Image placeholder (person with headphones)
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.green.opacity(0.2))
                    .frame(width: 80, height: 80)

                Image(systemName: "headphones.circle.fill")
                    .font(.system(size: 40))
                    .foregroundStyle(.green)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Download and listen anytime, anywhere")
                    .font(.subheadline)
                    .fontWeight(.medium)
                    .fixedSize(horizontal: false, vertical: true)

                Button {
                    showUpgradeSheet = true
                } label: {
                    Text("Try for free")
                        .font(.caption)
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)
                }
            }

            Spacer()
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    // MARK: - Quick Actions Section

    private var quickActionsSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("What do you want to listen today?")
                .font(.title3.bold())
                .padding(.horizontal, 4)

            VStack(spacing: 0) {
                QuickActionRow(
                    title: "Document",
                    subtitle: "Upload files from Drive or device",
                    icon: "doc.fill",
                    color: .blue
                ) {
                    selectedImportType = .document
                }

                Divider().padding(.leading, 72)

                QuickActionRow(
                    title: "Scan Text",
                    subtitle: "Scanned documents or images",
                    icon: "doc.viewfinder",
                    color: .purple
                ) {
                    selectedImportType = .scan
                }

                Divider().padding(.leading, 72)

                QuickActionRow(
                    title: "Web Link",
                    subtitle: "Convert URLs to audio",
                    icon: "link",
                    color: .orange
                ) {
                    selectedImportType = .url
                }

                Divider().padding(.leading, 72)

                QuickActionRow(
                    title: "Type or Paste Text",
                    subtitle: "Input or paste text to listen",
                    icon: "text.alignleft",
                    color: .green
                ) {
                    selectedImportType = .text
                }

                Divider().padding(.leading, 72)

                QuickActionRow(
                    title: "Mail",
                    subtitle: "Listen to e-mails easily",
                    icon: "envelope.fill",
                    color: .red
                ) {
                    selectedImportType = .email
                }
            }
            .background(Color(.secondarySystemGroupedBackground))
            .clipShape(RoundedRectangle(cornerRadius: 16))
        }
    }
}

// MARK: - Quick Action Row (Reference Style)

struct QuickActionRow: View {
    let title: String
    let subtitle: String
    let icon: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                // Icon with colored background
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(color.opacity(0.15))
                        .frame(width: 48, height: 48)

                    Image(systemName: icon)
                        .font(.title3)
                        .foregroundStyle(color)
                }

                // Text
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)

                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title). \(subtitle)")
        .accessibilityHint("Double tap to import")
        .accessibilityAddTraits(.isButton)
    }
}

// MARK: - Import Type

enum ImportType: String, Identifiable {
    case document
    case scan
    case url
    case text
    case email

    var id: String { rawValue }
}

// MARK: - Welcome Card

struct WelcomeCard: View {
    var body: some View {
        HStack(spacing: 16) {
            // Icon
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.blue.opacity(0.1))
                    .frame(width: 60, height: 60)

                Image(systemName: "text.alignleft")
                    .font(.title2)
                    .foregroundStyle(.blue)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text("Welcome to ReadAloud AI")
                    .font(.headline)

                Text("1 min")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Spacer()
        }
        .padding()
        .background(
            LinearGradient(
                colors: [Color.blue.opacity(0.1), Color.purple.opacity(0.05)],
                startPoint: .topLeading,
                endPoint: .bottomTrailing
            )
        )
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Welcome to ReadAloud AI. 1 minute introduction")
    }
}

// MARK: - Continue Listening Card

struct ContinueListeningCard: View {
    let item: QueueItem

    var body: some View {
        HStack(spacing: 16) {
            // Artwork
            ZStack {
                RoundedRectangle(cornerRadius: 12)
                    .fill(item.artworkColor?.color ?? Color.blue)
                    .frame(width: 60, height: 60)

                Image(systemName: item.sourceType.iconName)
                    .font(.title2)
                    .foregroundStyle(.white)
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(item.title)
                    .font(.headline)
                    .lineLimit(1)

                HStack(spacing: 8) {
                    Text(item.displayAuthor)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)

                    Text("•")
                        .foregroundStyle(.secondary)

                    Text(item.remainingFormatted)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }

            Spacer()

            // Play button
            Image(systemName: "play.circle.fill")
                .font(.largeTitle)
                .foregroundStyle(.blue)
        }
        .padding()
        .background(Color(.secondarySystemGroupedBackground))
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Continue listening: \(item.title). \(item.remainingFormatted) remaining")
        .accessibilityHint("Double tap to resume playback")
    }
}

// MARK: - PRO Badge Button

struct ProBadgeButton: View {
    private var premiumManager: PremiumManager { PremiumManager.shared }
    @State private var showingSubscription = false

    var body: some View {
        Button {
            showingSubscription = true
        } label: {
            Text("PRO")
                .font(.caption.bold())
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(premiumManager.isPremium ? Color.green.gradient : Color.orange.gradient)
                .foregroundStyle(.white)
                .clipShape(Capsule())
        }
        .sheet(isPresented: $showingSubscription) {
            RemotePaywallView(triggerSource: "pro_badge")
        }
    }
}

// MARK: - Import Sheet View

struct ImportSheetView: View {
    let initialType: ImportType
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            switch initialType {
            case .document:
                DocumentPickerSheet()
            case .scan:
                ScanTextView()
            case .url:
                NavigationStack {
                    SimpleWebLinkView()
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button {
                                    dismiss()
                                } label: {
                                    Image(systemName: "chevron.left")
                                        .font(.body)
                                }
                            }
                        }
                }
            case .text:
                NavigationStack {
                    SimpleTextInputView()
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button {
                                    dismiss()
                                } label: {
                                    Image(systemName: "chevron.left")
                                        .font(.body)
                                }
                            }
                        }
                }
            case .email:
                NavigationStack {
                    MailImportView()
                }
            }
        }
        .presentationDetents(presentationDetents)
        .presentationDragIndicator(.visible)
    }

    private var presentationDetents: Set<PresentationDetent> {
        switch initialType {
        case .document:
            return [.height(280)]
        case .scan:
            return [.large]
        case .url, .text:
            return [.large]
        case .email:
            return [.large]
        }
    }
}

// MARK: - Import Picker Sheet

/// A picker sheet showing all available import options.
/// Used from Library and other views to provide full import functionality.
struct ImportPickerSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var selectedImportType: ImportType?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ImportOptionRow(
                    title: "Document",
                    subtitle: "PDF, ePub, TXT & more",
                    icon: "doc.fill",
                    color: .blue
                ) {
                    dismiss()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        selectedImportType = .document
                    }
                }

                Divider().padding(.leading, 72)

                ImportOptionRow(
                    title: "Scan Text",
                    subtitle: "Use camera to scan documents",
                    icon: "doc.viewfinder",
                    color: .purple
                ) {
                    dismiss()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        selectedImportType = .scan
                    }
                }

                Divider().padding(.leading, 72)

                ImportOptionRow(
                    title: "Web Link",
                    subtitle: "Convert any URL to audio",
                    icon: "link",
                    color: .orange
                ) {
                    dismiss()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        selectedImportType = .url
                    }
                }

                Divider().padding(.leading, 72)

                ImportOptionRow(
                    title: "Type or Paste Text",
                    subtitle: "Enter text manually",
                    icon: "text.alignleft",
                    color: .green
                ) {
                    dismiss()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        selectedImportType = .text
                    }
                }

                Divider().padding(.leading, 72)

                ImportOptionRow(
                    title: "Mail",
                    subtitle: "Import emails from Gmail",
                    icon: "envelope.fill",
                    color: .red
                ) {
                    dismiss()
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) {
                        selectedImportType = .email
                    }
                }

                Spacer()
            }
            .padding(.top, 8)
            .navigationTitle("Add Content")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
        }
        .presentationDetents([.medium])
        .presentationDragIndicator(.visible)
    }
}

// MARK: - Import Option Row

private struct ImportOptionRow: View {
    let title: String
    let subtitle: String
    let icon: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                ZStack {
                    RoundedRectangle(cornerRadius: 10)
                        .fill(color.opacity(0.15))
                        .frame(width: 48, height: 48)

                    Image(systemName: icon)
                        .font(.title3)
                        .foregroundStyle(color)
                }

                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.body)
                        .foregroundStyle(.primary)

                    Text(subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Spacer()

                Image(systemName: "chevron.right")
                    .font(.caption)
                    .foregroundStyle(.tertiary)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Preview

#Preview {
    NavigationStack {
        HomeView()
            .environmentObject(AudioPlaybackService.shared)
            .environmentObject(QueueManager.shared)
    }
}
