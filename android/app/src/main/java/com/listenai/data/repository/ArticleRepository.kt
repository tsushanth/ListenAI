package com.listenai.data.repository

import com.listenai.data.local.ArticleDao
import com.listenai.data.models.Article
import com.listenai.data.models.SourceType
import kotlinx.coroutines.flow.Flow

class ArticleRepository(
    private val articleDao: ArticleDao
) {
    val allArticles: Flow<List<Article>> = articleDao.getAllArticles()
    val favoriteArticles: Flow<List<Article>> = articleDao.getFavoriteArticles()
    val inProgressArticles: Flow<List<Article>> = articleDao.getInProgressArticles()
    val completedArticles: Flow<List<Article>> = articleDao.getCompletedArticles()

    suspend fun getArticleById(id: String): Article? {
        return articleDao.getArticleById(id)
    }

    fun getArticleByIdFlow(id: String): Flow<Article?> {
        return articleDao.getArticleByIdFlow(id)
    }

    fun getArticlesBySourceType(sourceType: SourceType): Flow<List<Article>> {
        return articleDao.getArticlesBySourceType(sourceType)
    }

    fun searchArticles(query: String): Flow<List<Article>> {
        return articleDao.searchArticles(query)
    }

    suspend fun saveArticle(article: Article) {
        articleDao.insertArticle(article)
    }

    suspend fun updateArticle(article: Article) {
        articleDao.updateArticle(article)
    }

    suspend fun deleteArticle(article: Article) {
        articleDao.deleteArticle(article)
    }

    suspend fun deleteArticleById(id: String) {
        articleDao.deleteArticleById(id)
    }

    suspend fun toggleFavorite(article: Article) {
        articleDao.updateFavoriteStatus(article.id, !article.isFavorite)
    }

    suspend fun setFavorite(id: String, isFavorite: Boolean) {
        articleDao.updateFavoriteStatus(id, isFavorite)
    }

    suspend fun setArchived(id: String, isArchived: Boolean) {
        articleDao.updateArchivedStatus(id, isArchived)
    }

    suspend fun updatePlaybackProgress(
        id: String,
        listenedDuration: Long,
        lastPosition: Long,
        isCompleted: Boolean
    ) {
        articleDao.updatePlaybackProgress(id, listenedDuration, lastPosition, isCompleted)
    }

    suspend fun updateSynthesisStatus(
        id: String,
        status: String,
        audioUrl: String?,
        duration: Long,
        voiceId: String? = null
    ) {
        articleDao.updateSynthesisStatus(id, status, audioUrl, duration, voiceId)
    }

    suspend fun getArticleCount(): Int {
        return articleDao.getArticleCount()
    }

    suspend fun getFavoriteCount(): Int {
        return articleDao.getFavoriteCount()
    }
}
