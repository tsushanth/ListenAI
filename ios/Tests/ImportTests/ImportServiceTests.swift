import XCTest
@testable import ListenAI

final class ImportServiceTests: XCTestCase {

    // MARK: - Article Tests

    func testArticleCreation() {
        let article = Article(
            sourceType: .web,
            sourceURL: URL(string: "https://example.com/article"),
            title: "Test Article",
            author: "John Doe",
            rawText: "This is a test article with some content."
        )

        XCTAssertEqual(article.title, "Test Article")
        XCTAssertEqual(article.author, "John Doe")
        XCTAssertEqual(article.sourceType, .web)
        XCTAssertFalse(article.sections.isEmpty)
    }

    func testArticleWordCount() {
        let text = "One two three four five six seven eight nine ten"
        let article = Article(
            sourceType: .manual,
            title: "Test",
            rawText: text
        )

        XCTAssertEqual(article.wordCount, 10)
    }

    func testArticleEstimatedDuration() {
        let words = Array(repeating: "word", count: 150).joined(separator: " ")
        let article = Article(
            sourceType: .manual,
            title: "Test",
            rawText: words
        )

        // 150 words at 150 WPM = 1 minute = 60 seconds
        XCTAssertEqual(article.estimatedDuration, 60.0, accuracy: 1.0)
    }

    func testArticleDisplayTitle() {
        let articleWithTitle = Article(
            sourceType: .manual,
            title: "My Title",
            rawText: "Content"
        )
        XCTAssertEqual(articleWithTitle.displayTitle, "My Title")

        let articleWithoutTitle = Article(
            sourceType: .manual,
            title: "",
            rawText: "Content"
        )
        XCTAssertEqual(articleWithoutTitle.displayTitle, "Untitled Article")
    }

    func testArticleDisplayAuthor() {
        let articleWithAuthor = Article(
            sourceType: .web,
            title: "Test",
            author: "Jane Doe",
            rawText: "Content"
        )
        XCTAssertEqual(articleWithAuthor.displayAuthor, "Jane Doe")

        let articleWithSite = Article(
            sourceType: .web,
            title: "Test",
            siteName: "Example.com",
            rawText: "Content"
        )
        XCTAssertEqual(articleWithSite.displayAuthor, "Example.com")

        let articleWithNeither = Article(
            sourceType: .manual,
            title: "Test",
            rawText: "Content"
        )
        XCTAssertEqual(articleWithNeither.displayAuthor, "Unknown")
    }

    func testArticleSectionCreation() {
        let text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph."
        let article = Article(
            sourceType: .manual,
            title: "Test",
            rawText: text
        )

        XCTAssertEqual(article.sections.count, 3)
        XCTAssertEqual(article.sections[0].type, .title)
        XCTAssertEqual(article.sections[1].type, .paragraph)
    }

    // MARK: - SourceType Tests

    func testSourceTypeDisplayNames() {
        XCTAssertEqual(SourceType.web.displayName, "Web Article")
        XCTAssertEqual(SourceType.pdf.displayName, "PDF Document")
        XCTAssertEqual(SourceType.clipboard.displayName, "Clipboard")
    }

    func testSourceTypeIcons() {
        XCTAssertEqual(SourceType.web.iconName, "globe")
        XCTAssertEqual(SourceType.pdf.iconName, "doc.fill")
    }

    // MARK: - SynthesisStatus Tests

    func testSynthesisStatusDisplayText() {
        XCTAssertEqual(SynthesisStatus.notStarted.displayText, "Not synthesized")
        XCTAssertEqual(SynthesisStatus.completed.displayText, "Ready to play")
        XCTAssertTrue(SynthesisStatus.inProgress(progress: 0.5).displayText.contains("50%"))
    }

    func testSynthesisStatusFlags() {
        XCTAssertTrue(SynthesisStatus.completed.isComplete)
        XCTAssertFalse(SynthesisStatus.notStarted.isComplete)
        XCTAssertTrue(SynthesisStatus.inProgress(progress: 0.5).isInProgress)
    }

    // MARK: - ExtractionResult Tests

