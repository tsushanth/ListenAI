import Foundation
import Combine

// MARK: - Article Store

/// Manages persistence and retrieval of articles in the user's library.
@MainActor
final class ArticleStore: ObservableObject {

    // MARK: - Published Properties

    @Published private(set) var articles: [Article] = []
    @Published private(set) var isLoading = false

    // MARK: - Singleton

    static let shared = ArticleStore()

    // MARK: - Private Properties

    private let fileManager = FileManager.default
    private let encoder = JSONEncoder()
    private let decoder = JSONDecoder()

    private var articlesURL: URL {
        let documentsDirectory = fileManager.urls(for: .documentDirectory, in: .userDomainMask)[0]
        return documentsDirectory.appendingPathComponent("articles.json")
    }

    // MARK: - Initialization

    private init() {
        loadArticles()
    }

    // MARK: - Public Methods

    /// Add a new article to the store
    func addArticle(_ article: Article) {
        // Check for duplicates
        guard !articles.contains(where: { $0.id == article.id }) else { return }

        articles.insert(article, at: 0)
        saveArticles()
    }

    /// Update an existing article
    func updateArticle(_ article: Article) {
        guard let index = articles.firstIndex(where: { $0.id == article.id }) else { return }
        articles[index] = article
        saveArticles()
    }

    /// Delete an article
    func deleteArticle(_ article: Article) {
        articles.removeAll { $0.id == article.id }

        // Clean up audio file if exists
        if let audioURL = article.audioFileURL {
            try? fileManager.removeItem(at: audioURL)
        }

        // Cancel any pending TTS job on the server
        if let pendingJobId = article.pendingTTSJobId {
            TTSJobManager.shared.cancelAndCleanup(articleId: article.id, jobId: pendingJobId)
        } else {
            // Still stop tracking in case job manager has it
            TTSJobManager.shared.cancelAndCleanup(articleId: article.id)
        }

        // Clear all persisted TTS data for this article (audio cache, UserDefaults entries for all voices)
        TTSJobManager.shared.clearAllPersistedData(for: article.id)

        saveArticles()
    }

    /// Delete article by ID
    func deleteArticle(id: UUID) {
        guard let article = articles.first(where: { $0.id == id }) else { return }
        deleteArticle(article)
    }

    /// Get article by ID
    func article(withID id: UUID) -> Article? {
        articles.first { $0.id == id }
    }

    /// Toggle favorite status
    func toggleFavorite(_ article: Article) {
        guard let index = articles.firstIndex(where: { $0.id == article.id }) else { return }
        articles[index].isFavorite.toggle()
        saveArticles()
    }

    /// Update article title
    func updateTitle(_ article: Article, newTitle: String) {
        guard let index = articles.firstIndex(where: { $0.id == article.id }) else { return }
        articles[index].title = newTitle
        saveArticles()
    }

    /// Update listening progress
    func updateProgress(for articleID: UUID, listenedDuration: TimeInterval, isCompleted: Bool = false) {
        guard let index = articles.firstIndex(where: { $0.id == articleID }) else { return }
        articles[index].listenedDuration = listenedDuration
        articles[index].isCompleted = isCompleted
        articles[index].lastPlayedAt = Date()
        saveArticles()
    }

    /// Mark article as having audio synthesized
    func updateSynthesisStatus(for articleID: UUID, status: SynthesisStatus, audioURL: URL? = nil) {
        guard let index = articles.firstIndex(where: { $0.id == articleID }) else { return }
        articles[index].synthesisStatus = status
        if let audioURL = audioURL {
            articles[index].audioFileURL = audioURL
        }
        // Clear pending job when synthesis completes or fails
        if status.isComplete || status.isFailed {
            articles[index].pendingTTSJobId = nil
            articles[index].pendingTTSVoiceId = nil
        }
        saveArticles()
    }

    /// Update pending TTS job for background synthesis tracking
    func updatePendingTTSJob(for articleID: UUID, jobId: String?, voiceId: String?) {
        guard let index = articles.firstIndex(where: { $0.id == articleID }) else { return }
        articles[index].pendingTTSJobId = jobId
        articles[index].pendingTTSVoiceId = voiceId
        saveArticles()
    }

    /// Get recent articles (for continue listening)
    func recentlyPlayed(limit: Int = 5) -> [Article] {
        articles
            .filter { $0.lastPlayedAt != nil && !$0.isCompleted }
            .sorted { ($0.lastPlayedAt ?? .distantPast) > ($1.lastPlayedAt ?? .distantPast) }
            .prefix(limit)
            .map { $0 }
    }

    /// Get favorites
    func favorites() -> [Article] {
        articles.filter { $0.isFavorite }
    }

    /// Get completed articles
    func completed() -> [Article] {
        articles.filter { $0.isCompleted }
    }

    /// Mark article as finished
    func markAsFinished(_ article: Article) {
        guard let index = articles.firstIndex(where: { $0.id == article.id }) else { return }
        articles[index].isCompleted = true
        articles[index].lastPlayedAt = Date()
        saveArticles()
    }

    /// Convenience delete method
    func delete(_ article: Article) {
        deleteArticle(article)
    }

    /// Get in-progress articles
    func inProgress() -> [Article] {
        articles.filter { $0.listenedDuration > 0 && !$0.isCompleted }
    }

    // MARK: - Persistence

    private func loadArticles() {
        isLoading = true
        defer { isLoading = false }

        guard fileManager.fileExists(atPath: articlesURL.path) else {
            articles = []
            return
        }

        do {
            let data = try Data(contentsOf: articlesURL)
            articles = try decoder.decode([Article].self, from: data)
        } catch {
            print("Failed to load articles: \(error)")
            articles = []
        }
    }

    private func saveArticles() {
        do {
            let data = try encoder.encode(articles)
            try data.write(to: articlesURL, options: .atomic)
        } catch {
            print("Failed to save articles: \(error)")
        }
    }

    /// Force reload from disk
    func reload() {
        loadArticles()
    }
}
