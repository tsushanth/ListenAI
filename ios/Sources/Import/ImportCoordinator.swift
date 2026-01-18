import Foundation
import SwiftUI
import Combine

// MARK: - Import Coordinator

/// Coordinates content import from various sources and provides a unified interface.
@MainActor
final class ImportCoordinator: ObservableObject {

    // MARK: - Published State

    @Published private(set) var importState: ImportState = .idle
    @Published private(set) var progress: ImportProgress = .initial
    @Published private(set) var lastError: ExtractionError?
    @Published private(set) var previewArticle: Article?

    // Synthesis state
    @Published private(set) var synthesisProgress: Float = 0
    @Published private(set) var isSynthesizing: Bool = false

    // Clipboard monitoring
    @Published var clipboardContent: ClipboardContent?

    // MARK: - Properties

    private let webService = WebImportService.shared
    private let pdfService = PDFImportService.shared
    private let clipboardService = ClipboardImportService.shared
    private let cleaningService = TextCleaningService()
    private let articleStore = ArticleStore.shared

    private var importTask: Task<Void, Never>?
    private var synthesisTask: Task<Void, Never>?

    // MARK: - Singleton

    static let shared = ImportCoordinator()

    // MARK: - Initialization

    private init() {
        // Monitor clipboard
        clipboardService.checkClipboard()
        clipboardContent = clipboardService.clipboardContent
    }

    // MARK: - Pre-synthesis

    /// Pre-synthesize audio for an article in the background
    func preSynthesizeAudio(for article: Article) {
        // Check if audio already exists and is valid
        let currentArticle = articleStore.article(withID: article.id) ?? article

        // Skip if synthesis is already complete and audio file exists
        if currentArticle.synthesisStatus.isComplete,
           let audioURL = currentArticle.audioFileURL,
           FileManager.default.fileExists(atPath: audioURL.path) {
            print("[Import] Audio already cached for '\(article.title.prefix(30))', skipping pre-synthesis")
            return
        }

        // Skip if synthesis is already in progress or queued
        if currentArticle.synthesisStatus.isInProgress {
            print("[Import] Synthesis already in progress for '\(article.title.prefix(30))', skipping")
            return
        }
        if case .queued = currentArticle.synthesisStatus {
            print("[Import] Synthesis already queued for '\(article.title.prefix(30))', skipping")
            return
        }

        // Cancel any existing synthesis task
        synthesisTask?.cancel()

        synthesisTask = Task {
            await performSynthesis(for: article)
        }
    }

