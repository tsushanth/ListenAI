import Foundation
import SwiftUI

// MARK: - Article

/// Represents an imported article ready for TTS synthesis.
struct Article: Identifiable, Codable, Sendable, Hashable {

    // MARK: - Hashable Conformance

    func hash(into hasher: inout Hasher) {
        hasher.combine(id)
    }

    static func == (lhs: Article, rhs: Article) -> Bool {
        lhs.id == rhs.id
    }

    // MARK: - Identity

    let id: UUID
    let createdAt: Date
    var updatedAt: Date

    // MARK: - Source Metadata

    let sourceType: SourceType
    let sourceURL: URL?
    let sourceFileName: String?
    let importMethod: ImportMethod

    // MARK: - Content

    var title: String
    var author: String?
    var siteName: String?
    var publishDate: Date?
    var rawText: String
    var sections: [ArticleSection]
    var wordCount: Int
    var language: String
    var heroImageURL: URL?

    // MARK: - Audio State

    var audioFileURL: URL?
    var selectedVoiceID: UUID?
    var playbackSpeed: Float
    var synthesisStatus: SynthesisStatus

    /// Pending TTS job ID for background synthesis (voiceId -> jobId)
    /// Used to resume polling when returning to an article
    var pendingTTSJobId: String?
    var pendingTTSVoiceId: String?

    // MARK: - Playback Progress

    var listenedDuration: TimeInterval
    var totalDuration: TimeInterval?
    var lastPlayedAt: Date?
    var lastPosition: TimeInterval
    var isCompleted: Bool

    // MARK: - User Organization

    var isFavorite: Bool
    var isArchived: Bool
    var tags: [String]
    var notes: String?

    // MARK: - Computed Properties

    var estimatedDuration: TimeInterval {
        // Average speaking rate: 150 words per minute
        Double(wordCount) / 150.0 * 60.0
    }

    var progressPercentage: Double {
        guard let total = totalDuration, total > 0 else { return 0 }
        return listenedDuration / total
    }

    var remainingDuration: TimeInterval {
        guard let total = totalDuration else { return estimatedDuration }
        return max(0, total - listenedDuration)
    }

    var displayTitle: String {
        title.isEmpty ? "Untitled Article" : title
    }

    var displayAuthor: String {
        author ?? siteName ?? "Unknown"
    }

    var characterCount: Int {
        rawText.count
    }

    var importDate: Date {
        createdAt
    }

    // MARK: - Initialization

    init(
        id: UUID = UUID(),
        createdAt: Date = Date(),
        updatedAt: Date = Date(),
        sourceType: SourceType,
        sourceURL: URL? = nil,
        sourceFileName: String? = nil,
        importMethod: ImportMethod = .inApp,
        title: String,
        author: String? = nil,
        siteName: String? = nil,
        publishDate: Date? = nil,
        rawText: String,
        sections: [ArticleSection] = [],
        wordCount: Int? = nil,
        language: String = "en",
        heroImageURL: URL? = nil,
        audioFileURL: URL? = nil,
        selectedVoiceID: UUID? = nil,
        playbackSpeed: Float = 1.0,
        synthesisStatus: SynthesisStatus = .notStarted,
        pendingTTSJobId: String? = nil,
        pendingTTSVoiceId: String? = nil,
        listenedDuration: TimeInterval = 0,
        totalDuration: TimeInterval? = nil,
        lastPlayedAt: Date? = nil,
        lastPosition: TimeInterval = 0,
        isCompleted: Bool = false,
        isFavorite: Bool = false,
        isArchived: Bool = false,
        tags: [String] = [],
        notes: String? = nil
    ) {
        self.id = id
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.sourceType = sourceType
        self.sourceURL = sourceURL
        self.sourceFileName = sourceFileName
        self.importMethod = importMethod
        self.title = title
        self.author = author
        self.siteName = siteName
        self.publishDate = publishDate
        self.rawText = rawText
        self.sections = sections.isEmpty ? Self.createSections(from: rawText) : sections
        self.wordCount = wordCount ?? rawText.split(separator: " ").count
        self.language = language
        self.heroImageURL = heroImageURL
        self.audioFileURL = audioFileURL
        self.selectedVoiceID = selectedVoiceID
        self.playbackSpeed = playbackSpeed
        self.synthesisStatus = synthesisStatus
        self.pendingTTSJobId = pendingTTSJobId
        self.pendingTTSVoiceId = pendingTTSVoiceId
        self.listenedDuration = listenedDuration
        self.totalDuration = totalDuration
        self.lastPlayedAt = lastPlayedAt
        self.lastPosition = lastPosition
        self.isCompleted = isCompleted
        self.isFavorite = isFavorite
        self.isArchived = isArchived
        self.tags = tags
        self.notes = notes
    }

