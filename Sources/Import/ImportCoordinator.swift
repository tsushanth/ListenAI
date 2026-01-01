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

    // Clipboard monitoring
    @Published var clipboardContent: ClipboardContent?

    // MARK: - Properties

    private let webService = WebImportService.shared
    private let pdfService = PDFImportService.shared
    private let clipboardService = ClipboardImportService.shared
    private let cleaningService = TextCleaningService()

    private var importTask: Task<Void, Never>?

    // MARK: - Singleton

    static let shared = ImportCoordinator()

    // MARK: - Initialization

    private init() {
        // Monitor clipboard
        clipboardService.checkClipboard()
        clipboardContent = clipboardService.clipboardContent
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

            progress = .complete
            importState = .success(article: article)
            previewArticle = article

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

            var article = cleanedResult.toArticle(sourceType: .pdf, importMethod: .inApp)
            article.sourceFileName = fileURL.lastPathComponent

            progress = .complete
            importState = .success(article: article)
            previewArticle = article

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

            progress = .complete
            importState = .success(article: article)
            previewArticle = article

            return article

        } catch let error as ExtractionError {
            lastError = error
            importState = .failed(error: error)
            throw error
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

            progress = .complete
            importState = .success(article: article)
            previewArticle = article

            return article

        } catch let error as ExtractionError {
            lastError = error
            importState = .failed(error: error)
            throw error
        }
    }

    /// Import from plain text
    func importFromText(_ text: String, title: String? = nil) async throws -> Article {
        importState = .importing(source: .manual)
        progress = ImportProgress(stage: .cleaning, progress: 0.5, message: "Processing text...")
        lastError = nil

        let cleaned = cleaningService.clean(text)

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

        progress = .complete
        importState = .success(article: article)
        previewArticle = article

        return article
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

// MARK: - Article Equatable

extension Article: Equatable {
    static func == (lhs: Article, rhs: Article) -> Bool {
        lhs.id == rhs.id
    }
}
