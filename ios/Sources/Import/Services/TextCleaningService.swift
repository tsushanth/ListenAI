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

        // Always strip HTML first if present
        if options.stripHTML {
            result = stripHTML(result)
        }

        if options.normalizeWhitespace {
            result = normalizeWhitespace(result)
        }

        if options.removeURLs {
            result = removeURLs(result)
        }

        if options.removeEmailHeaders {
            result = removeEmailHeaders(result)
        }

        if options.removeEmailSignatures {
            result = removeEmailSignatures(result)
        }

        if options.removeBoilerplate {
            result = removeBoilerplate(result)
        }

        if options.removeNavigationText {
            result = removeNavigationText(result)
        }

        // TTS-specific formatting (always apply for best audio quality)
        result = removeImageCaptions(result)
        result = removeCitations(result)
        result = formatDates(result)
        result = formatTimes(result)
        result = formatOrdinals(result)
        result = formatAcronyms(result)
        result = formatPhoneNumbers(result)
        result = formatSymbols(result)
        result = formatMathNotation(result)
        result = formatCurrency(result)

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
        result = normalizePunctuation(result)
        result = removeEmptyLines(result)

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

    // MARK: - HTML Stripping

    private func stripHTML(_ text: String) -> String {
        var result = text

        // Convert common block elements to newlines
        let blockTags = ["</p>", "</div>", "</li>", "</tr>", "</h1>", "</h2>", "</h3>", "</h4>", "</h5>", "</h6>", "</blockquote>", "</article>", "</section>"]
        for tag in blockTags {
            result = result.replacingOccurrences(of: tag, with: "\n\n", options: .caseInsensitive)
        }

        // Convert line breaks
        result = result.replacingOccurrences(of: "<br>", with: "\n", options: .caseInsensitive)
        result = result.replacingOccurrences(of: "<br/>", with: "\n", options: .caseInsensitive)
        result = result.replacingOccurrences(of: "<br />", with: "\n", options: .caseInsensitive)

        // Remove script and style content entirely (including content)
        let scriptPattern = "<script[^>]*>[\\s\\S]*?</script>"
        if let regex = try? NSRegularExpression(pattern: scriptPattern, options: [.caseInsensitive]) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
        }

        let stylePattern = "<style[^>]*>[\\s\\S]*?</style>"
        if let regex = try? NSRegularExpression(pattern: stylePattern, options: [.caseInsensitive]) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
        }

        // Remove all remaining HTML tags
        let tagPattern = "<[^>]+>"
        if let regex = try? NSRegularExpression(pattern: tagPattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
        }

        // Decode HTML entities
        result = decodeHTMLEntities(result)

        return result
    }

    private func decodeHTMLEntities(_ text: String) -> String {
        var result = text

        // Common named entities
        let entities: [(String, String)] = [
            ("&nbsp;", " "),
            ("&amp;", "&"),
            ("&lt;", "<"),
            ("&gt;", ">"),
            ("&quot;", "\""),
            ("&#39;", "'"),
            ("&apos;", "'"),
            ("&ndash;", "-"),
            ("&mdash;", " - "),
            ("&lsquo;", "'"),
            ("&rsquo;", "'"),
            ("&ldquo;", "\""),
            ("&rdquo;", "\""),
            ("&bull;", ""),
            ("&hellip;", "..."),
            ("&copy;", ""),
            ("&reg;", ""),
            ("&trade;", ""),
            ("&euro;", "euros"),
            ("&pound;", "pounds"),
            ("&yen;", "yen"),
            ("&cent;", "cents"),
            ("&times;", "times"),
            ("&divide;", "divided by"),
            ("&deg;", " degrees"),
            ("&plusmn;", "plus or minus"),
            ("&frac12;", "one half"),
            ("&frac14;", "one quarter"),
            ("&frac34;", "three quarters"),
        ]

        for (entity, replacement) in entities {
            result = result.replacingOccurrences(of: entity, with: replacement, options: .caseInsensitive)
        }

        // Numeric entities (decimal)
        let decimalPattern = "&#(\\d+);"
        if let regex = try? NSRegularExpression(pattern: decimalPattern, options: []) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let numberRange = Range(match.range(at: 1), in: result),
                   let codePoint = Int(result[numberRange]),
                   let scalar = Unicode.Scalar(codePoint) {
                    result.replaceSubrange(range, with: String(Character(scalar)))
                }
            }
        }

        // Numeric entities (hex)
        let hexPattern = "&#x([0-9a-fA-F]+);"
        if let regex = try? NSRegularExpression(pattern: hexPattern, options: []) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let hexRange = Range(match.range(at: 1), in: result),
                   let codePoint = Int(result[hexRange], radix: 16),
                   let scalar = Unicode.Scalar(codePoint) {
                    result.replaceSubrange(range, with: String(Character(scalar)))
                }
            }
        }

        return result
    }

    // MARK: - TTS Date & Time Formatting

    private func formatDates(_ text: String) -> String {
        var result = text

        let monthNames = ["January", "February", "March", "April", "May", "June",
                          "July", "August", "September", "October", "November", "December"]
        let monthAbbrev = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

        // MM/DD/YYYY or MM-DD-YYYY format
        let usDatePattern = "\\b(0?[1-9]|1[0-2])[/\\-](0?[1-9]|[12]\\d|3[01])[/\\-](\\d{4}|\\d{2})\\b"
        if let regex = try? NSRegularExpression(pattern: usDatePattern, options: []) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let monthRange = Range(match.range(at: 1), in: result),
                   let dayRange = Range(match.range(at: 2), in: result),
                   let yearRange = Range(match.range(at: 3), in: result),
                   let month = Int(result[monthRange]),
                   let day = Int(result[dayRange]) {
                    let yearStr = String(result[yearRange])
                    let year = yearStr.count == 2 ? "20\(yearStr)" : yearStr
                    let monthName = monthNames[month - 1]
                    let dayOrdinal = ordinalString(for: day)
                    result.replaceSubrange(range, with: "\(monthName) \(dayOrdinal), \(year)")
                }
            }
        }

        // DD/MM/YYYY (European) - only convert if day > 12 to distinguish
        let euDatePattern = "\\b(1[3-9]|2\\d|3[01])[/\\-](0?[1-9]|1[0-2])[/\\-](\\d{4}|\\d{2})\\b"
        if let regex = try? NSRegularExpression(pattern: euDatePattern, options: []) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let dayRange = Range(match.range(at: 1), in: result),
                   let monthRange = Range(match.range(at: 2), in: result),
                   let yearRange = Range(match.range(at: 3), in: result),
                   let day = Int(result[dayRange]),
                   let month = Int(result[monthRange]) {
                    let yearStr = String(result[yearRange])
                    let year = yearStr.count == 2 ? "20\(yearStr)" : yearStr
                    let monthName = monthNames[month - 1]
                    let dayOrdinal = ordinalString(for: day)
                    result.replaceSubrange(range, with: "\(monthName) \(dayOrdinal), \(year)")
                }
            }
        }

        // "Jan 15, 2026" or "January 15, 2026" -> "January 15th, 2026"
        let monthDayYearPattern = "\\b(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(\\d{4})?\\b"
        if let regex = try? NSRegularExpression(pattern: monthDayYearPattern, options: [.caseInsensitive]) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let monthRange = Range(match.range(at: 1), in: result),
                   let dayRange = Range(match.range(at: 2), in: result),
                   let day = Int(result[dayRange]) {
                    let monthStr = String(result[monthRange])
                    // Expand abbreviated month
                    var fullMonth = monthStr
                    for (i, abbrev) in monthAbbrev.enumerated() {
                        if monthStr.lowercased().hasPrefix(abbrev.lowercased()) {
                            fullMonth = monthNames[i]
                            break
                        }
                    }
                    let dayOrdinal = ordinalString(for: day)
                    var replacement = "\(fullMonth) \(dayOrdinal)"
                    if match.numberOfRanges > 3, let yearRange = Range(match.range(at: 3), in: result) {
                        let year = String(result[yearRange])
                        replacement += ", \(year)"
                    }
                    result.replaceSubrange(range, with: replacement)
                }
            }
        }

        // ISO format: 2026-01-15
        let isoDatePattern = "\\b(\\d{4})-(0?[1-9]|1[0-2])-(0?[1-9]|[12]\\d|3[01])\\b"
        if let regex = try? NSRegularExpression(pattern: isoDatePattern, options: []) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let yearRange = Range(match.range(at: 1), in: result),
                   let monthRange = Range(match.range(at: 2), in: result),
                   let dayRange = Range(match.range(at: 3), in: result),
                   let month = Int(result[monthRange]),
                   let day = Int(result[dayRange]) {
                    let year = String(result[yearRange])
                    let monthName = monthNames[month - 1]
                    let dayOrdinal = ordinalString(for: day)
                    result.replaceSubrange(range, with: "\(monthName) \(dayOrdinal), \(year)")
                }
            }
        }

        return result
    }

    private func formatTimes(_ text: String) -> String {
        var result = text

        // 3:30pm, 3:30 PM, 3:30p.m.
        let time12Pattern = "\\b(1[0-2]|0?[1-9]):([0-5]\\d)\\s*(a\\.?m\\.?|p\\.?m\\.?)\\b"
        if let regex = try? NSRegularExpression(pattern: time12Pattern, options: [.caseInsensitive]) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let hourRange = Range(match.range(at: 1), in: result),
                   let minuteRange = Range(match.range(at: 2), in: result),
                   let periodRange = Range(match.range(at: 3), in: result) {
                    let hour = String(result[hourRange])
                    let minute = String(result[minuteRange])
                    let period = String(result[periodRange]).lowercased().replacingOccurrences(of: ".", with: "")
                    let periodFull = period.hasPrefix("a") ? "AM" : "PM"
                    if minute == "00" {
                        result.replaceSubrange(range, with: "\(hour) \(periodFull)")
                    } else {
                        result.replaceSubrange(range, with: "\(hour):\(minute) \(periodFull)")
                    }
                }
            }
        }

        // 24-hour format: 14:30, 09:15
        let time24Pattern = "\\b([01]?\\d|2[0-3]):([0-5]\\d)(?::[0-5]\\d)?\\b"
        if let regex = try? NSRegularExpression(pattern: time24Pattern, options: []) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let hourRange = Range(match.range(at: 1), in: result),
                   let minuteRange = Range(match.range(at: 2), in: result),
                   let hour24 = Int(result[hourRange]) {
                    let minute = String(result[minuteRange])
                    // Only convert times that look like 24-hour (13:00+)
                    if hour24 >= 13 {
                        let hour12 = hour24 > 12 ? hour24 - 12 : hour24
                        let period = hour24 >= 12 ? "PM" : "AM"
                        if minute == "00" {
                            result.replaceSubrange(range, with: "\(hour12) \(period)")
                        } else {
                            result.replaceSubrange(range, with: "\(hour12):\(minute) \(period)")
                        }
                    }
                }
            }
        }

        return result
    }

    // MARK: - Ordinal Formatting

    private func formatOrdinals(_ text: String) -> String {
        var result = text

        // Convert 1st, 2nd, 3rd, 4th etc to spoken form
        let ordinalPattern = "\\b(\\d+)(st|nd|rd|th)\\b"
        if let regex = try? NSRegularExpression(pattern: ordinalPattern, options: [.caseInsensitive]) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let numberRange = Range(match.range(at: 1), in: result),
                   let number = Int(result[numberRange]) {
                    let ordinal = ordinalString(for: number)
                    result.replaceSubrange(range, with: ordinal)
                }
            }
        }

        // Roman numerals in context: "Chapter IV", "Part III", "Volume II"
        let romanContextPattern = "\\b(Chapter|Part|Volume|Book|Act|Scene|Section|Article|Amendment)\\s+(I{1,3}|IV|V|VI{0,3}|IX|X{1,3}|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX{0,3})\\b"
        if let regex = try? NSRegularExpression(pattern: romanContextPattern, options: [.caseInsensitive]) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let contextRange = Range(match.range(at: 1), in: result),
                   let romanRange = Range(match.range(at: 2), in: result) {
                    let context = String(result[contextRange])
                    let roman = String(result[romanRange])
                    if let arabic = romanToArabic(roman) {
                        result.replaceSubrange(range, with: "\(context) \(arabic)")
                    }
                }
            }
        }

        return result
    }

    private func ordinalString(for number: Int) -> String {
        // Special cases for small numbers
        let smallOrdinals = [
            1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth",
            6: "sixth", 7: "seventh", 8: "eighth", 9: "ninth", 10: "tenth",
            11: "eleventh", 12: "twelfth", 13: "thirteenth", 14: "fourteenth",
            15: "fifteenth", 16: "sixteenth", 17: "seventeenth", 18: "eighteenth",
            19: "nineteenth", 20: "twentieth", 21: "twenty-first", 22: "twenty-second",
            23: "twenty-third", 24: "twenty-fourth", 25: "twenty-fifth",
            26: "twenty-sixth", 27: "twenty-seventh", 28: "twenty-eighth",
            29: "twenty-ninth", 30: "thirtieth", 31: "thirty-first"
        ]

        if let ordinal = smallOrdinals[number] {
            return ordinal
        }

        // For larger numbers, just add the suffix
        let suffix: String
        let lastTwoDigits = number % 100
        let lastDigit = number % 10

        if lastTwoDigits >= 11 && lastTwoDigits <= 13 {
            suffix = "th"
        } else {
            switch lastDigit {
            case 1: suffix = "st"
            case 2: suffix = "nd"
            case 3: suffix = "rd"
            default: suffix = "th"
            }
        }

        return "\(number)\(suffix)"
    }

    private func romanToArabic(_ roman: String) -> Int? {
        let romanValues: [Character: Int] = [
            "I": 1, "V": 5, "X": 10, "L": 50, "C": 100, "D": 500, "M": 1000
        ]

        var result = 0
        var prevValue = 0

        for char in roman.uppercased().reversed() {
            guard let value = romanValues[char] else { return nil }
            if value < prevValue {
                result -= value
            } else {
                result += value
            }
            prevValue = value
        }

        return result > 0 ? result : nil
    }

    // MARK: - Acronym Formatting

    private func formatAcronyms(_ text: String) -> String {
        var result = text

        // Acronyms that should be spelled out (read letter by letter)
        let spellOutAcronyms = Set([
            "FBI", "CIA", "NSA", "IRS", "DMV", "CEO", "CFO", "CTO", "COO",
            "PhD", "MBA", "MD", "JD", "BA", "BS", "MA", "MS",
            "USA", "UK", "EU", "UN", "NYC", "LA", "SF", "DC",
            "TV", "PC", "DVD", "CD", "USB", "GPS", "ATM", "PIN",
            "ID", "VIP", "DIY", "FAQ", "FYI", "ASAP", "ETA", "TBA", "TBD",
            "HR", "PR", "IT", "QA", "R&D", "VP", "SVP", "EVP",
            "IPO", "ROI", "KPI", "SaaS", "B2B", "B2C",
            "HTML", "CSS", "API", "URL", "PDF", "AI", "ML", "VR", "AR",
            "BMI", "BMX", "CPR", "DNA", "RNA", "HIV", "AIDS",
            "MPH", "MPG", "PSI", "RPM", "AC", "DC", "AM", "PM", "FM",
            "RSVP", "PS", "NB", "BTW", "IMO", "IMHO", "OMG", "LOL",
        ])

        // Acronyms that should be read as words (proper nouns/organizations)
        let readAsWordAcronyms = Set([
            "NASA", "NATO", "UNICEF", "UNESCO", "OPEC", "NAFTA",
            "POTUS", "FLOTUS", "SCOTUS",
            "SWAT", "SCUBA", "RADAR", "LASER", "SONAR",
            "AIDS", "SARS", "COVID",
            "GIF", "JPEG", "PING", "RAM", "ROM", "SIM",
            "CAPTCHA", "WYSIWYG",
        ])

        // Process all-caps words (2-6 letters)
        let acronymPattern = "\\b([A-Z]{2,6})\\b"
        if let regex = try? NSRegularExpression(pattern: acronymPattern, options: []) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result) {
                    let acronym = String(result[range])

                    // Skip if it's meant to be read as a word
                    if readAsWordAcronyms.contains(acronym) {
                        continue
                    }

                    // Spell out if in the spell-out list
                    if spellOutAcronyms.contains(acronym) {
                        let spelled = acronym.map { String($0) }.joined(separator: " ")
                        result.replaceSubrange(range, with: spelled)
                    }
                    // For unknown acronyms, leave as-is (TTS will handle)
                }
            }
        }

        return result
    }

    // MARK: - Phone Number Formatting

    private func formatPhoneNumbers(_ text: String) -> String {
        var result = text

        // US phone: (555) 123-4567 or 555-123-4567 or 555.123.4567
        let phonePattern = "\\(?\\b(\\d{3})\\)?[-.\\s]?(\\d{3})[-.\\s]?(\\d{4})\\b"
        if let regex = try? NSRegularExpression(pattern: phonePattern, options: []) {
            let matches = regex.matches(in: result, range: NSRange(result.startIndex..., in: result))
            for match in matches.reversed() {
                if let range = Range(match.range, in: result),
                   let areaRange = Range(match.range(at: 1), in: result),
                   let prefixRange = Range(match.range(at: 2), in: result),
                   let lineRange = Range(match.range(at: 3), in: result) {
                    let area = String(result[areaRange])
                    let prefix = String(result[prefixRange])
                    let line = String(result[lineRange])
                    // Read as grouped digits
                    let formatted = "\(area), \(prefix), \(line)"
                    result.replaceSubrange(range, with: formatted)
                }
            }
        }

        return result
    }

    // MARK: - Symbol Formatting

    private func formatSymbols(_ text: String) -> String {
        var result = text

        // Currency symbols to words
        let currencyReplacements: [(String, String)] = [
            ("€", " euros"),
            ("£", " pounds"),
            ("¥", " yen"),
            ("₹", " rupees"),
            ("₽", " rubles"),
            ("₿", " bitcoin"),
            ("¢", " cents"),
        ]

        for (symbol, word) in currencyReplacements {
            // Handle symbol before number: €50 -> 50 euros
            let beforePattern = "\(symbol)\\s*(\\d)"
            if let regex = try? NSRegularExpression(pattern: beforePattern, options: []) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1\(word)")
            }
        }

        // Dollar sign handling (more complex due to common usage)
        // $50 -> 50 dollars, but keep context aware
        let dollarPattern = "\\$(\\d+(?:,\\d{3})*(?:\\.\\d{2})?)"
        if let regex = try? NSRegularExpression(pattern: dollarPattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1 dollars")
        }

        // Mathematical symbols
        let mathSymbols: [(String, String)] = [
            ("×", " times "),
            ("÷", " divided by "),
            ("±", " plus or minus "),
            ("≈", " approximately "),
            ("≠", " not equal to "),
            ("≤", " less than or equal to "),
            ("≥", " greater than or equal to "),
            ("∞", " infinity "),
            ("√", " square root of "),
            ("∑", " sum of "),
            ("∏", " product of "),
            ("∫", " integral of "),
            ("π", " pi "),
            ("°", " degrees"),
            ("′", " feet"),
            ("″", " inches"),
            ("†", ""),
            ("‡", ""),
            ("§", "section "),
            ("¶", "paragraph "),
            ("©", ""),
            ("®", ""),
            ("™", ""),
        ]

        for (symbol, word) in mathSymbols {
            result = result.replacingOccurrences(of: symbol, with: word)
        }

        // Bullet points and list markers
        result = result.replacingOccurrences(of: "•", with: "")
        result = result.replacingOccurrences(of: "◦", with: "")
        result = result.replacingOccurrences(of: "▪", with: "")
        result = result.replacingOccurrences(of: "▸", with: "")
        result = result.replacingOccurrences(of: "►", with: "")
        result = result.replacingOccurrences(of: "→", with: "")
        result = result.replacingOccurrences(of: "⇒", with: "")
        result = result.replacingOccurrences(of: "✓", with: "")
        result = result.replacingOccurrences(of: "✔", with: "")
        result = result.replacingOccurrences(of: "✗", with: "")
        result = result.replacingOccurrences(of: "✘", with: "")
        result = result.replacingOccurrences(of: "★", with: "")
        result = result.replacingOccurrences(of: "☆", with: "")

        // Quotation marks - normalize to standard
        result = result.replacingOccurrences(of: "\u{201C}", with: "\"") // Left double quote "
        result = result.replacingOccurrences(of: "\u{201D}", with: "\"") // Right double quote "
        result = result.replacingOccurrences(of: "\u{2018}", with: "'")  // Left single quote '
        result = result.replacingOccurrences(of: "\u{2019}", with: "'")  // Right single quote '
        result = result.replacingOccurrences(of: "\u{00AB}", with: "\"") // Left guillemet «
        result = result.replacingOccurrences(of: "\u{00BB}", with: "\"") // Right guillemet »

        // Dashes - normalize
        result = result.replacingOccurrences(of: "—", with: " - ")
        result = result.replacingOccurrences(of: "–", with: " - ")
        result = result.replacingOccurrences(of: "―", with: " - ")

        // Ellipsis
        result = result.replacingOccurrences(of: "…", with: "...")

        return result
    }

    // MARK: - Math Notation Formatting

    private func formatMathNotation(_ text: String) -> String {
        var result = text

        // Exponents: 10^6 -> 10 to the power of 6
        let exponentPattern = "(\\d+)\\^(\\d+)"
        if let regex = try? NSRegularExpression(pattern: exponentPattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1 to the power of $2")
        }

        // Superscript numbers (if present as actual superscript chars)
        let superscripts: [(String, String)] = [
            ("⁰", "0"), ("¹", "1"), ("²", "2"), ("³", "3"), ("⁴", "4"),
            ("⁵", "5"), ("⁶", "6"), ("⁷", "7"), ("⁸", "8"), ("⁹", "9"),
        ]
        for (sup, num) in superscripts {
            result = result.replacingOccurrences(of: sup, with: num)
        }

        // Subscript numbers
        let subscripts: [(String, String)] = [
            ("₀", "0"), ("₁", "1"), ("₂", "2"), ("₃", "3"), ("₄", "4"),
            ("₅", "5"), ("₆", "6"), ("₇", "7"), ("₈", "8"), ("₉", "9"),
        ]
        for (sub, num) in subscripts {
            result = result.replacingOccurrences(of: sub, with: num)
        }

        // Fractions
        let fractions: [(String, String)] = [
            ("½", "one half"),
            ("⅓", "one third"),
            ("⅔", "two thirds"),
            ("¼", "one quarter"),
            ("¾", "three quarters"),
            ("⅕", "one fifth"),
            ("⅖", "two fifths"),
            ("⅗", "three fifths"),
            ("⅘", "four fifths"),
            ("⅙", "one sixth"),
            ("⅚", "five sixths"),
            ("⅛", "one eighth"),
            ("⅜", "three eighths"),
            ("⅝", "five eighths"),
            ("⅞", "seven eighths"),
        ]
        for (frac, word) in fractions {
            result = result.replacingOccurrences(of: frac, with: word)
        }

        return result
    }

    // MARK: - Currency Formatting

    private func formatCurrency(_ text: String) -> String {
        var result = text

        // Already handled $X -> X dollars in formatSymbols
        // Add millions/billions context
        let largeAmountPatterns: [(String, String)] = [
            ("(\\d+(?:\\.\\d+)?)\\s*million\\s*dollars", "$1 million dollars"),
            ("(\\d+(?:\\.\\d+)?)\\s*billion\\s*dollars", "$1 billion dollars"),
            ("(\\d+(?:\\.\\d+)?)\\s*trillion\\s*dollars", "$1 trillion dollars"),
            ("(\\d+(?:\\.\\d+)?)M\\b", "$1 million"),
            ("(\\d+(?:\\.\\d+)?)B\\b", "$1 billion"),
            ("(\\d+(?:\\.\\d+)?)T\\b", "$1 trillion"),
            ("(\\d+(?:\\.\\d+)?)K\\b", "$1 thousand"),
        ]

        for (pattern, replacement) in largeAmountPatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: replacement)
            }
        }

        return result
    }

    // MARK: - Image Caption & Citation Removal

    private func removeImageCaptions(_ text: String) -> String {
        var result = text

        let captionPatterns = [
            // Photo/Image credits
            "(?i)^(Photo|Image|Picture|Illustration|Graphic|Screenshot|Credit|Source):?\\s*.+$",
            "(?i)^(Photo|Image)\\s+(by|credit|courtesy|via|from):?\\s*.+$",
            "(?i)^\\(?(Photo|Image|Pic)\\s*(by|credit|courtesy)?:?\\s*[^)]+\\)?$",
            "(?i)^Credit:?\\s*.+$",
            "(?i)^Source:?\\s*.+$",
            "(?i)^Via:?\\s*.+$",
            "(?i)^Courtesy:?\\s*(of)?\\s*.+$",
            // Getty, Reuters, AP, etc.
            "(?i)^.{0,30}(Getty|Reuters|AP|AFP|EPA|Shutterstock|iStock|Unsplash|Pexels).{0,50}$",
            // Figure/Table captions
            "(?i)^(Figure|Fig\\.|Table|Chart|Graph|Diagram)\\s*\\d+:?\\s*.{0,100}$",
            // Alt text patterns
            "(?i)^\\[?(Image|Photo|Picture|Screenshot)\\s*(description|alt)?:?\\s*.+\\]?$",
            // Embedded image markers
            "(?i)^\\[image\\]$",
            "(?i)^\\[photo\\]$",
            "(?i)^<image>$",
        ]

        for pattern in captionPatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
            }
        }

        return result
    }

    private func removeCitations(_ text: String) -> String {
        var result = text

        // Inline citations: [1], [2,3], [1-5], (1), etc.
        let inlineCitationPatterns = [
            "\\[\\d+(?:[,\\-]\\d+)*\\]",  // [1], [1,2], [1-3]
            "\\(\\d+(?:[,\\-]\\d+)*\\)",  // (1), (1,2), (1-3)
            "\\[\\w+\\s*\\d{4}\\w?\\]",   // [Smith 2020], [Smith 2020a]
            "\\(\\w+\\s*\\d{4}\\w?\\)",   // (Smith 2020)
            "\\[\\w+\\s+et\\s+al\\.?,?\\s*\\d{4}\\]",  // [Smith et al., 2020]
            "\\(\\w+\\s+et\\s+al\\.?,?\\s*\\d{4}\\)",  // (Smith et al., 2020)
        ]

        for pattern in inlineCitationPatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: []) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
            }
        }

        // Footnote markers: superscript numbers, asterisks
        let footnotePattern = "\\*+(?!\\s*\\*)"  // asterisks not followed by more asterisks
        if let regex = try? NSRegularExpression(pattern: footnotePattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
        }

        // Reference section at end
        let referencePatterns = [
            "(?i)^References:?\\s*$[\\s\\S]*",
            "(?i)^Bibliography:?\\s*$[\\s\\S]*",
            "(?i)^Works Cited:?\\s*$[\\s\\S]*",
            "(?i)^Sources:?\\s*$[\\s\\S]*",
            "(?i)^Endnotes:?\\s*$[\\s\\S]*",
            "(?i)^Footnotes:?\\s*$[\\s\\S]*",
        ]

        for pattern in referencePatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
            }
        }

        return result
    }

    // MARK: - Email Cleaning

    private func removeEmailHeaders(_ text: String) -> String {
        var result = text

        // Remove common email header patterns
        let headerPatterns = [
            "(?i)^From:\\s*.+$",
            "(?i)^To:\\s*.+$",
            "(?i)^Cc:\\s*.+$",
            "(?i)^Bcc:\\s*.+$",
            "(?i)^Subject:\\s*.+$",
            "(?i)^Date:\\s*.+$",
            "(?i)^Sent:\\s*.+$",
            "(?i)^Reply-To:\\s*.+$",
            "(?i)^Importance:\\s*.+$",
            "(?i)^Priority:\\s*.+$",
            "(?i)^X-[A-Za-z-]+:\\s*.+$",
            "(?i)^Content-Type:\\s*.+$",
            "(?i)^MIME-Version:\\s*.+$",
            // Forwarded email markers
            "(?i)^-+\\s*Forwarded message\\s*-+$",
            "(?i)^-+\\s*Original Message\\s*-+$",
            "(?i)^Begin forwarded message:$",
            // Reply markers
            "(?i)^On .+ wrote:$",
            "^>+.*$", // Quoted text lines
        ]

        for pattern in headerPatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
            }
        }

        return result
    }

    private func removeEmailSignatures(_ text: String) -> String {
        var result = text

        // Common signature patterns
        let signaturePatterns = [
            // Standard signature delimiters
            "(?i)^--\\s*$[\\s\\S]*",
            "(?i)^___+\\s*$[\\s\\S]*",
            "(?i)^Best regards?,?\\s*$[\\s\\S]{0,500}$",
            "(?i)^Kind regards?,?\\s*$[\\s\\S]{0,500}$",
            "(?i)^Regards?,?\\s*$[\\s\\S]{0,500}$",
            "(?i)^Thanks?,?\\s*$[\\s\\S]{0,500}$",
            "(?i)^Thank you,?\\s*$[\\s\\S]{0,500}$",
            "(?i)^Sincerely,?\\s*$[\\s\\S]{0,500}$",
            "(?i)^Cheers,?\\s*$[\\s\\S]{0,500}$",
            "(?i)^Sent from my iPhone\\s*$",
            "(?i)^Sent from my iPad\\s*$",
            "(?i)^Sent from my Android\\s*$",
            "(?i)^Sent from Mail for Windows\\s*$",
            "(?i)^Get Outlook for \\w+\\s*$",
            // Legal disclaimers
            "(?i)^This email and any attachments.{50,}$",
            "(?i)^CONFIDENTIALITY NOTICE.{50,}$",
            "(?i)^DISCLAIMER:.{50,}$",
            "(?i)^This message contains confidential.{50,}$",
            "(?i)^If you are not the intended recipient.{50,}$",
            // Unsubscribe links
            "(?i)^To unsubscribe.+$",
            "(?i)^Click here to unsubscribe.+$",
            "(?i)^Manage your email preferences.+$",
            "(?i)^Update subscription preferences.+$",
        ]

        for pattern in signaturePatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
            }
        }

        return result
    }

    // MARK: - Boilerplate Removal

    private func removeBoilerplate(_ text: String) -> String {
        var result = text

        // Website boilerplate patterns
        let boilerplatePatterns = [
            // Cookie/Privacy notices
            "(?i)^We use cookies.+$",
            "(?i)^This site uses cookies.+$",
            "(?i)^By continuing to use.+cookies.+$",
            "(?i)^Accept (all )?cookies?$",
            "(?i)^Cookie (settings|preferences|policy)$",
            "(?i)^Privacy (policy|notice|settings)$",
            // Newsletter prompts
            "(?i)^Sign up for our newsletter.+$",
            "(?i)^Subscribe to our newsletter.+$",
            "(?i)^Get the latest news.+inbox.+$",
            "(?i)^Enter your email.+$",
            "(?i)^Join \\d+[,\\d]* subscribers.+$",
            // Social media
            "(?i)^Follow us on.+$",
            "(?i)^Like us on Facebook.+$",
            "(?i)^Share this (article|post|story).+$",
            "(?i)^Share on (Twitter|Facebook|LinkedIn|X).+$",
            // Author bios at end
            "(?i)^About the author.{0,20}$",
            "(?i)^\\w+ is a (writer|journalist|reporter|editor|contributor).+$",
            // Article metadata
            "(?i)^\\d+ (min|minute)s? read$",
            "(?i)^Reading time: \\d+ (min|minute)s?$",
            "(?i)^Published:?.+\\d{4}$",
            "(?i)^Updated:?.+\\d{4}$",
            "(?i)^Last modified:?.+\\d{4}$",
            "(?i)^By \\w+ \\w+,? (Staff|Writer|Reporter|Editor)$",
            // Comments section markers
            "(?i)^\\d+ comments?$",
            "(?i)^Leave a comment$",
            "(?i)^Join the conversation$",
            "(?i)^What do you think\\??$",
            // Related content
            "(?i)^Related (articles?|posts?|stories?|content):?$",
            "(?i)^You may also like:?$",
            "(?i)^Recommended for you:?$",
            "(?i)^More from .+:?$",
            "(?i)^Popular (articles?|posts?|stories?):?$",
            "(?i)^Trending (now|today):?$",
            // Footer content
            "(?i)^All rights reserved\\.?$",
            "(?i)^Copyright ©?.+\\d{4}.+$",
            "(?i)^Terms (of (service|use)|and conditions)$",
            "(?i)^Contact us$",
            "(?i)^About us$",
            "(?i)^Advertise with us$",
            "(?i)^Careers$",
            "(?i)^Help center$",
            // Paywall/subscription prompts
            "(?i)^Subscribe (now|today) to (continue|keep) reading.+$",
            "(?i)^This (article|content) is for subscribers only.+$",
            "(?i)^Already a subscriber\\? (Log|Sign) in.+$",
            "(?i)^Unlock this (article|story) with a subscription.+$",
            // Ads
            "(?i)^Advertisement$",
            "(?i)^Sponsored content$",
            "(?i)^Promoted$",
        ]

        for pattern in boilerplatePatterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
            }
        }

        return result
    }

    // MARK: - Whitespace & Line Handling

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
        result = result.replacingOccurrences(of: "\u{00A0}", with: " ") // Non-breaking space

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

    private func normalizePunctuation(_ text: String) -> String {
        var result = text

        // Remove multiple punctuation marks
        let multiPunctPattern = "([.!?]){2,}"
        if let regex = try? NSRegularExpression(pattern: multiPunctPattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1")
        }

        // Add space after punctuation if missing (but not for abbreviations)
        let punctSpacePattern = "([.!?,;:])([A-Za-z])"
        if let regex = try? NSRegularExpression(pattern: punctSpacePattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1 $2")
        }

        // Remove space before punctuation
        let spaceBeforePunctPattern = "\\s+([.!?,;:])"
        if let regex = try? NSRegularExpression(pattern: spaceBeforePunctPattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1")
        }

        return result
    }

    private func removeEmptyLines(_ text: String) -> String {
        text
            .components(separatedBy: "\n")
            .filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            .joined(separator: "\n\n")
    }

    // MARK: - URL Removal

    private func removeURLs(_ text: String) -> String {
        var result = text

        // Remove http/https URLs
        let urlPattern = "https?://[^\\s\\)\\]\\}]+"
        if let regex = try? NSRegularExpression(pattern: urlPattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
        }

        // Remove www URLs
        let wwwPattern = "www\\.[^\\s\\)\\]\\}]+"
        if let regex = try? NSRegularExpression(pattern: wwwPattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
        }

        // Remove email addresses
        let emailPattern = "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}"
        if let regex = try? NSRegularExpression(pattern: emailPattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
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
            "(?i)^(related articles?|you may also like|recommended)\\s*$",
            "(?i)^(back to top)\\s*$",
            "(?i)^(print|download|save)\\s*$",
            "(?i)^(copy link|bookmark)\\s*$",
        ]

        for pattern in patterns {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.anchorsMatchLines]) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "")
            }
        }

        return result
    }

    private func expandAbbreviations(_ text: String) -> String {
        var result = text

        // Common abbreviations - ordered by specificity (longer patterns first)
        let abbreviations: [(pattern: String, replacement: String)] = [
            // Titles (must come before single letter patterns)
            ("\\bDr\\.\\s", "Doctor "),
            ("\\bMr\\.\\s", "Mister "),
            ("\\bMrs\\.\\s", "Missus "),
            ("\\bMs\\.\\s", "Miss "),
            ("\\bProf\\.\\s", "Professor "),
            ("\\bSt\\.\\s", "Saint "),
            ("\\bJr\\.?\\b", "Junior"),
            ("\\bSr\\.?\\b", "Senior"),
            ("\\bGen\\.\\s", "General "),
            ("\\bCol\\.\\s", "Colonel "),
            ("\\bLt\\.\\s", "Lieutenant "),
            ("\\bSgt\\.\\s", "Sergeant "),
            ("\\bCpl\\.\\s", "Corporal "),
            ("\\bPvt\\.\\s", "Private "),
            ("\\bAdm\\.\\s", "Admiral "),
            ("\\bRev\\.\\s", "Reverend "),
            ("\\bHon\\.\\s", "Honorable "),
            ("\\bGov\\.\\s", "Governor "),
            ("\\bSen\\.\\s", "Senator "),
            ("\\bRep\\.\\s", "Representative "),

            // Common abbreviations
            ("\\betc\\.?\\b", "et cetera"),
            ("\\be\\.g\\.?\\b", "for example"),
            ("\\bi\\.e\\.?\\b", "that is"),
            ("\\bvs\\.?\\b", "versus"),
            ("\\baka\\b", "also known as"),
            ("\\ba\\.k\\.a\\.?\\b", "also known as"),
            ("\\bapprox\\.?\\b", "approximately"),
            ("\\basap\\b", "as soon as possible"),
            // These require a period to avoid false positives (e.g., "est" in "best")
            ("\\bdept\\.\\b", "department"),
            ("\\best\\.\\b", "established"),
            ("\\bgovt\\.\\b", "government"),
            ("\\bincl\\.\\b", "including"),
            ("\\bmax\\.\\b", "maximum"),
            ("\\bmin\\.\\b", "minimum"),
            ("\\bmisc\\.\\b", "miscellaneous"),

            // Units and measurements
            ("\\bNo\\.\\s*(\\d)", "Number $1"),
            ("\\bvol\\.\\s*(\\d)", "volume $1"),
            ("\\bpp\\.\\s*(\\d)", "pages $1"),
            ("\\bca\\.\\s*(\\d)", "circa $1"),
            // Only expand "ft" and "in" when preceded by a number (e.g., "6 ft" → "6 feet")
            // This prevents "in the" from becoming "inches the"
            ("(\\d)\\s*ft\\.?\\b", "$1 feet"),
            ("(\\d)\\s*in\\.?\\b", "$1 inches"),
            ("\\blb\\.?\\b", "pounds"),
            ("\\boz\\.?\\b", "ounces"),
            ("\\byd\\.?\\b", "yards"),
            // Only expand "mi" when preceded by a number to avoid matching words like "Miami"
            ("(\\d)\\s*mi\\.?\\b", "$1 miles"),
            ("\\bkm\\.?\\b", "kilometers"),
            ("\\bcm\\.?\\b", "centimeters"),
            ("\\bmm\\.?\\b", "millimeters"),
            ("\\bkg\\.?\\b", "kilograms"),
            ("\\bmg\\.?\\b", "milligrams"),
            ("\\bml\\.?\\b", "milliliters"),
            ("\\bsq\\.?\\s*ft\\.?\\b", "square feet"),
            ("\\bsq\\.?\\s*mi\\.?\\b", "square miles"),
            ("\\bcu\\.?\\s*ft\\.?\\b", "cubic feet"),

            // Time-related - require period to avoid false positives
            // (e.g., "sec" in "section", "sat" in "satellite", "sun" as the star)
            ("(\\d)\\s*hr\\.?\\b", "$1 hour"),
            ("(\\d)\\s*hrs\\.?\\b", "$1 hours"),
            ("(\\d)\\s*sec\\.?\\b", "$1 seconds"),
            ("(\\d)\\s*secs\\.?\\b", "$1 seconds"),
            // Day abbreviations require period
            ("\\bMon\\.\\b", "Monday"),
            ("\\bTue\\.\\b", "Tuesday"),
            ("\\bWed\\.\\b", "Wednesday"),
            ("\\bThu\\.\\b", "Thursday"),
            ("\\bFri\\.\\b", "Friday"),
            ("\\bSat\\.\\b", "Saturday"),
            ("\\bSun\\.\\b", "Sunday"),

            // Symbols and shorthand
            ("\\b&\\b", " and "),
            ("\\bw/\\b", "with"),
            ("\\bw/o\\b", "without"),
            ("\\bb/c\\b", "because"),
            ("\\bb/w\\b", "between"),
            ("\\bbtw\\b", "by the way"),
        ]

        for (pattern, replacement) in abbreviations {
            if let regex = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive]) {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: replacement)
            }
        }

        return result
    }

    private func simplifyNumbers(_ text: String) -> String {
        var result = text

        // Format percentages
        result = result.replacingOccurrences(of: "%", with: " percent")

        // Remove commas from numbers for cleaner reading (but keep the number readable)
        let numberPattern = "(\\d),(\\d{3})"
        if let regex = try? NSRegularExpression(pattern: numberPattern, options: []) {
            // Do this multiple times to handle numbers like 1,234,567
            for _ in 0..<3 {
                result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1$2")
            }
        }

        // Year ranges: 2020-2025 -> 2020 to 2025
        let yearRangePattern = "\\b((?:19|20)\\d{2})-((?:19|20)\\d{2})\\b"
        if let regex = try? NSRegularExpression(pattern: yearRangePattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1 to $2")
        }

        // Number ranges: 10-20 -> 10 to 20
        let numRangePattern = "\\b(\\d+)-(\\d+)\\b"
        if let regex = try? NSRegularExpression(pattern: numRangePattern, options: []) {
            result = regex.stringByReplacingMatches(in: result, range: NSRange(result.startIndex..., in: result), withTemplate: "$1 to $2")
        }

        return result
    }

    private func removeEmojis(_ text: String) -> String {
        text.unicodeScalars.filter { !$0.properties.isEmoji || $0.isASCII }.map { String($0) }.joined()
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
