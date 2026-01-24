package com.listenai.ui.library

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.listenai.data.models.Article
import com.listenai.data.models.SourceType
import com.listenai.data.repository.ArticleRepository
import kotlinx.coroutines.flow.*
import kotlinx.coroutines.launch

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
        var result = articles

        // Apply filter
        result = when (filter) {
            LibraryFilter.ALL -> result.filter { !it.isArchived && it.sourceType != SourceType.EMAIL }
            LibraryFilter.IN_PROGRESS -> result.filter {
                !it.isCompleted && it.listenedDuration > 0 && !it.isArchived && it.sourceType != SourceType.EMAIL
            }
            LibraryFilter.FAVORITES -> result.filter { it.isFavorite && !it.isArchived }
            LibraryFilter.EMAIL -> result.filter { it.sourceType == SourceType.EMAIL && !it.isArchived }
            LibraryFilter.ARCHIVED -> result.filter { it.isArchived }
        }

        // Apply search
        if (query.isNotBlank()) {
            result = result.filter { article ->
                article.title?.contains(query, ignoreCase = true) == true ||
                article.author?.contains(query, ignoreCase = true) == true
            }
        }

        result
    }.stateIn(
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
}
