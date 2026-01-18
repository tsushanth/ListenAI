import Foundation

// MARK: - Extraction Result

/// Result of content extraction from any source.
struct ExtractionResult: Sendable {
    let title: String?
    let author: String?
    let siteName: String?
    let publishDate: Date?
    let rawText: String
    let sections: [ExtractedSection]
    let language: String
    let wordCount: Int
    let heroImageURL: URL?
    let sourceURL: URL?
    let metadata: ExtractionMetadata

    /// Convert to Article
    func toArticle(sourceType: SourceType, importMethod: ImportMethod = .inApp, sourceFileName: String? = nil) -> Article {
        Article(
            sourceType: sourceType,
            sourceURL: sourceURL,
            sourceFileName: sourceFileName,
            importMethod: importMethod,
            title: title ?? "Untitled",
            author: author,
            siteName: siteName,
            publishDate: publishDate,
            rawText: rawText,
            sections: sections.map { $0.toArticleSection() },
            wordCount: wordCount,
            language: language,
            heroImageURL: heroImageURL
        )
    }
}

// MARK: - Extracted Section

struct ExtractedSection: Sendable {
    let index: Int
    let type: ArticleSectionType
    let text: String
    let startOffset: Int
    let endOffset: Int
    let attributes: [String: String]

    func toArticleSection() -> ArticleSection {
        ArticleSection(
            id: UUID(),
            index: index,
            type: type,
            text: text,
            startOffset: startOffset,
            endOffset: endOffset
        )
    }
}

// MARK: - Extraction Metadata

struct ExtractionMetadata: Sendable {
    let extractorName: String
    let extractionDuration: TimeInterval
    let confidence: Float
    let warnings: [ExtractionWarning]
    let originalContentSize: Int
    let extractedContentSize: Int

    var compressionRatio: Float {
        guard originalContentSize > 0 else { return 0 }
        return Float(extractedContentSize) / Float(originalContentSize)
    }

    static let empty = ExtractionMetadata(
        extractorName: "unknown",
        extractionDuration: 0,
        confidence: 0,
        warnings: [],
        originalContentSize: 0,
        extractedContentSize: 0
    )
}

// MARK: - Extraction Warning

struct ExtractionWarning: Sendable {
    let type: WarningType
    let message: String
    let suggestion: String?

    enum WarningType: String, Sendable {
        case lowConfidence
        case truncatedContent
        case missingTitle
        case missingAuthor
        case paywalledContent
        case javascriptRequired
        case multipleColumns
        case scannedPDF
        case unsupportedEncoding
        case mixedLanguages
    }
}

// MARK: - Extraction Error

enum ExtractionError: LocalizedError, Sendable {
    case networkError(underlying: String)
    case invalidURL(url: String)
    case unsupportedFormat(format: String)
    case emptyContent
    case parsingFailed(reason: String)
    case pdfPasswordProtected
    case pdfCorrupted
    case pdfNoText
    case contentTooLarge(sizeBytes: Int64, limitBytes: Int64)
    case paywalledContent(domain: String)
    case timeout(seconds: Int)
    case cancelled
    case clipboardEmpty
    case clipboardNoText
    case fileNotFound(path: String)
    case fileAccessDenied(path: String)
    case unsupportedLanguage(language: String)
    case rateLimited(retryAfter: TimeInterval?)
    case serverError(statusCode: Int, message: String?)

    var errorDescription: String? {
        switch self {
        case .networkError(let underlying):
            return "Network error: \(underlying)"
        case .invalidURL(let url):
            return "Invalid URL: \(url)"
        case .unsupportedFormat(let format):
            return "Unsupported format: \(format)"
        case .emptyContent:
            return "No content could be extracted"
        case .parsingFailed(let reason):
            return "Failed to parse content: \(reason)"
        case .pdfPasswordProtected:
            return "PDF is password protected"
        case .pdfCorrupted:
            return "PDF file is corrupted"
        case .pdfNoText:
            return "PDF contains no extractable text (may be scanned)"
        case .contentTooLarge(let size, let limit):
            let sizeStr = ByteCountFormatter.string(fromByteCount: size, countStyle: .file)
            let limitStr = ByteCountFormatter.string(fromByteCount: limit, countStyle: .file)
            return "Content too large (\(sizeStr)). Maximum is \(limitStr)"
        case .paywalledContent(let domain):
            return "Content is behind a paywall on \(domain)"
        case .timeout(let seconds):
            return "Request timed out after \(seconds) seconds"
        case .cancelled:
            return "Extraction was cancelled"
        case .clipboardEmpty:
            return "Clipboard is empty"
        case .clipboardNoText:
            return "Clipboard contains no text"
        case .fileNotFound(let path):
            return "File not found: \(path)"
        case .fileAccessDenied(let path):
            return "Access denied: \(path)"
        case .unsupportedLanguage(let language):
            return "Unsupported language: \(language)"
        case .rateLimited(let retryAfter):
            if let seconds = retryAfter {
                return "Rate limited. Try again in \(Int(seconds)) seconds"
            }
            return "Rate limited. Please try again later"
        case .serverError(let code, let message):
            if let message = message {
                return "Server error (\(code)): \(message)"
            }
            return "Server error (\(code))"
        }
    }