    /// Perform the actual synthesis using the job-based API
    /// All synthesis now goes through POST /api/tts/job for quota tracking and caching
    private func performSynthesis(for article: Article) async {
        isSynthesizing = true
        synthesisProgress = 0

        let charCount = article.rawText.count
        let wordCount = article.rawText.split(separator: " ").count
        print("[Import] Starting pre-synthesis for '\(article.title.prefix(50))' (\(charCount) chars, ~\(wordCount) words)")

        // Get current voice preset
        let voice = VoicePresetManager.shared.selectedPreset

        // Use Kokoro voice ID for job API (backend uses Kokoro for all cloud synthesis)
        guard let kokoroVoiceId = voice.kokoroVoiceID else {
            print("[Import] Voice \(voice.name) has no Kokoro ID, skipping pre-synthesis")
            articleStore.updateSynthesisStatus(for: article.id, status: .notStarted)
            isSynthesizing = false
            return
        }

        print("[Import] Selected voice for synthesis: \(voice.name), kokoroID: \(kokoroVoiceId)")

        // Update status to queued
        articleStore.updateSynthesisStatus(for: article.id, status: .queued(position: 1))

        // Get cloud service
        guard let cloudService = TTSServiceFactory.listenAICloudService else {
            print("[Import] Cloud service not configured, skipping pre-synthesis")
            articleStore.updateSynthesisStatus(for: article.id, status: .failed(message: "Cloud service not configured"))
            isSynthesizing = false
            return
        }

        do {
            // Submit job via backend API with prewarm purpose
            let response = try await cloudService.requestTTS(
                text: article.rawText,
                voiceId: kokoroVoiceId,
                speed: 1.0,
                purpose: .prewarm
            )

            // Check if cancelled
            if Task.isCancelled { return }

            // Handle response based on status
            switch response.status {
            case .ready:
                // Cache hit! Audio is immediately available
                if let audioUrlString = response.audioUrl, let audioUrl = URL(string: audioUrlString) {
                    // Download audio to local cache
                    let localPath = await downloadAudioToCache(articleId: article.id, from: audioUrl)
                    if let localPath = localPath {
                        articleStore.updateSynthesisStatus(for: article.id, status: .completed, audioURL: localPath)
                        print("[Import] Pre-synthesis completed (cache hit) for '\(article.title.prefix(30))'")
                    } else {
                        // Store remote URL if download fails
                        articleStore.updateSynthesisStatus(for: article.id, status: .completed, audioURL: audioUrl)
                    }
                }
                synthesisProgress = 1.0

            case .queued, .processing, .partialReady:
                // Job is processing - hand off to TTSJobManager for background polling
                articleStore.updateSynthesisStatus(for: article.id, status: .inProgress(progress: 0))
                articleStore.updatePendingTTSJob(for: article.id, jobId: response.jobId, voiceId: kokoroVoiceId)

                // Let TTSJobManager handle background polling
                TTSJobManager.shared.trackJob(
                    articleId: article.id,
                    jobId: response.jobId,
                    voiceId: kokoroVoiceId,
                    initialStatus: response.status
                )

                print("[Import] Pre-synthesis job started: \(response.jobId) for '\(article.title.prefix(30))'")

            case .failed, .cancelled:
                // Initial POST should not return failed/cancelled, but handle gracefully
                articleStore.updateSynthesisStatus(for: article.id, status: .failed(message: "Synthesis failed"))
                print("[Import] Pre-synthesis failed for '\(article.title.prefix(30))'")
            }

        } catch let error as TTSJobError {
            if !Task.isCancelled {
                // Handle quota errors gracefully - don't mark as failed, just skip
                switch error {
                case .dailyQuotaExceeded, .monthlyQuotaExceeded:
                    print("[Import] Pre-synthesis skipped (quota exceeded) for '\(article.title.prefix(30))'")
                    articleStore.updateSynthesisStatus(for: article.id, status: .notStarted)
                default:
                    articleStore.updateSynthesisStatus(for: article.id, status: .failed(message: error.localizedDescription))
                    print("[Import] Pre-synthesis failed for '\(article.title.prefix(30))': \(error.localizedDescription)")
                }
            }
        } catch {
            if !Task.isCancelled {
                articleStore.updateSynthesisStatus(for: article.id, status: .failed(message: error.localizedDescription))
                print("[Import] Pre-synthesis failed for '\(article.title.prefix(30))': \(error.localizedDescription)")
            }
        }

        isSynthesizing = false
    }

    /// Download audio from URL to local cache
    private func downloadAudioToCache(articleId: UUID, from url: URL) async -> URL? {
        do {
            let (data, _) = try await URLSession.shared.data(from: url)

            let cachesDir = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first!
            let cacheDirectory = cachesDir.appendingPathComponent("TTSJobAudioCache", isDirectory: true)
            try? FileManager.default.createDirectory(at: cacheDirectory, withIntermediateDirectories: true)

            let localPath = cacheDirectory.appendingPathComponent("\(articleId.uuidString).mp3")
            try data.write(to: localPath)

            return localPath
        } catch {
            print("[Import] Failed to download audio to cache: \(error.localizedDescription)")
            return nil
        }
    }

    /// Cancel ongoing synthesis
    func cancelSynthesis() {
        synthesisTask?.cancel()
        synthesisTask = nil
        isSynthesizing = false
    }

    // MARK: - Import Methods

    /// Import content from a URL
    func importFromURL(_ urlString: String) async throws -> Article {
        // Validate and normalize URL
        var normalizedURL = urlString.trimmingCharacters(in: .whitespacesAndNewlines)

        // Add https if no scheme
        if !normalizedURL.contains("://") {
            normalizedURL = "https://" + normalizedURL
        }

        guard let url = URL(string: normalizedURL) else {
            throw ExtractionError.invalidURL(url: urlString)
        }

        return try await importFromURL(url)
    }