    func testExtractionResultToArticle() {
        let result = ExtractionResult(
            title: "Test Title",
            author: "Test Author",
            siteName: "Test Site",
            publishDate: Date(),
            rawText: "Test content",
            sections: [],
            language: "en",
            wordCount: 2,
            heroImageURL: nil,
            sourceURL: URL(string: "https://example.com"),
            metadata: .empty
        )

        let article = result.toArticle(sourceType: .web)

        XCTAssertEqual(article.title, "Test Title")
        XCTAssertEqual(article.author, "Test Author")
        XCTAssertEqual(article.sourceType, .web)
    }

    // MARK: - ExtractionError Tests

    func testExtractionErrorDescriptions() {
        XCTAssertTrue(ExtractionError.emptyContent.errorDescription?.contains("No content") ?? false)
        XCTAssertTrue(ExtractionError.pdfPasswordProtected.errorDescription?.contains("password") ?? false)
        XCTAssertTrue(ExtractionError.clipboardEmpty.errorDescription?.contains("empty") ?? false)
    }

    func testExtractionErrorRecoverySuggestions() {
        XCTAssertNotNil(ExtractionError.networkError(underlying: "test").recoverySuggestion)
        XCTAssertNotNil(ExtractionError.pdfPasswordProtected.recoverySuggestion)
        XCTAssertNil(ExtractionError.cancelled.recoverySuggestion)
    }

    func testExtractionErrorIsRetryable() {
        XCTAssertTrue(ExtractionError.networkError(underlying: "test").isRetryable)
        XCTAssertTrue(ExtractionError.timeout(seconds: 30).isRetryable)
        XCTAssertFalse(ExtractionError.pdfPasswordProtected.isRetryable)
        XCTAssertFalse(ExtractionError.emptyContent.isRetryable)
    }

    // MARK: - ImportProgress Tests

    func testImportProgressStages() {
        XCTAssertEqual(ImportProgress.Stage.fetching.displayName, "Fetching content...")
        XCTAssertEqual(ImportProgress.Stage.complete.displayName, "Complete")
    }

    func testImportProgressInitial() {
        let initial = ImportProgress.initial
        XCTAssertEqual(initial.progress, 0)
        XCTAssertEqual(initial.stage, .fetching)
    }

    // MARK: - ContentSource Tests

    func testContentSourceDisplayNames() {
        let urlSource = ContentSource.url(URL(string: "https://example.com")!)
        XCTAssertEqual(urlSource.displayName, "example.com")

        let clipboardSource = ContentSource.clipboard
        XCTAssertEqual(clipboardSource.displayName, "Clipboard")
    }

    func testContentSourceTypes() {
        XCTAssertEqual(ContentSource.url(URL(string: "https://test.com")!).sourceType, .web)
        XCTAssertEqual(ContentSource.pdfFile(URL(fileURLWithPath: "/test.pdf")).sourceType, .pdf)
        XCTAssertEqual(ContentSource.clipboard.sourceType, .clipboard)
        XCTAssertEqual(ContentSource.text("test").sourceType, .manual)
    }

    // MARK: - TextCleaningOptions Tests

    func testTextCleaningOptionsDefaults() {
        let defaults = TextCleaningOptions.default
        XCTAssertTrue(defaults.removeURLs)
        XCTAssertTrue(defaults.expandAbbreviations)
        XCTAssertFalse(defaults.removeEmojis)
    }

    func testTextCleaningOptionsAggressive() {
        let aggressive = TextCleaningOptions.aggressive
        XCTAssertTrue(aggressive.removeEmojis)
        XCTAssertTrue(aggressive.removeCodeBlocks)
    }

    // MARK: - ArticleSection Tests

    func testArticleSectionType() {
        XCTAssertTrue(ArticleSectionType.paragraph.shouldSpeak)
        XCTAssertFalse(ArticleSectionType.codeBlock.shouldSpeak)
    }

    func testArticleSectionTypePause() {
        XCTAssertGreaterThan(ArticleSectionType.title.pauseAfterSeconds, ArticleSectionType.paragraph.pauseAfterSeconds)
    }

    // MARK: - ExtractedSection Tests

    func testExtractedSectionToArticleSection() {
        let extracted = ExtractedSection(
            index: 0,
            type: .paragraph,
            text: "Test text",
            startOffset: 0,
            endOffset: 9,
            attributes: [:]
        )

        let articleSection = extracted.toArticleSection()
        XCTAssertEqual(articleSection.text, "Test text")
        XCTAssertEqual(articleSection.type, .paragraph)
    }

    // MARK: - ExtractionMetadata Tests