    var recoverySuggestion: String? {
        switch self {
        case .networkError:
            return "Check your internet connection and try again"
        case .invalidURL:
            return "Make sure the URL is correct and includes http:// or https://"
        case .paywalledContent:
            return "Try copying the article text directly"
        case .pdfPasswordProtected:
            return "Open the PDF with the password first, then try again"
        case .pdfNoText:
            return "This PDF may be scanned. Try using OCR software first"
        case .contentTooLarge:
            return "Try importing a smaller portion of the content"
        case .timeout:
            return "The website may be slow. Try again later"
        case .clipboardEmpty, .clipboardNoText:
            return "Copy some text first, then try again"
        default:
            return nil
        }
    }

    var isRetryable: Bool {
        switch self {
        case .networkError, .timeout, .rateLimited, .serverError:
            return true
        default:
            return false
        }
    }
}

// MARK: - Import Progress

struct ImportProgress: Sendable {
    let stage: ImportStage
    let progress: Float
    let message: String

    enum ImportStage: String, Sendable {
        case fetching
        case parsing
        case extracting
        case cleaning
        case analyzing
        case synthesizing
        case complete
        case failed

        var displayName: String {
            switch self {
            case .fetching: return "Fetching content..."
            case .parsing: return "Parsing document..."
            case .extracting: return "Extracting text..."
            case .cleaning: return "Cleaning content..."
            case .analyzing: return "Analyzing structure..."
            case .synthesizing: return "Generating audio..."
            case .complete: return "Complete"
            case .failed: return "Failed"
            }
        }
    }

    static let initial = ImportProgress(stage: .fetching, progress: 0, message: "Starting...")
    static let complete = ImportProgress(stage: .complete, progress: 1.0, message: "Complete")
}

// MARK: - Content Source

/// Represents a source for content import.
enum ContentSource: Sendable {
    case url(URL)
    case pdfFile(URL)
    case pdfData(Data)
    case clipboard
    case text(String)
    case html(String, baseURL: URL?)
    case file(URL)

    var displayName: String {
        switch self {
        case .url(let url):
            return url.host ?? url.absoluteString
        case .pdfFile(let url):
            return url.lastPathComponent
        case .pdfData:
            return "PDF Document"
        case .clipboard:
            return "Clipboard"
        case .text:
            return "Text"
        case .html:
            return "HTML"
        case .file(let url):
            return url.lastPathComponent
        }
    }

    var sourceType: SourceType {
        switch self {
        case .url, .html:
            return .web
        case .pdfFile, .pdfData:
            return .pdf
        case .clipboard:
            return .clipboard
        case .text:
            return .manual
        case .file:
            return .file
        }
    }
}

// MARK: - Text Cleaner Options

struct TextCleaningOptions: Sendable {
    // HTML handling
    var stripHTML: Bool = true

    // URL/Email removal
    var removeURLs: Bool = true

    // Email-specific cleaning
    var removeEmailHeaders: Bool = true
    var removeEmailSignatures: Bool = true

    // Web-specific cleaning
    var removeBoilerplate: Bool = true
    var removeNavigationText: Bool = true

    // Text normalization
    var normalizeWhitespace: Bool = true
    var expandAbbreviations: Bool = true
    var simplifyNumbers: Bool = true

    // Content filtering
    var removeEmojis: Bool = false
    var removeCodeBlocks: Bool = false
    var preserveEmphasis: Bool = true

    /// Default options - good balance for most content
    static let `default` = TextCleaningOptions()

    /// Aggressive cleaning - for maximum sanitization
    static let aggressive = TextCleaningOptions(
        stripHTML: true,
        removeURLs: true,
        removeEmailHeaders: true,
        removeEmailSignatures: true,
        removeBoilerplate: true,
        removeNavigationText: true,
        normalizeWhitespace: true,
        expandAbbreviations: true,
        simplifyNumbers: true,
        removeEmojis: true,
        removeCodeBlocks: true,
        preserveEmphasis: false
    )

    /// Minimal cleaning - preserve most original content
    static let minimal = TextCleaningOptions(
        stripHTML: true,
        removeURLs: false,
        removeEmailHeaders: false,
        removeEmailSignatures: false,
        removeBoilerplate: false,
        removeNavigationText: false,
        normalizeWhitespace: true,
        expandAbbreviations: false,
        simplifyNumbers: false,
        removeEmojis: false,
        removeCodeBlocks: false,
        preserveEmphasis: true
    )

    /// Email-optimized cleaning
    static let email = TextCleaningOptions(
        stripHTML: true,
        removeURLs: true,
        removeEmailHeaders: true,
        removeEmailSignatures: true,
        removeBoilerplate: true,
        removeNavigationText: true,
        normalizeWhitespace: true,
        expandAbbreviations: true,
        simplifyNumbers: true,
        removeEmojis: false,
        removeCodeBlocks: false,
        preserveEmphasis: true
    )

    /// Web article-optimized cleaning
    static let webArticle = TextCleaningOptions(
        stripHTML: true,
        removeURLs: true,
        removeEmailHeaders: false,
        removeEmailSignatures: false,
        removeBoilerplate: true,
        removeNavigationText: true,
        normalizeWhitespace: true,
        expandAbbreviations: true,
        simplifyNumbers: true,
        removeEmojis: false,
        removeCodeBlocks: false,
        preserveEmphasis: true
    )
}