    /// Import content from a URL
    func importFromURL(_ url: URL) async throws -> Article {
        // Check if this is a PDF URL - route to PDF import
        if url.pathExtension.lowercased() == "pdf" {
            return try await importFromPDFURL(url)
        }

        importState = .importing(source: .web)
        progress = ImportProgress(stage: .fetching, progress: 0.1, message: "Fetching article...")
        lastError = nil

        do {
            progress = ImportProgress(stage: .parsing, progress: 0.3, message: "Parsing content...")

            let result = try await webService.extract(from: url)

            progress = ImportProgress(stage: .cleaning, progress: 0.7, message: "Cleaning text...")

            let cleanedResult = cleaningService.clean(result)

            progress = ImportProgress(stage: .analyzing, progress: 0.9, message: "Analyzing structure...")

            let article = cleanedResult.toArticle(sourceType: .web, importMethod: .inApp)

            progress = ImportProgress(stage: .synthesizing, progress: 0.95, message: "Generating audio...")
            importState = .success(article: article)
            previewArticle = article

            // Auto-save and start synthesis
            articleStore.addArticle(article)
            preSynthesizeAudio(for: article)

            return article

        } catch let error as ExtractionError {
            lastError = error
            importState = .failed(error: error)
            progress = ImportProgress(stage: .failed, progress: 0, message: error.localizedDescription)
            throw error
        } catch {
            let extractionError = ExtractionError.networkError(underlying: error.localizedDescription)
            lastError = extractionError
            importState = .failed(error: extractionError)
            progress = ImportProgress(stage: .failed, progress: 0, message: error.localizedDescription)
            throw extractionError
        }
    }

    /// Import content from a PDF file
    func importFromPDF(_ fileURL: URL) async throws -> Article {
        importState = .importing(source: .pdf)
        progress = ImportProgress(stage: .extracting, progress: 0.2, message: "Extracting PDF text...")
        lastError = nil

        do {
            let result = try await pdfService.extract(from: fileURL)

            progress = ImportProgress(stage: .cleaning, progress: 0.6, message: "Cleaning text...")

            let cleanedResult = cleaningService.clean(result)

            progress = ImportProgress(stage: .analyzing, progress: 0.9, message: "Analyzing structure...")

            let article = cleanedResult.toArticle(
                sourceType: .pdf,
                importMethod: .inApp,
                sourceFileName: fileURL.lastPathComponent
            )

            progress = ImportProgress(stage: .synthesizing, progress: 0.95, message: "Generating audio...")
            importState = .success(article: article)
            previewArticle = article

            // Auto-save and start synthesis
            articleStore.addArticle(article)
            preSynthesizeAudio(for: article)

            return article

        } catch let error as ExtractionError {
            lastError = error
            importState = .failed(error: error)
            progress = ImportProgress(stage: .failed, progress: 0, message: error.localizedDescription)
            throw error
        } catch {
            let extractionError = ExtractionError.parsingFailed(reason: error.localizedDescription)
            lastError = extractionError
            importState = .failed(error: extractionError)
            throw extractionError
        }
    }

    /// Import content from PDF data
    func importFromPDF(_ data: Data) async throws -> Article {
        importState = .importing(source: .pdf)
        progress = ImportProgress(stage: .extracting, progress: 0.2, message: "Extracting PDF text...")
        lastError = nil

        do {
            let result = try await pdfService.extract(from: data)

            progress = ImportProgress(stage: .cleaning, progress: 0.6, message: "Cleaning text...")

            let cleanedResult = cleaningService.clean(result)

            progress = ImportProgress(stage: .analyzing, progress: 0.9, message: "Analyzing structure...")

            let article = cleanedResult.toArticle(sourceType: .pdf, importMethod: .inApp)

            progress = ImportProgress(stage: .synthesizing, progress: 0.95, message: "Generating audio...")
            importState = .success(article: article)
            previewArticle = article

            // Auto-save and start synthesis
            articleStore.addArticle(article)
            preSynthesizeAudio(for: article)

            return article

        } catch let error as ExtractionError {
            lastError = error
            importState = .failed(error: error)
            throw error
        }
    }

