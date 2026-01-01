import SwiftUI
import UniformTypeIdentifiers

// MARK: - Import View

/// Main view for importing content from various sources.
struct ImportView: View {

    @StateObject private var coordinator = ImportCoordinator.shared
    @Environment(\.dismiss) private var dismiss

    @State private var urlText: String = ""
    @State private var manualText: String = ""
    @State private var manualTitle: String = ""
    @State private var selectedTab: ImportTab = .url
    @State private var showFilePicker = false
    @State private var showPreview = false

    var onImport: ((Article) -> Void)?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Tab selector
                importTabPicker
                    .padding(.horizontal)
                    .padding(.top, 8)

                Divider()
                    .padding(.top, 12)

                // Tab content
                ScrollView {
                    VStack(spacing: 20) {
                        switch selectedTab {
                        case .url:
                            urlImportSection
                        case .clipboard:
                            clipboardImportSection
                        case .pdf:
                            pdfImportSection
                        case .text:
                            textImportSection
                        }
                    }
                    .padding()
                }

                // Import button
                importButton
                    .padding()
            }
            .navigationTitle("Add Content")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") {
                        dismiss()
                    }
                }
            }
            .fileImporter(
                isPresented: $showFilePicker,
                allowedContentTypes: [.pdf],
                allowsMultipleSelection: false
            ) { result in
                handleFileImport(result)
            }
            .sheet(isPresented: $showPreview) {
                if let article = coordinator.previewArticle {
                    ArticlePreviewView(
                        article: article,
                        onConfirm: {
                            onImport?(article)
                            dismiss()
                        },
                        onCancel: {
                            coordinator.reset()
                            showPreview = false
                        }
                    )
                }
            }
            .onChange(of: coordinator.importState) { _, newState in
                if case .success = newState {
                    showPreview = true
                }
            }
            .onAppear {
                coordinator.refreshClipboard()
            }
        }
    }

    // MARK: - Tab Picker

    private var importTabPicker: some View {
        HStack(spacing: 8) {
            ForEach(ImportTab.allCases, id: \.self) { tab in
                ImportTabButton(
                    tab: tab,
                    isSelected: selectedTab == tab,
                    action: { selectedTab = tab }
                )
            }
        }
    }

    // MARK: - URL Import Section

    private var urlImportSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Header
            ImportSectionHeader(
                icon: "globe",
                title: "Import from Web",
                subtitle: "Enter a URL to extract article content"
            )

            // URL input
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Image(systemName: "link")
                        .foregroundColor(.secondary)

                    TextField("https://example.com/article", text: $urlText)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .keyboardType(.URL)

                    if !urlText.isEmpty {
                        Button {
                            urlText = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundColor(.secondary)
                        }
                    }
                }
                .padding()
                .background(Color(.systemGray6))
                .cornerRadius(12)

                // Validation message
                if let errorMessage = coordinator.validateURL(urlText).errorMessage {
                    Text(errorMessage)
                        .font(.caption)
                        .foregroundColor(.red)
                }
            }

            // Paste button
            if coordinator.clipboardContent?.canImport == true,
               case .url = coordinator.clipboardContent {
                Button {
                    if case .url(let url) = coordinator.clipboardContent {
                        urlText = url.absoluteString
                    }
                } label: {
                    Label("Paste from Clipboard", systemImage: "doc.on.clipboard")
                        .font(.subheadline)
                }
            }

            // Tips
            ImportTipsView(tips: [
                "Works best with article pages from news sites and blogs",
                "Paywalled content may not be accessible",
                "JavaScript-heavy sites may have limited extraction"
            ])
        }
    }

    // MARK: - Clipboard Import Section

    private var clipboardImportSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            ImportSectionHeader(
                icon: "doc.on.clipboard",
                title: "Import from Clipboard",
                subtitle: "Import text or links you've copied"
            )

            // Clipboard preview
            clipboardPreviewCard

            // Refresh button
            Button {
                coordinator.refreshClipboard()
            } label: {
                Label("Refresh Clipboard", systemImage: "arrow.clockwise")
                    .font(.subheadline)
            }
        }
    }

    private var clipboardPreviewCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let content = coordinator.clipboardContent {
                HStack {
                    Image(systemName: content.iconName)
                        .font(.title2)
                        .foregroundColor(.accentColor)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(content.displayName)
                            .font(.headline)

                        if let preview = content.preview {
                            Text(preview)
                                .font(.caption)
                                .foregroundColor(.secondary)
                                .lineLimit(2)
                        }
                    }

                    Spacer()

                    if content.canImport {
                        Image(systemName: "checkmark.circle.fill")
                            .foregroundColor(.green)
                    } else {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.red)
                    }
                }

                if !content.canImport {
                    Text(content == .empty ? "Clipboard is empty" : "This content type cannot be imported")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            } else {
                HStack {
                    Image(systemName: "clipboard")
                        .font(.title2)
                        .foregroundColor(.secondary)

                    Text("Checking clipboard...")
                        .foregroundColor(.secondary)
                }
            }
        }
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }

    // MARK: - PDF Import Section

    private var pdfImportSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            ImportSectionHeader(
                icon: "doc.fill",
                title: "Import PDF",
                subtitle: "Extract text from PDF documents"
            )

            // File picker button
            Button {
                showFilePicker = true
            } label: {
                HStack {
                    Image(systemName: "folder")
                        .font(.title2)

                    VStack(alignment: .leading, spacing: 2) {
                        Text("Choose PDF File")
                            .font(.headline)

                        Text("Select from Files app")
                            .font(.caption)
                            .foregroundColor(.secondary)
                    }

                    Spacer()

                    Image(systemName: "chevron.right")
                        .foregroundColor(.secondary)
                }
                .padding()
                .background(Color(.systemGray6))
                .cornerRadius(12)
            }
            .buttonStyle(.plain)

            // Tips
            ImportTipsView(tips: [
                "Works best with text-based PDFs",
                "Scanned documents may have limited text extraction",
                "Password-protected PDFs are not supported"
            ])
        }
    }

    // MARK: - Text Import Section

    private var textImportSection: some View {
        VStack(alignment: .leading, spacing: 16) {
            ImportSectionHeader(
                icon: "square.and.pencil",
                title: "Enter Text",
                subtitle: "Type or paste text directly"
            )

            // Title input
            TextField("Title (optional)", text: $manualTitle)
                .padding()
                .background(Color(.systemGray6))
                .cornerRadius(12)

            // Text input
            TextEditor(text: $manualText)
                .frame(minHeight: 200)
                .padding(8)
                .background(Color(.systemGray6))
                .cornerRadius(12)
                .overlay(
                    Group {
                        if manualText.isEmpty {
                            Text("Paste or type your text here...")
                                .foregroundColor(.secondary)
                                .padding(.horizontal, 12)
                                .padding(.vertical, 16)
                        }
                    },
                    alignment: .topLeading
                )

            // Word count
            if !manualText.isEmpty {
                let wordCount = manualText.split(separator: " ").count
                Text("\(wordCount) words")
                    .font(.caption)
                    .foregroundColor(.secondary)
            }
        }
    }

    // MARK: - Import Button

    private var importButton: some View {
        Button {
            Task {
                await performImport()
            }
        } label: {
            HStack {
                if coordinator.importState.isImporting {
                    ProgressView()
                        .tint(.white)
                } else {
                    Text("Import")
                }
            }
            .frame(maxWidth: .infinity)
            .padding()
            .background(canImport ? Color.accentColor : Color.gray)
            .foregroundColor(.white)
            .cornerRadius(12)
        }
        .disabled(!canImport || coordinator.importState.isImporting)
    }

    private var canImport: Bool {
        switch selectedTab {
        case .url:
            return coordinator.validateURL(urlText).isValid
        case .clipboard:
            return coordinator.clipboardContent?.canImport ?? false
        case .pdf:
            return false // Handled by file picker
        case .text:
            return !manualText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    // MARK: - Actions

    private func performImport() async {
        do {
            let article: Article

            switch selectedTab {
            case .url:
                article = try await coordinator.importFromURL(urlText)
            case .clipboard:
                article = try await coordinator.importFromClipboard()
            case .pdf:
                return // Handled by file picker
            case .text:
                article = try await coordinator.importFromText(
                    manualText,
                    title: manualTitle.isEmpty ? nil : manualTitle
                )
            }

            // Will show preview via onChange
            _ = article

        } catch {
            // Error is shown in coordinator state
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }

            // Need to start accessing security-scoped resource
            guard url.startAccessingSecurityScopedResource() else { return }

            Task {
                defer { url.stopAccessingSecurityScopedResource() }

                do {
                    _ = try await coordinator.importFromPDF(url)
                } catch {
                    // Error shown via coordinator
                }
            }

        case .failure(let error):
            print("File import error: \(error)")
        }
    }
}