    func testExtractionMetadataCompressionRatio() {
        let metadata = ExtractionMetadata(
            extractorName: "Test",
            extractionDuration: 1.0,
            confidence: 0.9,
            warnings: [],
            originalContentSize: 1000,
            extractedContentSize: 500
        )

        XCTAssertEqual(metadata.compressionRatio, 0.5)
    }

    func testExtractionMetadataEmpty() {
        let empty = ExtractionMetadata.empty
        XCTAssertEqual(empty.extractorName, "unknown")
        XCTAssertEqual(empty.confidence, 0)
    }
}

// MARK: - Text Cleaning Tests

final class TextCleaningServiceTests: XCTestCase {

    func testNormalizeWhitespace() {
        let service = TextCleaningService()
        let input = "Hello   world\n\n\n\nTest"
        let output = service.clean(input)

        XCTAssertFalse(output.contains("   "))
        XCTAssertFalse(output.contains("\n\n\n"))
    }

    func testRemoveURLs() {
        let service = TextCleaningService(options: .default)
        let input = "Check out https://example.com for more info"
        let output = service.clean(input)

        XCTAssertFalse(output.contains("https://"))
    }

    func testExpandAbbreviations() {
        let service = TextCleaningService(options: .default)
        let input = "Dr. Smith said etc."
        let output = service.clean(input)

        XCTAssertTrue(output.contains("Doctor"))
        XCTAssertTrue(output.contains("et cetera"))
    }

    func testPreserveContentWithMinimalOptions() {
        let service = TextCleaningService(options: .minimal)
        let input = "Visit https://example.com and contact test@email.com"
        let output = service.clean(input)

        XCTAssertTrue(output.contains("https://"))
        XCTAssertTrue(output.contains("@"))
    }
}

// MARK: - URL Validation Tests

final class URLValidationTests: XCTestCase {

    func testValidURL() {
        let coordinator = ImportCoordinator.shared
        let result = coordinator.validateURL("https://example.com")

        XCTAssertTrue(result.isValid)
        XCTAssertNotNil(result.url)
    }

    func testURLWithoutScheme() {
        let coordinator = ImportCoordinator.shared
        let result = coordinator.validateURL("example.com")

        // Should auto-add https://
        XCTAssertTrue(result.isValid)
        XCTAssertEqual(result.url?.scheme, "https")
    }

    func testEmptyURL() {
        let coordinator = ImportCoordinator.shared
        let result = coordinator.validateURL("")

        if case .empty = result {
            // Expected
        } else {
            XCTFail("Expected .empty result")
        }
    }

    func testInvalidURL() {
        let coordinator = ImportCoordinator.shared
        let result = coordinator.validateURL("not a url at all !!!")

        XCTAssertFalse(result.isValid)
        XCTAssertNotNil(result.errorMessage)
    }
}

// MARK: - ClipboardContent Tests

final class ClipboardContentTests: XCTestCase {

    func testClipboardContentDisplayNames() {
        XCTAssertEqual(ClipboardContent.text("test").displayName, "Text")
        XCTAssertEqual(ClipboardContent.url(URL(string: "https://test.com")!).displayName, "Web Link")
        XCTAssertEqual(ClipboardContent.empty.displayName, "Empty")
    }

    func testClipboardContentCanImport() {
        XCTAssertTrue(ClipboardContent.text("test").canImport)
        XCTAssertTrue(ClipboardContent.url(URL(string: "https://test.com")!).canImport)
        XCTAssertFalse(ClipboardContent.image.canImport)
        XCTAssertFalse(ClipboardContent.empty.canImport)
    }

    func testClipboardContentPreview() {
        let text = ClipboardContent.text("Hello world")
        XCTAssertEqual(text.preview, "Hello world")

        let url = ClipboardContent.url(URL(string: "https://example.com")!)
        XCTAssertEqual(url.preview, "https://example.com")

        let empty = ClipboardContent.empty
        XCTAssertNil(empty.preview)
    }

    func testClipboardContentEquality() {
        let text1 = ClipboardContent.text("hello")
        let text2 = ClipboardContent.text("hello")
        let text3 = ClipboardContent.text("world")

        XCTAssertEqual(text1, text2)
        XCTAssertNotEqual(text1, text3)
        XCTAssertNotEqual(text1, ClipboardContent.empty)
    }
}
