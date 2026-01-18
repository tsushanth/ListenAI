import SwiftUI
import UniformTypeIdentifiers

// MARK: - Import View

/// Main view for importing content from various sources.
struct ImportView: View {

    @ObservedObject private var coordinator = ImportCoordinator.shared
    @Environment(\.dismiss) private var dismiss

    @State private var urlText: String = ""
    @State private var manualText: String = ""
    @State private var manualTitle: String = ""
    @State private var selectedTab: ImportTab = .url
    @State private var showFilePicker = false
    @State private var importedArticle: Article?
    @State private var showReader = false
    @State private var selectedPDFURL: URL?
    @State private var selectedPDFName: String?
    @State private var importError: String?

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
            .fullScreenCover(isPresented: $showReader) {
                if let article = importedArticle {
                    NavigationStack {
                        ArticleReaderView(article: article)
                            .toolbar {
                                ToolbarItem(placement: .topBarLeading) {
                                    Button("Done") {
                                        showReader = false
                                        dismiss()
                                    }
                                }
                            }
                    }
                    .environmentObject(AudioPlaybackService.shared)
                    .environmentObject(QueueManager.shared)
                }
            }
            .onChange(of: showReader) { _, isShowing in
                // Ensure mini player is shown when ArticleReaderView fullscreen cover is dismissed
                if !isShowing {
                    AudioPlaybackService.shared.isArticleReaderActive = false
                }
            }
            .onAppear {
                coordinator.refreshClipboard()
            }
            .alert("Import Error", isPresented: .constant(importError != nil)) {
                Button("OK") { importError = nil }
            } message: {
                Text(importError ?? "")
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

            // Selected file display
            if let pdfName = selectedPDFName {
                HStack {
                    Image(systemName: "doc.fill")
                        .font(.title2)
                        .foregroundColor(.red)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(pdfName)
                            .font(.headline)
                            .lineLimit(1)

                        Text("PDF selected")
                            .font(.caption)
                            .foregroundColor(.green)
                    }

                    Spacer()

                    Button {
                        selectedPDFURL = nil
                        selectedPDFName = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundColor(.secondary)
                    }
                }
                .padding()
                .background(Color(.systemGray6))
                .cornerRadius(12)
            }

            // File picker button
            Button {
                showFilePicker = true
            } label: {
                HStack {
                    Image(systemName: "folder")
                        .font(.title2)

                    VStack(alignment: .leading, spacing: 2) {
                        Text(selectedPDFName == nil ? "Choose PDF File" : "Choose Different File")
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
        VStack(spacing: 12) {
            // Progress indicator during import
            if coordinator.importState.isImporting || coordinator.isSynthesizing {
                VStack(spacing: 8) {
                    ProgressView(value: coordinator.isSynthesizing ? Double(coordinator.synthesisProgress) : Double(coordinator.progress.progress))
                        .tint(.accentColor)

                    Text(coordinator.isSynthesizing ? "Generating audio..." : coordinator.progress.message)
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                .padding(.horizontal)
            }

            Button {
                Task {
                    await performImport()
                }
            } label: {
                HStack {
                    if coordinator.importState.isImporting {
                        ProgressView()
                            .tint(.white)
                        Text(coordinator.progress.stage.displayName)
                            .padding(.leading, 4)
                    } else if coordinator.isSynthesizing {
                        ProgressView()
                            .tint(.white)
                        Text("Generating audio...")
                            .padding(.leading, 4)
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
    }

    private var canImport: Bool {
        switch selectedTab {
        case .url:
            return coordinator.validateURL(urlText).isValid
        case .clipboard:
            return coordinator.clipboardContent?.canImport ?? false
        case .pdf:
            return selectedPDFURL != nil
        case .text:
            return !manualText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    // MARK: - Actions

    private func performImport() async {
        importError = nil

        do {
            let article: Article

            switch selectedTab {
            case .url:
                article = try await coordinator.importFromURL(urlText)
            case .clipboard:
                article = try await coordinator.importFromClipboard()
            case .pdf:
                guard let pdfURL = selectedPDFURL else {
                    importError = "No PDF file selected"
                    return
                }

                // Need to access security-scoped resource
                let canAccess = pdfURL.startAccessingSecurityScopedResource()
                defer {
                    if canAccess {
                        pdfURL.stopAccessingSecurityScopedResource()
                    }
                }

                if !canAccess {
                    // Try to copy the file to a temporary location
                    let tempURL = FileManager.default.temporaryDirectory
                        .appendingPathComponent(pdfURL.lastPathComponent)

                    do {
                        // Remove existing temp file if present
                        try? FileManager.default.removeItem(at: tempURL)
                        try FileManager.default.copyItem(at: pdfURL, to: tempURL)
                        article = try await coordinator.importFromPDF(tempURL)
                    } catch {
                        importError = "Cannot access file: \(error.localizedDescription)"
                        return
                    }
                } else {
                    article = try await coordinator.importFromPDF(pdfURL)
                }
            case .text:
                article = try await coordinator.importFromText(
                    manualText,
                    title: manualTitle.isEmpty ? nil : manualTitle
                )
            }

            // Article is auto-saved and synthesis started by coordinator
            // Call external handler if provided
            onImport?(article)

            // Set article and open reader directly
            importedArticle = article
            showReader = true

        } catch {
            importError = error.localizedDescription
        }
    }

    private func handleFileImport(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else { return }

            // Store the URL for later import
            selectedPDFURL = url
            selectedPDFName = url.lastPathComponent

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
