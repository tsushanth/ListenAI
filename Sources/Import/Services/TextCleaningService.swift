import Foundation

// MARK: - Text Cleaning Service

/// Service for cleaning and normalizing extracted text for TTS.
struct TextCleaningService {

    // MARK: - Properties

    private let options: TextCleaningOptions

    // MARK: - Initialization

    init(options: TextCleaningOptions = .default) {
        self.options = options
    }

    // MARK: - Public Methods

    /// Clean text for TTS synthesis
    func clean(_ text: String) -> String {
        var result = text

        if options.normalizeWhitespace {
            result = normalizeWhitespace(result)
        }

        if options.removeURLs {
            result = removeURLs(result)
        }

        if options.removeNavigationText {
            result = removeNavigationText(result)
        }

        if options.expandAbbreviations {
            result = expandAbbreviations(result)
        }

        if options.simplifyNumbers {
            result = simplifyNumbers(result)
        }

        if options.removeEmojis {
            result = removeEmojis(result)
        }

        // Final cleanup
        result = normalizeWhitespace(result)

        return result.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Clean an extraction result
    func clean(_ result: ExtractionResult) -> ExtractionResult {
        let cleanedText = clean(result.rawText)
        let cleanedSections = result.sections.map { section in
            ExtractedSection(
                index: section.index,
                type: section.type,
                text: clean(section.text),
                startOffset: section.startOffset,
                endOffset: section.endOffset,
                attributes: section.attributes
            )
        }

        return ExtractionResult(
            title: result.title.map { clean($0) },
            author: result.author,
            siteName: result.siteName,
            publishDate: result.publishDate,
            rawText: cleanedText,
            sections: cleanedSections,
            language: result.language,
            wordCount: cleanedText.split(separator: " ").count,
            heroImageURL: result.heroImageURL,
            sourceURL: result.sourceURL,
            metadata: result.metadata
        )
    }

    // MARK: - Private Methods

    private func normalizeWhitespace(_ text: String) -> String {
        var result = text

        // Normalize line endings
        result = result.replacingOccurrences(of: "\r\n", with: "\n")
        result = result.replacingOccurrences(of: "\r", with: "\n")

        // Replace tabs with spaces
        result = result.replacingOccurrences(of: "\t", with: " ")

        // Remove zero-width characters
        result = result.replacingOccurrences(of: "\u{200B}", with: "")
        result = result.replacingOccurrences(of: "\u{200C}", with: "")
        result = result.replacingOccurrences(of: "\u{200D}", with: "")
        result = result.replacingOccurrences(of: "\u{FEFF}", with: "")

        // Collapse multiple spaces
        while result.contains("  ") {
            result = result.replacingOccurrences(of: "  ", with: " ")
        }

        // Collapse multiple newlines (keep max 2)
        while result.contains("\n\n\n") {
            result = result.replacingOccurrences(of: "\n\n\n", with: "\n\n")
        }

        // Trim each line
        result = result
            .components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .joined(separator: "\n")

        return result
    }

    private func removeURLs(_ text: String) -> String {
        var result = text

        // Remove http/https URLs
        let urlPattern = "https?://[^\\s\\)\\]\\}]+"
        if let regex = try? NSRegularExpression(pattern: urlPattern, options: []) {
            result = regex.stringByReplacingMatches(
                in: result,
                options: [],
                range: NSRange(result.startIndex..., in: result),
                withTemplate: ""
            )
        }

        // Remove www URLs
        let wwwPattern = "www\\.[^\\s\\)\\]\\}]+"
        if let regex = try? NSRegularExpression(pattern: wwwPattern, options: []) {
            result = regex.stringByReplacingMatches(
                in: result,
                options: [],
                range: NSRange(result.startIndex..., in: result),
                withTemplate: ""
            )
        }

        // Remove email addresses
        let emailPattern = "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"
        if let regex = try? NSRegularExpression(pattern: emailPattern, options: []) {
            result = regex.stringByReplacingMatches(
                in: result,
                options: [],
                range: NSRange(result.startIndex..., in: result),
                withTemplate: ""
            )
        }

        return result
    }

    private func removeNavigationText(_ text: String) -> String {
        var result = text

        // Common navigation patterns
        let patterns = [
            "(?i)^(home|menu|search|login|sign in|sign up|subscribe|newsletter)\\s*$",
            "(?i)^(share|tweet|facebook|twitter|linkedin|pinterest|email this)\\s*$",
            "(?i)^(previous|next|read more|continue reading|show more)\\s*$",
            "(?i)^(comments?|leave a comment|\\d+ comments?)\\s*$",
            "(?i)^(advertisement|sponsored|ad)\\s*$",
            "(?i)^(skip to (main )?content)\\s*$",
            "(?i)^(table of contents)\\s*$",
            "(?i)^(related articles?|you may also like|recommended)\\s*$"
        ]

        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) {
                result = regex.stringByReplacingMatches(
                    in: result,
                    options: [],
                    range: NSRange(result.startIndex..., in: result),
                    withTemplate: ""
                )
            }
        }

