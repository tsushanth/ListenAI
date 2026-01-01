import Foundation
import WebKit

// MARK: - Web Import Service

/// Service for extracting article content from web pages using reader mode extraction.
actor WebImportService {

    // MARK: - Properties

    private let session: URLSession
    private let timeout: TimeInterval
    private let maxContentSize: Int64

    // JavaScript for reader mode extraction (Readability-style)
    private let readerModeJS: String = """
    (function() {
        // Simple article extraction
        function extractArticle() {
            let result = {
                title: '',
                author: '',
                siteName: '',
                publishDate: '',
                content: '',
                heroImage: ''
            };

            // Title extraction
            result.title = document.querySelector('meta[property="og:title"]')?.content
                || document.querySelector('meta[name="twitter:title"]')?.content
                || document.querySelector('h1')?.innerText
                || document.title
                || '';

            // Author extraction
            result.author = document.querySelector('meta[name="author"]')?.content
                || document.querySelector('meta[property="article:author"]')?.content
                || document.querySelector('[rel="author"]')?.innerText
                || document.querySelector('.author')?.innerText
                || document.querySelector('[class*="author"]')?.innerText
                || '';

            // Site name
            result.siteName = document.querySelector('meta[property="og:site_name"]')?.content
                || window.location.hostname.replace('www.', '')
                || '';

            // Publish date
            result.publishDate = document.querySelector('meta[property="article:published_time"]')?.content
                || document.querySelector('time')?.getAttribute('datetime')
                || document.querySelector('[class*="date"]')?.innerText
                || '';

            // Hero image
            result.heroImage = document.querySelector('meta[property="og:image"]')?.content
                || document.querySelector('meta[name="twitter:image"]')?.content
                || document.querySelector('article img')?.src
                || '';

            // Content extraction - try multiple strategies
            let article = document.querySelector('article')
                || document.querySelector('[role="main"]')
                || document.querySelector('main')
                || document.querySelector('.post-content')
                || document.querySelector('.article-content')
                || document.querySelector('.entry-content')
                || document.querySelector('.content')
                || document.querySelector('#content');

            if (article) {
                // Clone to avoid modifying original
                let clone = article.cloneNode(true);

                // Remove unwanted elements
                let removeSelectors = [
                    'script', 'style', 'nav', 'header', 'footer', 'aside',
                    '.ad', '.ads', '.advertisement', '.social-share',
                    '.comments', '.related', '.sidebar', '.navigation',
                    '[class*="share"]', '[class*="social"]', '[class*="comment"]',
                    '[class*="related"]', '[class*="recommended"]', '[class*="newsletter"]',
                    'form', 'iframe', 'video', 'audio'
                ];

                removeSelectors.forEach(selector => {
                    clone.querySelectorAll(selector).forEach(el => el.remove());
                });

                // Extract text with structure
                result.content = extractTextWithStructure(clone);
            } else {
                // Fallback: get body text
                result.content = extractTextWithStructure(document.body);
            }

            return result;
        }

        function extractTextWithStructure(element) {
            let blocks = [];
            let currentBlock = '';

            function processNode(node) {
                if (node.nodeType === Node.TEXT_NODE) {
                    let text = node.textContent.trim();
                    if (text) {
                        currentBlock += text + ' ';
                    }
                } else if (node.nodeType === Node.ELEMENT_NODE) {
                    let tag = node.tagName.toLowerCase();

                    // Skip hidden elements
                    let style = window.getComputedStyle(node);
                    if (style.display === 'none' || style.visibility === 'hidden') {
                        return;
                    }

                    // Block elements create new paragraphs
                    let blockTags = ['p', 'div', 'article', 'section', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
                                     'blockquote', 'li', 'tr', 'br', 'hr'];

                    if (blockTags.includes(tag)) {
                        if (currentBlock.trim()) {
                            blocks.push(currentBlock.trim());
                            currentBlock = '';
                        }

                        // Add heading markers
                        if (tag.match(/^h[1-6]$/)) {
                            currentBlock = '## ';
                        } else if (tag === 'blockquote') {
                            currentBlock = '> ';
                        } else if (tag === 'li') {
                            currentBlock = '• ';
                        }
                    }

                    // Process children
                    for (let child of node.childNodes) {
                        processNode(child);
                    }

                    // End block after block elements
                    if (blockTags.includes(tag) && currentBlock.trim()) {
                        blocks.push(currentBlock.trim());
                        currentBlock = '';
                    }
                }
            }

            processNode(element);

            if (currentBlock.trim()) {
                blocks.push(currentBlock.trim());
            }

            // Clean up and join
            return blocks
                .filter(b => b.length > 20 || b.startsWith('##') || b.startsWith('>'))
                .join('\\n\\n');
        }

        return JSON.stringify(extractArticle());
    })();
    """

    // MARK: - Singleton

    static let shared = WebImportService()

    // MARK: - Initialization

    init(
        timeout: TimeInterval = 30,
        maxContentSize: Int64 = 10 * 1024 * 1024 // 10 MB
    ) {
        let config = URLSessionConfiguration.default
        config.timeoutIntervalForRequest = timeout
        config.timeoutIntervalForResource = timeout * 2
        self.session = URLSession(configuration: config)
        self.timeout = timeout
        self.maxContentSize = maxContentSize
    }

    // MARK: - Public Methods

    /// Extract article content from a URL
    func extract(from url: URL) async throws -> ExtractionResult {
        let startTime = Date()

        // Validate URL
        guard url.scheme == "http" || url.scheme == "https" else {
            throw ExtractionError.invalidURL(url: url.absoluteString)
        }

        // Fetch HTML content
        let (data, response) = try await fetchContent(from: url)

        // Check response
        guard let httpResponse = response as? HTTPURLResponse else {
            throw ExtractionError.networkError(underlying: "Invalid response type")
        }

        switch httpResponse.statusCode {
        case 200..<300:
            break // Success
        case 401, 403:
            throw ExtractionError.paywalledContent(domain: url.host ?? "unknown")
        case 429:
            let retryAfter = httpResponse.value(forHTTPHeaderField: "Retry-After")
                .flatMap { Double($0) }
            throw ExtractionError.rateLimited(retryAfter: retryAfter)
        case 404:
            throw ExtractionError.networkError(underlying: "Page not found (404)")
        case 500..<600:
            throw ExtractionError.serverError(
                statusCode: httpResponse.statusCode,
                message: HTTPURLResponse.localizedString(forStatusCode: httpResponse.statusCode)
            )
        default:
            throw ExtractionError.serverError(statusCode: httpResponse.statusCode, message: nil)
        }

        // Check content size
        if data.count > maxContentSize {
            throw ExtractionError.contentTooLarge(
                sizeBytes: Int64(data.count),
                limitBytes: maxContentSize
            )
        }

        // Decode HTML
        guard let html = String(data: data, encoding: .utf8)
                ?? String(data: data, encoding: .isoLatin1) else {
            throw ExtractionError.parsingFailed(reason: "Unable to decode HTML content")
        }

        // Extract using WKWebView (on main thread)
        let extraction = try await extractUsingWebView(html: html, baseURL: url)

        let extractionDuration = Date().timeIntervalSince(startTime)

        // Parse extracted content
        let result = try parseExtraction(
            extraction,
            sourceURL: url,
            originalSize: data.count,
            duration: extractionDuration
        )

        return result
    }

    /// Extract from raw HTML
    func extract(html: String, baseURL: URL?) async throws -> ExtractionResult {
        let startTime = Date()

        let extraction = try await extractUsingWebView(html: html, baseURL: baseURL)

        let extractionDuration = Date().timeIntervalSince(startTime)

        return try parseExtraction(
            extraction,
            sourceURL: baseURL,
            originalSize: html.utf8.count,
            duration: extractionDuration
        )
    }

    // MARK: - Private Methods

    private func fetchContent(from url: URL) async throws -> (Data, URLResponse) {
        var request = URLRequest(url: url)
        request.setValue("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", forHTTPHeaderField: "User-Agent")
        request.setValue("text/html,application/xhtml+xml", forHTTPHeaderField: "Accept")

        do {
            return try await session.data(for: request)
        } catch let error as URLError {
            switch error.code {
            case .timedOut:
                throw ExtractionError.timeout(seconds: Int(timeout))
            case .notConnectedToInternet, .networkConnectionLost:
                throw ExtractionError.networkError(underlying: "No internet connection")
            case .cannotFindHost:
                throw ExtractionError.networkError(underlying: "Cannot find host: \(url.host ?? "")")
            case .cancelled:
                throw ExtractionError.cancelled
            default:
                throw ExtractionError.networkError(underlying: error.localizedDescription)
            }
        }
    }

    @MainActor
    private func extractUsingWebView(html: String, baseURL: URL?) async throws -> [String: Any] {
        return try await withCheckedThrowingContinuation { continuation in
            let webView = WKWebView(frame: .zero)

            // Load HTML
            webView.loadHTMLString(html, baseURL: baseURL)

            // Wait for load and execute extraction
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                webView.evaluateJavaScript(self.readerModeJS) { result, error in
                    if let error = error {
                        continuation.resume(throwing: ExtractionError.parsingFailed(
                            reason: error.localizedDescription
                        ))
                        return
                    }

                    guard let jsonString = result as? String,
                          let jsonData = jsonString.data(using: .utf8),
                          let json = try? JSONSerialization.jsonObject(with: jsonData) as? [String: Any] else {
                        continuation.resume(throwing: ExtractionError.parsingFailed(
                            reason: "Failed to parse extraction result"
                        ))
                        return
                    }

                    continuation.resume(returning: json)
                }
            }
        }
    }

    private func parseExtraction(
        _ extraction: [String: Any],
        sourceURL: URL?,
        originalSize: Int,
        duration: TimeInterval
    ) throws -> ExtractionResult {
        let content = extraction["content"] as? String ?? ""

        // Clean content
        let cleanedContent = cleanText(content)

        guard !cleanedContent.isEmpty else {
            throw ExtractionError.emptyContent
        }

        // Parse sections
        let sections = parseSections(from: cleanedContent)

        // Parse publish date
        var publishDate: Date?
        if let dateString = extraction["publishDate"] as? String, !dateString.isEmpty {
            publishDate = parseDate(dateString)
        }

        // Parse hero image URL
        var heroImageURL: URL?
        if let imageString = extraction["heroImage"] as? String, !imageString.isEmpty {
            heroImageURL = URL(string: imageString)
        }

        // Detect language
        let language = detectLanguage(cleanedContent)

        // Build warnings
        var warnings: [ExtractionWarning] = []

        if (extraction["title"] as? String)?.isEmpty ?? true {
            warnings.append(ExtractionWarning(
                type: .missingTitle,
                message: "No title found",
                suggestion: "You can add a title manually"
            ))
        }

        if (extraction["author"] as? String)?.isEmpty ?? true {
            warnings.append(ExtractionWarning(
                type: .missingAuthor,
                message: "No author found",
                suggestion: nil
            ))
        }

        let wordCount = cleanedContent.split(separator: " ").count
        if wordCount < 100 {
            warnings.append(ExtractionWarning(
                type: .lowConfidence,
                message: "Extracted content is very short (\(wordCount) words)",
                suggestion: "The page may require JavaScript or contain mostly non-text content"
            ))
        }

        let confidence: Float = min(1.0, Float(wordCount) / 500.0)

        return ExtractionResult(
            title: extraction["title"] as? String,
            author: extraction["author"] as? String,
            siteName: extraction["siteName"] as? String,
            publishDate: publishDate,
            rawText: cleanedContent,
            sections: sections,
            language: language,
            wordCount: wordCount,
            heroImageURL: heroImageURL,
            sourceURL: sourceURL,
            metadata: ExtractionMetadata(
                extractorName: "WebImportService",
                extractionDuration: duration,
                confidence: confidence,
                warnings: warnings,
                originalContentSize: originalSize,
                extractedContentSize: cleanedContent.utf8.count
            )
        )
    }

    private func parseSections(from text: String) -> [ExtractedSection] {
        let paragraphs = text.components(separatedBy: "\n\n")
        var sections: [ExtractedSection] = []
        var currentOffset = 0

        for (index, paragraph) in paragraphs.enumerated() {
            let trimmed = paragraph.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }

            // Determine section type
            let type: ArticleSectionType
            if trimmed.hasPrefix("## ") {
                type = .heading
            } else if trimmed.hasPrefix("> ") {
                type = .blockquote
            } else if trimmed.hasPrefix("• ") {
                type = .listItem
            } else if index == 0 {
                type = .title
            } else {
                type = .paragraph
            }

            // Clean section markers
            var cleanedText = trimmed
            if cleanedText.hasPrefix("## ") {
                cleanedText = String(cleanedText.dropFirst(3))
            } else if cleanedText.hasPrefix("> ") {
                cleanedText = String(cleanedText.dropFirst(2))
            } else if cleanedText.hasPrefix("• ") {
                cleanedText = String(cleanedText.dropFirst(2))
            }

            sections.append(ExtractedSection(
                index: sections.count,
                type: type,
                text: cleanedText,
                startOffset: currentOffset,
                endOffset: currentOffset + cleanedText.count,
                attributes: [:]
            ))

            currentOffset += paragraph.count + 2
        }

        return sections
    }

    private func cleanText(_ text: String) -> String {
        var cleaned = text

        // Normalize whitespace
        cleaned = cleaned.replacingOccurrences(of: "\r\n", with: "\n")
        cleaned = cleaned.replacingOccurrences(of: "\r", with: "\n")

        // Remove excessive newlines
        while cleaned.contains("\n\n\n") {
            cleaned = cleaned.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }

        // Remove excessive spaces
        while cleaned.contains("  ") {
            cleaned = cleaned.replacingOccurrences(of: "  ", with: " ")
        }

        // Trim each line
        cleaned = cleaned
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .joined(separator: "\n")

        return cleaned.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func parseDate(_ string: String) -> Date? {
        let formatters: [ISO8601DateFormatter] = [
            {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withInternetDateTime]
                return f
            }(),
            {
                let f = ISO8601DateFormatter()
                f.formatOptions = [.withFullDate]
                return f
            }()
        ]

        for formatter in formatters {
            if let date = formatter.date(from: string) {
                return date
            }
        }

        // Try common date formats
        let dateFormatters = ["yyyy-MM-dd", "MM/dd/yyyy", "MMMM d, yyyy"]
        for format in dateFormatters {
            let formatter = DateFormatter()
            formatter.dateFormat = format
            if let date = formatter.date(from: string) {
                return date
            }
        }

        return nil
    }

    private func detectLanguage(_ text: String) -> String {
        // Use Natural Language framework
        let sample = String(text.prefix(1000))

        // Simple heuristic detection
        let englishWords = ["the", "is", "and", "of", "to", "in", "a", "that"]
        let words = sample.lowercased().split(separator: " ").map(String.init)

        let englishCount = words.filter { englishWords.contains($0) }.count
        let englishRatio = Float(englishCount) / Float(max(1, words.count))

        if englishRatio > 0.1 {
            return "en"
        }

        return "en" // Default to English
    }
}
