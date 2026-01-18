import Foundation
import UIKit
import UniformTypeIdentifiers

// MARK: - Clipboard Import Service

/// Service for extracting content from the system clipboard.
@MainActor
final class ClipboardImportService: ObservableObject {

    // MARK: - Published State

    @Published private(set) var clipboardContent: ClipboardContent?
    @Published private(set) var lastCheckDate: Date?

    // MARK: - Properties

    private let pasteboard = UIPasteboard.general
    private var changeCount: Int = 0

    // MARK: - Singleton

    static let shared = ClipboardImportService()

    // MARK: - Initialization

    private init() {
        changeCount = pasteboard.changeCount
        checkClipboard()
    }

    // MARK: - Public Methods

    /// Check what's currently in the clipboard
    func checkClipboard() {
        lastCheckDate = Date()

        // Check if clipboard has changed
        guard pasteboard.changeCount != changeCount else {
            return
        }
        changeCount = pasteboard.changeCount

        clipboardContent = detectContent()
    }

    /// Extract content from clipboard
    func extract() async throws -> ExtractionResult {
        let startTime = Date()

        // Refresh clipboard detection
        checkClipboard()

        guard let content = clipboardContent else {
            throw ExtractionError.clipboardEmpty
        }

        switch content {
        case .text(let text):
            return try extractFromText(text, startTime: startTime)

        case .url(let url):
            // Delegate to web import service
            return try await WebImportService.shared.extract(from: url)

        case .html(let html, let plainText):
            return try extractFromHTML(html, plainText: plainText, startTime: startTime)

        case .rtf(let rtfData, let plainText):
            return try extractFromRTF(rtfData, plainText: plainText, startTime: startTime)

        case .image:
            throw ExtractionError.unsupportedFormat(format: "Image")

        case .pdf(let data):
            return try await PDFImportService.shared.extract(from: data)

        case .empty:
            throw ExtractionError.clipboardEmpty

        case .unsupported(let types):
            throw ExtractionError.unsupportedFormat(format: types.joined(separator: ", "))
        }
    }

    /// Get the current clipboard as plain text
    func getPlainText() -> String? {
        pasteboard.string
    }

    /// Check if clipboard has text content
    var hasTextContent: Bool {
        if case .text = clipboardContent { return true }
        if case .html = clipboardContent { return true }
        if case .rtf = clipboardContent { return true }
        return false
    }

    /// Check if clipboard has a URL
    var hasURL: Bool {
        if case .url = clipboardContent { return true }
        return false
    }

    // MARK: - Private Methods

    private func detectContent() -> ClipboardContent {
        // Check for URL first
        if let url = pasteboard.url, url.scheme == "http" || url.scheme == "https" {
            return .url(url)
        }

        // Check for URL in string
        if let string = pasteboard.string,
           let url = URL(string: string.trimmingCharacters(in: .whitespacesAndNewlines)),
           url.scheme == "http" || url.scheme == "https" {
            return .url(url)
        }

        // Check for HTML
        if pasteboard.contains(pasteboardTypes: [UTType.html.identifier]) {
            if let htmlData = pasteboard.data(forPasteboardType: UTType.html.identifier),
               let html = String(data: htmlData, encoding: .utf8) {
                return .html(html: html, plainText: pasteboard.string)
            }
        }

        // Check for RTF
        if pasteboard.contains(pasteboardTypes: [UTType.rtf.identifier]) {
            if let rtfData = pasteboard.data(forPasteboardType: UTType.rtf.identifier) {
                return .rtf(data: rtfData, plainText: pasteboard.string)
            }
        }

        // Check for PDF
        if pasteboard.contains(pasteboardTypes: [UTType.pdf.identifier]) {
            if let pdfData = pasteboard.data(forPasteboardType: UTType.pdf.identifier) {
                return .pdf(data: pdfData)
            }
        }

        // Check for image
        if pasteboard.hasImages {
            return .image
        }

        // Check for plain text
        if let string = pasteboard.string, !string.isEmpty {
            return .text(string)
        }

        // Check what types are available
        let types = pasteboard.types
        if types.isEmpty {
            return .empty
        }

        return .unsupported(types: types)
    }

    private func extractFromText(_ text: String, startTime: Date) throws -> ExtractionResult {
        let cleaned = cleanText(text)

        guard !cleaned.isEmpty else {
            throw ExtractionError.clipboardNoText
        }

        let sections = parseSections(from: cleaned)
        let wordCount = cleaned.split(separator: " ").count

        // Try to extract a title from the first line
        let lines = cleaned.components(separatedBy: "\n")
        let firstLine = lines.first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let title: String? = (firstLine.count > 5 && firstLine.count < 200) ? firstLine : nil

        let extractionDuration = Date().timeIntervalSince(startTime)

        return ExtractionResult(
            title: title,
            author: nil,
            siteName: nil,
            publishDate: nil,
            rawText: cleaned,
            sections: sections,
            language: detectLanguage(cleaned),
            wordCount: wordCount,
            heroImageURL: nil,
            sourceURL: nil,
            metadata: ExtractionMetadata(
                extractorName: "ClipboardImportService",
                extractionDuration: extractionDuration,
                confidence: 1.0,
                warnings: [],
                originalContentSize: text.utf8.count,
                extractedContentSize: cleaned.utf8.count
            )
        )
    }