        return result
    }

    private func expandAbbreviations(_ text: String) -> String {
        var result = text

        // Common abbreviations
        let abbreviations: [(pattern: String, replacement: String)] = [
            ("\\betc\\.?\\b", "et cetera"),
            ("\\be\\.g\\.?\\b", "for example"),
            ("\\bi\\.e\\.?\\b", "that is"),
            ("\\bvs\\.?\\b", "versus"),
            ("\\bDr\\.\\s", "Doctor "),
            ("\\bMr\\.\\s", "Mister "),
            ("\\bMrs\\.\\s", "Missus "),
            ("\\bMs\\.\\s", "Miss "),
            ("\\bProf\\.\\s", "Professor "),
            ("\\bSt\\.\\s", "Saint "),
            ("\\bJr\\.?\\b", "Junior"),
            ("\\bSr\\.?\\b", "Senior"),
            ("\\bNo\\.\\s*(\\d)", "Number $1"),
            ("\\bvol\\.\\s*(\\d)", "volume $1"),
            ("\\bpp\\.\\s*(\\d)", "pages $1"),
            ("\\bca\\.\\s*(\\d)", "circa $1"),
            ("\\b&\\b", "and"),
            ("\\bw/\\b", "with"),
            ("\\bw/o\\b", "without"),
        ]

        for (pattern, replacement) in abbreviations {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                result = regex.stringByReplacingMatches(
                    in: result,
                    options: [],
                    range: NSRange(result.startIndex..., in: result),
                    withTemplate: replacement
                )
            }
        }

        return result
    }

    private func simplifyNumbers(_ text: String) -> String {
        var result = text

        // Format large numbers with words
        // $1,000,000 -> 1 million dollars
        let currencyPatterns: [(pattern: String, replacement: String)] = [
            ("\\$([\\d,]+)\\s*million", "$1 million dollars"),
            ("\\$([\\d,]+)\\s*billion", "$1 billion dollars"),
            ("\\$([\\d,]+)\\s*trillion", "$1 trillion dollars"),
        ]

        for (pattern, replacement) in currencyPatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                result = regex.stringByReplacingMatches(
                    in: result,
                    options: [],
                    range: NSRange(result.startIndex..., in: result),
                    withTemplate: replacement
                )
            }
        }

        // Format percentages
        result = result.replacingOccurrences(of: "%", with: " percent")

        // Remove commas from numbers for cleaner reading
        // But only in clearly numeric contexts
        let numberPattern = "(\\d),(?=\\d{3})"
        if let regex = try? NSRegularExpression(pattern: numberPattern, options: []) {
            result = regex.stringByReplacingMatches(
                in: result,
                options: [],
                range: NSRange(result.startIndex..., in: result),
                withTemplate: "$1"
            )
        }

        return result
    }

    private func removeEmojis(_ text: String) -> String {
        text.unicodeScalars.filter { !$0.properties.isEmoji }.map { String($0) }.joined()
    }
}

// MARK: - Convenience Extensions

extension String {

    /// Clean this string for TTS
    func cleanedForTTS(options: TextCleaningOptions = .default) -> String {
        TextCleaningService(options: options).clean(self)
    }
}

extension ExtractionResult {

    /// Clean this result for TTS
    func cleanedForTTS(options: TextCleaningOptions = .default) -> ExtractionResult {
        TextCleaningService(options: options).clean(self)
    }
}