    /// Import content from a PDF URL (downloads the PDF first)
    func importFromPDFURL(_ url: URL) async throws -> Article {
        importState = .importing(source: .pdf)
        progress = ImportProgress(stage: .fetching, progress: 0.1, message: "Downloading PDF...")
        lastError = nil

        do {
            // Download the PDF
            let (data, response) = try await URLSession.shared.data(from: url)

            // Check response
            guard let httpResponse = response as? HTTPURLResponse else {
                throw ExtractionError.networkError(underlying: "Invalid response")
            }

            guard (200...299).contains(httpResponse.statusCode) else {
                throw ExtractionError.networkError(underlying: "Failed to download PDF (HTTP \(httpResponse.statusCode))")
            }

            // Verify it's actually a PDF
            guard data.count > 4,
                  let header = String(data: data.prefix(4), encoding: .ascii),
                  header == "%PDF" else {
                throw ExtractionError.unsupportedFormat(format: "Not a valid PDF file")
            }

            progress = ImportProgress(stage: .extracting, progress: 0.3, message: "Extracting PDF text...")

            let result = try await pdfService.extract(from: data)

            progress = ImportProgress(stage: .cleaning, progress: 0.6, message: "Cleaning text...")

            let cleanedResult = cleaningService.clean(result)

            progress = ImportProgress(stage: .analyzing, progress: 0.9, message: "Analyzing structure...")

            // Use the URL's last path component as filename hint
            let article = cleanedResult.toArticle(
                sourceType: .pdf,
                importMethod: .inApp,
                sourceFileName: url.lastPathComponent
            )

            progress = ImportProgress(stage: .synthesizing, progress: 0.95, message: "Generating audio...")
            importState = .success(article: article)
            previewArticle = article

            // Auto-save and start synthesis
            articleStore.addArticle(article)
            preSynthesizeAudio(for: article)

            return article

        } catch let error as ExtractionError {
            lastError = error
            importState = .failed(error: error)
            progress = ImportProgress(stage: .failed, progress: 0, message: error.localizedDescription)
            throw error
        } catch {
            let extractionError = ExtractionError.networkError(underlying: error.localizedDescription)
            lastError = extractionError
            importState = .failed(error: extractionError)
            progress = ImportProgress(stage: .failed, progress: 0, message: error.localizedDescription)
            throw extractionError
        }
    }

    /// Import content from clipboard
    func importFromClipboard() async throws -> Article {
        clipboardService.checkClipboard()
        clipboardContent = clipboardService.clipboardContent

        importState = .importing(source: .clipboard)
        progress = ImportProgress(stage: .extracting, progress: 0.3, message: "Reading clipboard...")
        lastError = nil

        do {
            let result = try await clipboardService.extract()

            progress = ImportProgress(stage: .cleaning, progress: 0.6, message: "Cleaning text...")

            let cleanedResult = cleaningService.clean(result)

            progress = ImportProgress(stage: .analyzing, progress: 0.9, message: "Analyzing structure...")

            let article = cleanedResult.toArticle(sourceType: .clipboard, importMethod: .clipboard)

            progress = ImportProgress(stage: .synthesizing, progress: 0.95, message: "Generating audio...")
            importState = .success(article: article)
            previewArticle = article

            // Auto-save and start synthesis
            articleStore.addArticle(article)
            preSynthesizeAudio(for: article)

            return article

        } catch let error as ExtractionError {
            lastError = error
            importState = .failed(error: error)
            throw error
        }
    }

    /// Import from plain text
    func importFromText(_ text: String, title: String? = nil, saveToLibrary: Bool = true) async throws -> Article {
        return try await importFromText(text, title: title, options: .default, saveToLibrary: saveToLibrary)
    }

    /// Import from plain text with custom cleaning options
    func importFromText(_ text: String, title: String? = nil, options: TextCleaningOptions, saveToLibrary: Bool = true) async throws -> Article {
        importState = .importing(source: .manual)
        progress = ImportProgress(stage: .cleaning, progress: 0.5, message: "Processing text...")
        lastError = nil

        let customCleaningService = TextCleaningService(options: options)
        let cleaned = customCleaningService.clean(text)

        guard !cleaned.isEmpty else {
            let error = ExtractionError.emptyContent
            lastError = error
            importState = .failed(error: error)
            throw error
        }

        // Create sections
        let paragraphs = cleaned.components(separatedBy: "\n\n")
        var sections: [ArticleSection] = []
        var offset = 0

        for (index, paragraph) in paragraphs.enumerated() {
            let trimmed = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            sections.append(ArticleSection(
                id: UUID(),
                index: index,
                type: index == 0 && title == nil ? .title : .paragraph,
                text: trimmed,
                startOffset: offset,
                endOffset: offset + trimmed.count
            ))

            offset += paragraph.count + 2
        }

        let article = Article(
            sourceType: .manual,
            importMethod: .inApp,
            title: title ?? (sections.first?.text ?? "Untitled"),
            rawText: cleaned,
            sections: sections
        )

        progress = ImportProgress(stage: .synthesizing, progress: 0.95, message: "Generating audio...")
        importState = .success(article: article)
        previewArticle = article

        // Only save to library if requested
        if saveToLibrary {
            articleStore.addArticle(article)
            preSynthesizeAudio(for: article)
        }

        return article
    }

