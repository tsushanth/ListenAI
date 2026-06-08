package com.listenai.ui.library

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.listenai.data.models.Article
import com.listenai.data.models.SourceType
import com.listenai.data.repository.ArticleRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

/**
 * Entry types for the library list. EPUB chapters that share a sourceFileName
 * are folded into a single [BookGroup] so each imported book renders as one row
 * (expandable to its chapters) instead of N separate chapter rows.
 */
sealed class LibraryListEntry {
    abstract val key: String

    data class SingleArticle(val article: Article) : LibraryListEntry() {
        override val key: String = "article:${article.id}"
    }

    data class BookGroup(
        val sourceFileName: String,
        val bookTitle: String,
        val author: String?,
        val chapters: List<Article>,
        val totalDuration: Long,
        val completedCount: Int,
        val mostRecent: Long
    ) : LibraryListEntry() {
        override val key: String = "book:$sourceFileName"
        val chapterCount: Int get() = chapters.size
    }
}

/**
 * ViewModel for the Library screen
 */
class LibraryViewModel(
    private val articleRepository: ArticleRepository
) : ViewModel() {

    // Selected filter state
    private val _selectedFilter = MutableStateFlow(LibraryFilter.ALL)
    val selectedFilter: StateFlow<LibraryFilter> = _selectedFilter.asStateFlow()

    // Search query state
    private val _searchQuery = MutableStateFlow("")
    val searchQuery: StateFlow<String> = _searchQuery.asStateFlow()

    // All articles from repository
    private val allArticles: Flow<List<Article>> = articleRepository.allArticles

    // Filtered articles based on selected filter and search query
    val articles: StateFlow<List<Article>> = combine(
        allArticles,
        _selectedFilter,
        _searchQuery
    ) { articles, filter, query ->
        applyFilterAndSearch(articles, filter, query)
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.WhileSubscribed(5000),
        initialValue = emptyList()
    )

    /**
     * Library entries with EPUB chapters folded into book groups. Non-EPUB
     * articles (and EPUB articles missing a sourceFileName) remain individual
     * rows.
     */
    val entries: StateFlow<List<LibraryListEntry>> = articles
        .map { groupIntoEntries(it) }
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5000),
            initialValue = emptyList()
        )

    // Article count for badge (excludes emails from count too)
    val articleCount: StateFlow<Int> = allArticles
        .map { it.filter { article -> !article.isArchived && article.sourceType != SourceType.EMAIL }.size }
        .stateIn(
            scope = viewModelScope,
            started = SharingStarted.WhileSubscribed(5000),
            initialValue = 0
        )

    private fun applyFilterAndSearch(
        articles: List<Article>,
        filter: LibraryFilter,
        query: String
    ): List<Article> {
        var result = when (filter) {
            LibraryFilter.ALL -> articles.filter { !it.isArchived && it.sourceType != SourceType.EMAIL }
            LibraryFilter.IN_PROGRESS -> articles.filter {
                !it.isCompleted && it.listenedDuration > 0 && !it.isArchived && it.sourceType != SourceType.EMAIL
            }
            LibraryFilter.FAVORITES -> articles.filter { it.isFavorite && !it.isArchived }
            LibraryFilter.EMAIL -> articles.filter { it.sourceType == SourceType.EMAIL && !it.isArchived }
            LibraryFilter.ARCHIVED -> articles.filter { it.isArchived }
        }

        if (query.isNotBlank()) {
            result = result.filter { article ->
                article.title?.contains(query, ignoreCase = true) == true ||
                article.author?.contains(query, ignoreCase = true) == true
            }
        }

        return result
    }

    private fun groupIntoEntries(filtered: List<Article>): List<LibraryListEntry> {
        if (filtered.isEmpty()) return emptyList()

        val (epubGroupable, others) = filtered.partition {
            it.sourceType == SourceType.EPUB && !it.sourceFileName.isNullOrBlank()
        }

        val bookGroups: List<LibraryListEntry.BookGroup> = epubGroupable
            .groupBy { it.sourceFileName!! }
            .map { (fileName, chapters) ->
                // Preserve chapter sequence by createdAt ASC (chapters were
                // saved in reading order). Repository returns newest-first
                // so we re-sort here.
                val ordered = chapters.sortedBy { it.createdAt }
                val bookTitle = deriveBookTitle(ordered, fileName)
                val author = ordered.firstOrNull { !it.author.isNullOrBlank() }?.author
                LibraryListEntry.BookGroup(
                    sourceFileName = fileName,
                    bookTitle = bookTitle,
                    author = author,
                    chapters = ordered,
                    totalDuration = ordered.sumOf { it.totalDuration },
                    completedCount = ordered.count { it.isCompleted },
                    mostRecent = ordered.maxOf { it.createdAt.time }
                )
            }

        val singleEntries: List<LibraryListEntry.SingleArticle> = others.map {
            LibraryListEntry.SingleArticle(it)
        }

        // Merge and sort by most-recent timestamp (newest first), matching the
        // existing DAO ordering.
        return (bookGroups + singleEntries).sortedByDescending { entry ->
            when (entry) {
                is LibraryListEntry.BookGroup -> entry.mostRecent
                is LibraryListEntry.SingleArticle -> entry.article.createdAt.time
            }
        }
    }

    /**
     * Derive book title by stripping the " — chapter" suffix. ImportViewModel
     * formats titles as "$bookTitle — $partTitle"; we take the prefix before
     * the first em-dash separator. Falls back to longest common prefix across
     * chapters, then to the file name.
     */
    private fun deriveBookTitle(chapters: List<Article>, fileName: String): String {
        val firstTitle = chapters.firstOrNull()?.title?.takeIf { it.isNotBlank() }
        if (firstTitle != null) {
            val idx = firstTitle.indexOf(" — ")
            if (idx > 0) return firstTitle.substring(0, idx).trim()
        }

        val titles = chapters.mapNotNull { it.title?.takeIf { t -> t.isNotBlank() } }
        if (titles.size > 1) {
            val prefix = titles.reduce { acc, s -> commonPrefix(acc, s) }.trim().trimEnd('—', '-', ':').trim()
            if (prefix.length >= 3) return prefix
        }

        return fileName.removeSuffix(".epub").removeSuffix(".EPUB")
    }

    private fun commonPrefix(a: String, b: String): String {
        val len = minOf(a.length, b.length)
        var i = 0
        while (i < len && a[i] == b[i]) i++
        return a.substring(0, i)
    }

    /**
     * Set the selected filter
     */
    fun setFilter(filter: LibraryFilter) {
        _selectedFilter.value = filter
    }

    /**
     * Set the search query
     */
    fun setSearchQuery(query: String) {
        _searchQuery.value = query
    }

    /**
     * Toggle favorite status for an article
     */
    fun toggleFavorite(article: Article) {
        viewModelScope.launch {
            articleRepository.toggleFavorite(article)
        }
    }

    /**
     * Toggle archive status for an article
     */
    fun toggleArchive(article: Article) {
        viewModelScope.launch {
            articleRepository.setArchived(article.id, !article.isArchived)
        }
    }

    /**
     * Delete an article
     */
    fun deleteArticle(article: Article) {
        viewModelScope.launch {
            articleRepository.deleteArticle(article)
        }
    }

    /**
     * Archive an article
     */
    fun archiveArticle(article: Article) {
        viewModelScope.launch {
            articleRepository.setArchived(article.id, true)
        }
    }

    /**
     * Unarchive an article
     */
    fun unarchiveArticle(article: Article) {
        viewModelScope.launch {
            articleRepository.setArchived(article.id, false)
        }
    }

    /**
     * Delete every chapter belonging to a book group.
     */
    fun deleteBookGroup(group: LibraryListEntry.BookGroup) {
        viewModelScope.launch {
            group.chapters.forEach { articleRepository.deleteArticle(it) }
        }
    }

    /**
     * Archive (or unarchive) every chapter of a book group together.
     */
    fun setBookGroupArchived(group: LibraryListEntry.BookGroup, archived: Boolean) {
        viewModelScope.launch {
            group.chapters.forEach { articleRepository.setArchived(it.id, archived) }
        }
    }
}