    private func extractFromHTML(_ html: String, plainText: String?, startTime: Date) throws -> ExtractionResult {
        // If we have plain text, use it directly
        if let plain = plainText, !plain.isEmpty {
            return try extractFromText(plain, startTime: startTime)
        }

        // Simple HTML stripping
        var text = html

        // Remove script and style content
        let patterns = [
            "<script[^>]*>.*?</script>",
            "<style[^>]*>.*?</style>",
            "<[^>]+>",  // Remove all remaining tags
            "&nbsp;",
            "&amp;",
            "&lt;",
            "&gt;",
            "&quot;"
        ]

        let replacements = ["", "", "", " ", "&", "<", ">", "\""]

        for (index, pattern) in patterns.enumerated() {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .dotMatchesLineSeparators]) {
                text = regex.stringByReplacingMatches(
                    in: text,
                    options: [],
                    range: NSRange(text.startIndex..., in: text),
                    withTemplate: replacements[index]
                )
            }
        }

        // Decode HTML entities
        text = text.replacingOccurrences(of: "&#39;", with: "'")
        text = text.replacingOccurrences(of: "&#x27;", with: "'")

        return try extractFromText(text, startTime: startTime)
    }

    private func extractFromRTF(_ data: Data, plainText: String?, startTime: Date) throws -> ExtractionResult {
        // If we have plain text, use it
        if let plain = plainText, !plain.isEmpty {
            return try extractFromText(plain, startTime: startTime)
        }

        // Try to convert RTF to plain text
        if let attributedString = try? NSAttributedString(
            data: data,
            options: [.documentType: NSAttributedString.DocumentType.rtf],
            documentAttributes: nil
        ) {
            return try extractFromText(attributedString.string, startTime: startTime)
        }

        throw ExtractionError.parsingFailed(reason: "Could not parse RTF content")
    }

    private func cleanText(_ text: String) -> String {
        var cleaned = text

        // Normalize line endings
        cleaned = cleaned.replacingOccurrences(of: "\r\n", with: "\n")
        cleaned = cleaned.replacingOccurrences(of: "\r", with: "\n")

        // Remove excessive whitespace
        while cleaned.contains("  ") {
            cleaned = cleaned.replacingOccurrences(of: "  ", with: " ")
        }

        while cleaned.contains("\n\n\n") {
            cleaned = cleaned.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }

        // Trim each line
        cleaned = cleaned
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .joined(separator: "\n")

        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func parseSections(from text: String) -> [ExtractedSection] {
        let paragraphs = text.components(separatedBy: "\n\n")
        var sections: [ExtractedSection] = []
        var currentOffset = 0

        for paragraph in paragraphs {
            let trimmed = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            let type: ArticleSectionType = sections.isEmpty ? .title : .paragraph

            sections.append(ExtractedSection(
                index: sections.count,
                type: type,
                text: trimmed,
                startOffset: currentOffset,
                endOffset: currentOffset + trimmed.count,
                attributes: [:]
            ))

            currentOffset += paragraph.count + 2
        }

        return sections
    }

    private func detectLanguage(_ text: String) -> String {
        let sample = String(text.prefix(1000))
        let englishWords = ["the", "is", "and", "of", "to", "in", "a", "that"]
        let words = sample.lowercased().split(separator: " ").map(String.init)
        let englishCount = words.filter { englishWords.contains($0) }.count

        if Float(englishCount) / Float(max(1, words.count)) > 0.1 {
            return "en"
        }

        return "en"
    }
}

// MARK: - Clipboard Content

enum ClipboardContent: Equatable {
    case text(String)
    case url(URL)
    case html(html: String, plainText: String?)
    case rtf(data: Data, plainText: String?)
    case pdf(data: Data)
    case image
    case empty
    case unsupported(types: [String])

    var displayName: String {
        switch self {
        case .text:
            return "Text"
        case .url:
            return "Web Link"
        case .html:
            return "Formatted Text"
        case .rtf:
            return "Rich Text"
        case .pdf:
            return "PDF Document"
        case .image:
            return "Image"
        case .empty:
            return "Empty"
        case .unsupported:
            return "Unsupported"
        }
    }

    var iconName: String {
        switch self {
        case .text:
            return "doc.text"
        case .url:
            return "link"
        case .html:
            return "doc.richtext"
        case .rtf:
            return "doc.richtext"
        case .pdf:
            return "doc.fill"
        case .image:
            return "photo"
        case .empty:
            return "clipboard"
        case .unsupported:
            return "questionmark.circle"
        }
    }

    var canImport: Bool {
        switch self {
        case .text, .url, .html, .rtf, .pdf:
            return true
        case .image, .empty, .unsupported:
            return false
        }
    }

    var preview: String? {
        switch self {
        case .text(let text):
            return String(text.prefix(100))
        case .url(let url):
            return url.absoluteString
        case .html(_, let plainText):
            return plainText.flatMap { String($0.prefix(100)) }
        case .rtf(_, let plainText):
            return plainText.flatMap { String($0.prefix(100)) }
        case .pdf:
            return "PDF Document"
        default:
            return nil
        }
    }

    static func == (lhs: ClipboardContent, rhs: ClipboardContent) -> Bool {
        switch (lhs, rhs) {
        case (.text(let a), .text(let b)):
            return a == b
        case (.url(let a), .url(let b)):
            return a == b
        case (.html(let a, _), .html(let b, _)):
            return a == b
        case (.rtf(let a, _), .rtf(let b, _)):
            return a == b
        case (.pdf(let a), .pdf(let b)):
            return a == b
        case (.image, .image):
            return true
        case (.empty, .empty):
            return true
        case (.unsupported(let a), .unsupported(let b)):
            return a == b
        default:
            return false
        }
    }
}