// MARK: - Import Tab

enum ImportTab: String, CaseIterable {
    case url = "URL"
    case clipboard = "Clipboard"
    case pdf = "PDF"
    case text = "Text"

    var icon: String {
        switch self {
        case .url: return "globe"
        case .clipboard: return "doc.on.clipboard"
        case .pdf: return "doc.fill"
        case .text: return "square.and.pencil"
        }
    }
}

// MARK: - Import Tab Button

struct ImportTabButton: View {
    let tab: ImportTab
    let isSelected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 4) {
                Image(systemName: tab.icon)
                    .font(.title3)

                Text(tab.rawValue)
                    .font(.caption)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 12)
            .background(isSelected ? Color.accentColor.opacity(0.15) : Color.clear)
            .foregroundColor(isSelected ? .accentColor : .secondary)
            .cornerRadius(8)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Import Section Header

struct ImportSectionHeader: View {
    let icon: String
    let title: String
    let subtitle: String

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: icon)
                .font(.title)
                .foregroundColor(.accentColor)
                .frame(width: 44, height: 44)
                .background(Color.accentColor.opacity(0.1))
                .cornerRadius(10)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.headline)

                Text(subtitle)
                    .font(.subheadline)
                    .foregroundColor(.secondary)
            }

            Spacer()
        }
    }
}