    // MARK: - Section Creation

    private static func createSections(from text: String) -> [ArticleSection] {
        let paragraphs = text.components(separatedBy: "\n\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        var sections: [ArticleSection] = []
        var currentOffset = 0

        for (index, paragraph) in paragraphs.enumerated() {
            let section = ArticleSection(
                id: UUID(),
                index: index,
                type: index == 0 ? .title : .paragraph,
                text: paragraph,
                startOffset: currentOffset,
                endOffset: currentOffset + paragraph.count
            )
            sections.append(section)
            currentOffset += paragraph.count + 2 // +2 for \n\n
        }

        return sections
    }
}

// MARK: - Article Section

struct ArticleSection: Identifiable, Codable, Sendable {
    let id: UUID
    let index: Int
    let type: ArticleSectionType
    let text: String
    let startOffset: Int
    let endOffset: Int

    // Audio timing (populated after synthesis)
    var audioStartTime: TimeInterval?
    var audioEndTime: TimeInterval?

    var characterCount: Int {
        text.count
    }

    var wordCount: Int {
        text.split(separator: " ").count
    }

    var audioDuration: TimeInterval? {
        guard let start = audioStartTime, let end = audioEndTime else { return nil }
        return end - start
    }
}

// MARK: - Article Section Type

enum ArticleSectionType: String, Codable, CaseIterable, Sendable {
    case title
    case heading
    case subheading
    case paragraph
    case blockquote
    case listItem
    case codeBlock
    case caption
    case footnote

    var shouldSpeak: Bool {
        switch self {
        case .codeBlock:
            return false
        default:
            return true
        }
    }

    var pauseAfterSeconds: TimeInterval {
        switch self {
        case .title: return 1.0
        case .heading: return 0.8
        case .subheading: return 0.6
        case .paragraph: return 0.5
        case .blockquote: return 0.6
        case .listItem: return 0.3
        case .codeBlock: return 0.5
        case .caption: return 0.4
        case .footnote: return 0.5
        }
    }
}

// MARK: - Source Type

enum SourceType: String, Codable, CaseIterable, Sendable {
    case web
    case pdf
    case clipboard
    case file
    case manual

    var displayName: String {
        switch self {
        case .web: return "Web Article"
        case .pdf: return "PDF Document"
        case .clipboard: return "Clipboard"
        case .file: return "File"
        case .manual: return "Manual Entry"
        }
    }

    var iconName: String {
        switch self {
        case .web: return "globe"
        case .pdf: return "doc.fill"
        case .clipboard: return "doc.on.clipboard"
        case .file: return "folder.fill"
        case .manual: return "square.and.pencil"
        }
    }

    var accentColor: Color {
        switch self {
        case .web: return .blue
        case .pdf: return .red
        case .clipboard: return .orange
        case .file: return .purple
        case .manual: return .green
        }
    }
}

// MARK: - Import Method

enum ImportMethod: String, Codable, CaseIterable, Sendable {
    case shareExtension
    case inApp
    case clipboard
    case dragAndDrop
    case files

    var displayName: String {
        switch self {
        case .shareExtension: return "Share Sheet"
        case .inApp: return "In-App"
        case .clipboard: return "Clipboard"
        case .dragAndDrop: return "Drag & Drop"
        case .files: return "Files App"
        }
    }
}

// MARK: - Synthesis Status

enum SynthesisStatus: Codable, Sendable, Equatable {
    case notStarted
    case queued(position: Int)
    case inProgress(progress: Float)
    case completed
    case failed(message: String)
    case cancelled

    var isComplete: Bool {
        if case .completed = self { return true }
        return false
    }

    var isInProgress: Bool {
        if case .inProgress = self { return true }
        return false
    }

    var isFailed: Bool {
        if case .failed = self { return true }
        return false
    }

    var displayText: String {
        switch self {
        case .notStarted:
            return "Not synthesized"
        case .queued(let position):
            return "Queued (#\(position))"
        case .inProgress(let progress):
            return "Generating... \(Int(progress * 100))%"
        case .completed:
            return "Ready to play"
        case .failed(let message):
            return "Failed: \(message)"
        case .cancelled:
            return "Cancelled"
        }
    }
}
