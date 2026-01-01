import Foundation
import PDFKit

// MARK: - PDF Import Service

/// Service for extracting text content from PDF documents.
actor PDFImportService {

    // MARK: - Properties

    private let maxPageCount: Int
    private let maxFileSizeBytes: Int64

    // MARK: - Singleton

    static let shared = PDFImportService()

    // MARK: - Initialization

    init(
        maxPageCount: Int = 500,
        maxFileSizeBytes: Int64 = 50 * 1024 * 1024 // 50 MB
    ) {
        self.maxPageCount = maxPageCount
        self.maxFileSizeBytes = maxFileSizeBytes
    }

    // MARK: - Public Methods

    /// Extract content from a PDF file URL
    func extract(from fileURL: URL) async throws -> ExtractionResult {
        let startTime = Date()

        // Check file exists
        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            throw ExtractionError.fileNotFound(path: fileURL.path)
        }

        // Check file size
        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let fileSize = attributes[.size] as? Int64 ?? 0

        if fileSize > maxFileSizeBytes {
            throw ExtractionError.contentTooLarge(sizeBytes: fileSize, limitBytes: maxFileSizeBytes)
        }

        // Load PDF
        guard let document = PDFDocument(url: fileURL) else {
            throw ExtractionError.pdfCorrupted
        }

        return try await extractFromDocument(
            document,
            sourceURL: fileURL,
            fileName: fileURL.lastPathComponent,
            originalSize: Int(fileSize),
            startTime: startTime
        )
    }

    /// Extract content from PDF data
    func extract(from data: Data) async throws -> ExtractionResult {
        let startTime = Date()

        // Check size
        if data.count > maxFileSizeBytes {
            throw ExtractionError.contentTooLarge(
                sizeBytes: Int64(data.count),
                limitBytes: maxFileSizeBytes
            )
        }

        // Load PDF
        guard let document = PDFDocument(data: data) else {
            throw ExtractionError.pdfCorrupted
        }

        return try await extractFromDocument(
            document,
            sourceURL: nil,
            fileName: "Document.pdf",
            originalSize: data.count,
            startTime: startTime
        )
    }

    // MARK: - Private Methods

    private func extractFromDocument(
        _ document: PDFDocument,
        sourceURL: URL?,
        fileName: String,
        originalSize: Int,
        startTime: Date
    ) async throws -> ExtractionResult {
        // Check if encrypted
        if document.isEncrypted && document.isLocked {
            throw ExtractionError.pdfPasswordProtected
        }

        let pageCount = document.pageCount

        // Check page count
        if pageCount > maxPageCount {
            throw ExtractionError.contentTooLarge(
                sizeBytes: Int64(pageCount),
                limitBytes: Int64(maxPageCount)
            )
        }

        // Extract text from all pages
        var allText: [String] = []
        var pageTexts: [(pageNumber: Int, text: String)] = []
        var warnings: [ExtractionWarning] = []

        for pageIndex in 0..<pageCount {
            guard let page = document.page(at: pageIndex) else { continue }

            if let pageText = page.string {
                let cleaned = cleanPageText(pageText)
                if !cleaned.isEmpty {
                    allText.append(cleaned)
                    pageTexts.append((pageIndex + 1, cleaned))
                }
            }
        }

        let combinedText = allText.joined(separator: "\n\n")

        // Check if we got any text
        if combinedText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            // Try to detect if it's a scanned PDF
            if let firstPage = document.page(at: 0),
               let annotations = firstPage.annotations,
               annotations.isEmpty {
                throw ExtractionError.pdfNoText
            }
            throw ExtractionError.emptyContent
        }

        // Extract metadata
        let title = extractTitle(from: document, fileName: fileName, text: combinedText)
        let author = document.documentAttributes?[PDFDocumentAttribute.authorAttribute] as? String

        // Parse into sections
        let sections = parseSections(from: combinedText, pageTexts: pageTexts)

        // Detect potential issues
        if sections.count < 3 && pageCount > 5 {
            warnings.append(ExtractionWarning(
                type: .lowConfidence,
                message: "PDF may contain mostly images or scanned content",
                suggestion: "Consider using OCR software for better results"
            ))
        }

        // Check for multi-column layout issues
        if detectMultiColumnLayout(combinedText) {
            warnings.append(ExtractionWarning(
                type: .multipleColumns,
                message: "Multi-column layout detected",
                suggestion: "Text order may not be correct. Review the extracted content."
            ))
        }

        let wordCount = combinedText.split(separator: " ").count
        let extractionDuration = Date().timeIntervalSince(startTime)

        // Calculate confidence
        let charsPerPage = combinedText.count / max(1, pageCount)
        let confidence: Float = min(1.0, Float(charsPerPage) / 1000.0)

        return ExtractionResult(
            title: title,
            author: author,
            siteName: nil,
            publishDate: extractCreationDate(from: document),
            rawText: combinedText,
            sections: sections,
            language: detectLanguage(combinedText),
            wordCount: wordCount,
            heroImageURL: nil,
            sourceURL: sourceURL,
            metadata: ExtractionMetadata(
                extractorName: "PDFImportService",
                extractionDuration: extractionDuration,
                confidence: confidence,
                warnings: warnings,
                originalContentSize: originalSize,
                extractedContentSize: combinedText.utf8.count
            )
        )
    }

    private func extractTitle(from document: PDFDocument, fileName: String, text: String) -> String {
        // Try document title attribute
        if let title = document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String,
           !title.isEmpty {
            return title
        }

        // Try first line of text if it looks like a title
        let firstLine = text.components(separatedBy: "\n").first ?? ""
        if firstLine.count > 5 && firstLine.count < 200 && !firstLine.contains(".") {
            return firstLine.trimmingCharacters(in: .whitespacesAndNewlines)
        }

        // Fall back to filename without extension
        let name = (fileName as NSString).deletingPathExtension
        return name.replacingOccurrences(of: "_", with: " ")
            .replacingOccurrences(of: "-", with: " ")
    }

    private func extractCreationDate(from document: PDFDocument) -> Date? {
        if let date = document.documentAttributes?[PDFDocumentAttribute.creationDateAttribute] as? Date {
            return date
        }
        return nil
    }

    private func cleanPageText(_ text: String) -> String {
        var cleaned = text

        // Remove page numbers (common patterns)
        let pageNumberPatterns = [
            "^\\d+\\s*$",           // Just a number
            "^Page\\s+\\d+",        // "Page X"
            "^-\\s*\\d+\\s*-$",     // "- X -"
            "\\d+\\s*of\\s*\\d+",   // "X of Y"
        ]

        for pattern in pageNumberPatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive, .anchorsMatchLines]) {
                cleaned = regex.stringByReplacingMatches(
                    in: cleaned,
                    options: [],
                    range: NSRange(cleaned.startIndex..., in: cleaned),
                    withTemplate: ""
                )
            }
        }

        // Remove headers/footers that repeat
        // (Would need more context for accurate detection)

        // Normalize whitespace
        cleaned = cleaned.replacingOccurrences(of: "\r\n", with: "\n")
        cleaned = cleaned.replacingOccurrences(of: "\r", with: "\n")

        // Fix broken words (hyphenation at line breaks)
        cleaned = cleaned.replacingOccurrences(of: "-\n", with: "")

        // Remove excessive whitespace
        while cleaned.contains("  ") {
            cleaned = cleaned.replacingOccurrences(of: "  ", with: " ")
        }

        while cleaned.contains("\n\n\n") {
            cleaned = cleaned.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }

        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func parseSections(
        from text: String,
        pageTexts: [(pageNumber: Int, text: String)]
    ) -> [ExtractedSection] {
        var sections: [ExtractedSection] = []
        let paragraphs = text.components(separatedBy: "\n\n")
        var currentOffset = 0

        for paragraph in paragraphs {
            let trimmed = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.count > 10 else { continue } // Skip very short paragraphs

            // Detect section type
            let type = detectSectionType(trimmed)

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

    private func detectSectionType(_ text: String) -> ArticleSectionType {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)

        // Check for heading patterns
        if trimmed.count < 100 {
            // All caps might be a heading
            if trimmed == trimmed.uppercased() && trimmed.contains(" ") {
                return .heading
            }

            // Numbered sections
            if trimmed.range(of: "^\\d+\\.\\s+[A-Z]", options: .regularExpression) != nil {
                return .heading
            }

            // Chapter markers
            if trimmed.lowercased().hasPrefix("chapter") {
                return .heading
            }
        }

        // Check for list items
        if trimmed.hasPrefix("•") || trimmed.hasPrefix("-") ||
           trimmed.range(of: "^\\d+\\.", options: .regularExpression) != nil {
            return .listItem
        }

        // Check for quotes (indented or starting with quote marks)
        if trimmed.hasPrefix("\"") || trimmed.hasPrefix(""") {
            return .blockquote
        }

        return .paragraph
    }

    private func detectMultiColumnLayout(_ text: String) -> Bool {
        let lines = text.components(separatedBy: "\n")
        var shortLineCount = 0

        for line in lines {
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            // If many lines are between 30-50 characters, might be multi-column
            if trimmed.count >= 30 && trimmed.count <= 50 {
                shortLineCount += 1
            }
        }

        // If more than 30% of lines are "column-width", suspect multi-column
        let ratio = Float(shortLineCount) / Float(max(1, lines.count))
        return ratio > 0.3
    }

    private func detectLanguage(_ text: String) -> String {
        let sample = String(text.prefix(1000))
        let englishWords = ["the", "is", "and", "of", "to", "in", "a", "that", "for", "it"]
        let words = sample.lowercased().split(separator: " ").map(String.init)
        let englishCount = words.filter { englishWords.contains($0) }.count

        if Float(englishCount) / Float(max(1, words.count)) > 0.1 {
            return "en"
        }

        return "en" // Default
    }
}

// MARK: - PDF Page Analysis

extension PDFImportService {

    /// Analyze a PDF to get information without full extraction
    func analyze(fileURL: URL) async throws -> PDFAnalysis {
        guard let document = PDFDocument(url: fileURL) else {
            throw ExtractionError.pdfCorrupted
        }

        let attributes = try FileManager.default.attributesOfItem(atPath: fileURL.path)
        let fileSize = attributes[.size] as? Int64 ?? 0

        var hasText = false
        var totalCharacters = 0

        // Sample first few pages
        for i in 0..<min(5, document.pageCount) {
            if let page = document.page(at: i), let text = page.string {
                if !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    hasText = true
                    totalCharacters += text.count
                }
            }
        }

        // Estimate total characters
        let avgCharsPerPage = totalCharacters / max(1, min(5, document.pageCount))
        let estimatedTotalChars = avgCharsPerPage * document.pageCount

        return PDFAnalysis(
            pageCount: document.pageCount,
            fileSizeBytes: fileSize,
            hasExtractableText: hasText,
            isEncrypted: document.isEncrypted,
            isLocked: document.isLocked,
            title: document.documentAttributes?[PDFDocumentAttribute.titleAttribute] as? String,
            author: document.documentAttributes?[PDFDocumentAttribute.authorAttribute] as? String,
            estimatedWordCount: estimatedTotalChars / 5,
            estimatedReadingTime: TimeInterval(estimatedTotalChars / 5) / 150.0 * 60.0
        )
    }
}

// MARK: - PDF Analysis Result

struct PDFAnalysis: Sendable {
    let pageCount: Int
    let fileSizeBytes: Int64
    let hasExtractableText: Bool
    let isEncrypted: Bool
    let isLocked: Bool
    let title: String?
    let author: String?
    let estimatedWordCount: Int
    let estimatedReadingTime: TimeInterval

    var fileSizeFormatted: String {
        ByteCountFormatter.string(fromByteCount: fileSizeBytes, countStyle: .file)
    }

    var readingTimeFormatted: String {
        let minutes = Int(estimatedReadingTime / 60)
        if minutes < 1 {
            return "< 1 min"
        } else if minutes == 1 {
            return "1 min"
        } else {
            return "\(minutes) mins"
        }
    }

    var canExtract: Bool {
        hasExtractableText && !isLocked
    }
}