// MARK: - Import Tips View

struct ImportTipsView: View {
    let tips: [String]

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Tips")
                .font(.caption)
                .fontWeight(.semibold)
                .foregroundColor(.secondary)

            ForEach(tips, id: \.self) { tip in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "lightbulb")
                        .font(.caption)
                        .foregroundColor(.yellow)

                    Text(tip)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }
        }
        .padding()
        .background(Color(.systemGray6))
        .cornerRadius(12)
    }
}

// MARK: - Article Preview View

struct ArticlePreviewView: View {
    let article: Article
    let onConfirm: () -> Void
    let onCancel: () -> Void

    @State private var editedTitle: String = ""

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    // Metadata
                    metadataSection

                    Divider()

                    // Content preview
                    contentPreview
                }
                .padding()
            }
            .navigationTitle("Preview")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }

                ToolbarItem(placement: .confirmationAction) {
                    Button("Add to Library", action: onConfirm)
                        .fontWeight(.semibold)
                }
            }
            .onAppear {
                editedTitle = article.title
            }
        }
    }

    private var metadataSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Title (editable)
            TextField("Title", text: $editedTitle)
                .font(.title2)
                .fontWeight(.bold)

            // Source info
            HStack(spacing: 16) {
                Label(article.sourceType.displayName, systemImage: article.sourceType.iconName)
                    .font(.caption)
                    .foregroundColor(.secondary)

                if let author = article.author {
                    Text("by \(author)")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
            }

            // Stats
            HStack(spacing: 20) {
                StatBadge(
                    icon: "text.word.spacing",
                    value: "\(article.wordCount)",
                    label: "words"
                )

                StatBadge(
                    icon: "clock",
                    value: article.estimatedDuration.formattedDurationShort,
                    label: "listen time"
                )

                StatBadge(
                    icon: "doc.text",
                    value: "\(article.sections.count)",
                    label: "sections"
                )
            }
        }
    }

    private var contentPreview: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Content Preview")
                .font(.headline)

            Text(article.rawText.prefix(1000) + (article.rawText.count > 1000 ? "..." : ""))
                .font(.body)
                .foregroundColor(.secondary)
                .lineSpacing(4)
        }
    }
}

// MARK: - Stat Badge

struct StatBadge: View {
    let icon: String
    let value: String
    let label: String

    var body: some View {
        VStack(spacing: 4) {
            HStack(spacing: 4) {
                Image(systemName: icon)
                    .font(.caption)

                Text(value)
                    .font(.subheadline)
                    .fontWeight(.semibold)
            }

            Text(label)
                .font(.caption2)
                .foregroundColor(.secondary)
        }
    }
}

// MARK: - Preview

#Preview {
    ImportView()
}