    /// Save an article to the library (for articles created in preview mode)
    func saveToLibrary(_ article: Article) {
        articleStore.addArticle(article)
        preSynthesizeAudio(for: article)
    }

    /// Import from any content source
    func importFrom(_ source: ContentSource) async throws -> Article {
        switch source {
        case .url(let url):
            return try await importFromURL(url)
        case .pdfFile(let url):
            return try await importFromPDF(url)
        case .pdfData(let data):
            return try await importFromPDF(data)
        case .clipboard:
            return try await importFromClipboard()
        case .text(let text):
            return try await importFromText(text)
        case .html(let html, let baseURL):
            let result = try await webService.extract(html: html, baseURL: baseURL)
            let cleaned = cleaningService.clean(result)
            return cleaned.toArticle(sourceType: .web, importMethod: .inApp)
        case .file(let url):
            // Determine file type and delegate
            if url.pathExtension.lowercased() == "pdf" {
                return try await importFromPDF(url)
            } else if let data = try? Data(contentsOf: url),
                      let text = String(data: data, encoding: .utf8) {
                return try await importFromText(text, title: url.deletingPathExtension().lastPathComponent)
            } else {
                throw ExtractionError.unsupportedFormat(format: url.pathExtension)
            }
        }
    }

    // MARK: - State Management

    /// Reset to idle state
    func reset() {
        importTask?.cancel()
        importTask = nil
        importState = .idle
        progress = .initial
        lastError = nil
        previewArticle = nil
    }

    /// Cancel ongoing import
    func cancel() {
        importTask?.cancel()
        importTask = nil
        importState = .idle
        progress = .initial
    }

    /// Refresh clipboard content
    func refreshClipboard() {
        clipboardService.checkClipboard()
        clipboardContent = clipboardService.clipboardContent
    }

    // MARK: - Validation

    /// Validate a URL string
    func validateURL(_ urlString: String) -> URLValidationResult {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)

        guard !trimmed.isEmpty else {
            return .empty
        }

        var normalizedURL = trimmed
        if !normalizedURL.contains("://") {
            normalizedURL = "https://" + normalizedURL
        }

        guard let url = URL(string: normalizedURL) else {
            return .invalid(reason: "Invalid URL format")
        }

        guard url.scheme == "http" || url.scheme == "https" else {
            return .invalid(reason: "URL must start with http:// or https://")
        }

        guard url.host != nil else {
            return .invalid(reason: "URL must have a domain")
        }

        return .valid(url: url)
    }
}

// MARK: - Import State

enum ImportState: Equatable {
    case idle
    case importing(source: SourceType)
    case success(article: Article)
    case failed(error: ExtractionError)

    var isImporting: Bool {
        if case .importing = self { return true }
        return false
    }

    var isSuccess: Bool {
        if case .success = self { return true }
        return false
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    static func == (lhs: ImportState, rhs: ImportState) -> Bool {
        switch (lhs, rhs) {
        case (.idle, .idle):
            return true
        case (.importing(let a), .importing(let b)):
            return a == b
        case (.success(let a), .success(let b)):
            return a.id == b.id
        case (.failed(let a), .failed(let b)):
            return a.localizedDescription == b.localizedDescription
        default:
            return false
        }
    }
}

// MARK: - URL Validation Result

enum URLValidationResult {
    case empty
    case valid(url: URL)
    case invalid(reason: String)

    var isValid: Bool {
        if case .valid = self { return true }
        return false
    }

    var url: URL? {
        if case .valid(let url) = self { return url }
        return nil
    }

    var errorMessage: String? {
        if case .invalid(let reason) = self { return reason }
        return nil
    }
}

