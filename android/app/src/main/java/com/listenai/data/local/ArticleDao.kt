package com.listenai.data.local

import androidx.room.*
import com.listenai.data.models.Article
import com.listenai.data.models.SourceType
import kotlinx.coroutines.flow.Flow

@Dao
interface ArticleDao {

    // Use explicit columns with empty rawText to avoid SQLiteBlobTooBigException
    // The full rawText is loaded only when viewing a specific article via getArticleById
    @Query("""
        SELECT id, title, author, siteName, publishDate, '' as rawText, wordCount, language,
        heroImageUrl, senderEmail, emailDate, sourceType, sourceUrl, sourceFileName,
        audioFileUrl, selectedVoiceId, playbackSpeed, synthesisStatus,
        listenedDuration, totalDuration, lastPosition, isCompleted,
        isFavorite, isArchived, tags, notes, createdAt, updatedAt
        FROM articles ORDER BY createdAt DESC
    """)
    fun getAllArticles(): Flow<List<Article>>

    @Query("SELECT * FROM articles WHERE id = :id")
    suspend fun getArticleById(id: String): Article?

    @Query("SELECT * FROM articles WHERE id = :id")
    fun getArticleByIdFlow(id: String): Flow<Article?>

    @Query("SELECT * FROM articles WHERE isFavorite = 1 ORDER BY createdAt DESC")
    fun getFavoriteArticles(): Flow<List<Article>>

    @Query("SELECT * FROM articles WHERE isArchived = 1 ORDER BY createdAt DESC")
    fun getArchivedArticles(): Flow<List<Article>>

    @Query("SELECT * FROM articles WHERE isCompleted = 0 AND listenedDuration > 0 ORDER BY updatedAt DESC")
    fun getInProgressArticles(): Flow<List<Article>>

    @Query("SELECT * FROM articles WHERE isCompleted = 1 ORDER BY updatedAt DESC")
    fun getCompletedArticles(): Flow<List<Article>>

    @Query("SELECT * FROM articles WHERE sourceType = :sourceType ORDER BY createdAt DESC")
    fun getArticlesBySourceType(sourceType: SourceType): Flow<List<Article>>

    @Query("SELECT * FROM articles WHERE title LIKE '%' || :query || '%' OR author LIKE '%' || :query || '%' ORDER BY createdAt DESC")
    fun searchArticles(query: String): Flow<List<Article>>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertArticle(article: Article)

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertArticles(articles: List<Article>)

    @Update
    suspend fun updateArticle(article: Article)

    @Delete
    suspend fun deleteArticle(article: Article)

    @Query("DELETE FROM articles WHERE id = :id")
    suspend fun deleteArticleById(id: String)

    @Query("UPDATE articles SET isFavorite = :isFavorite, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updateFavoriteStatus(id: String, isFavorite: Boolean, updatedAt: Long = System.currentTimeMillis())

    @Query("UPDATE articles SET isArchived = :isArchived, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updateArchivedStatus(id: String, isArchived: Boolean, updatedAt: Long = System.currentTimeMillis())

    @Query("UPDATE articles SET listenedDuration = :listenedDuration, lastPosition = :lastPosition, isCompleted = :isCompleted, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updatePlaybackProgress(
        id: String,
        listenedDuration: Long,
        lastPosition: Long,
        isCompleted: Boolean,
        updatedAt: Long = System.currentTimeMillis()
    )

    @Query("UPDATE articles SET synthesisStatus = :status, audioFileUrl = :audioUrl, totalDuration = :duration, selectedVoiceId = :voiceId, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updateSynthesisStatus(
        id: String,
        status: String,
        audioUrl: String?,
        duration: Long,
        voiceId: String? = null,
        updatedAt: Long = System.currentTimeMillis()
    )

    @Query("UPDATE articles SET synthesisStatus = :status, updatedAt = :updatedAt WHERE id = :id")
    suspend fun updatePendingJob(
        id: String,
        status: String,
        updatedAt: Long = System.currentTimeMillis()
    )

    @Query("SELECT COUNT(*) FROM articles")
    suspend fun getArticleCount(): Int

    @Query("SELECT COUNT(*) FROM articles WHERE isFavorite = 1")
    suspend fun getFavoriteCount(): Int
}
