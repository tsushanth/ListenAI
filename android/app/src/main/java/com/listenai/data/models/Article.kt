package com.listenai.data.models

import androidx.room.Entity
import androidx.room.PrimaryKey
import androidx.room.TypeConverters
import com.listenai.data.local.Converters
import java.util.Date
import java.util.UUID

/**
 * Article content source type
 */
enum class SourceType {
    WEB,
    PDF,
    CLIPBOARD,
    FILE,
    MANUAL,
    EMAIL;

    val displayName: String
        get() = when (this) {
            WEB -> "Web Link"
            PDF -> "File"
            CLIPBOARD -> "Clipboard"
            FILE -> "File"
            MANUAL -> "Text"
            EMAIL -> "Email"
        }

    val iconName: String
        get() = when (this) {
            WEB -> "link"
            PDF -> "description"
            CLIPBOARD -> "content_paste"
            FILE -> "folder"
            MANUAL -> "edit_note"
            EMAIL -> "email"
        }
}

/**
 * Synthesis status for an article
 */
sealed class SynthesisStatus {
    object NotStarted : SynthesisStatus()
    data class InProgress(val progress: Float) : SynthesisStatus()
    object Completed : SynthesisStatus()
    data class Failed(val error: String) : SynthesisStatus()

    val isComplete: Boolean
        get() = this is Completed
}

/**
 * Main Article data model
 */
@Entity(tableName = "articles")
@TypeConverters(Converters::class)
data class Article(
    @PrimaryKey
    val id: String = UUID.randomUUID().toString(),

    // Content metadata
    val title: String?,
    val author: String?,
    val siteName: String?,
    val publishDate: Date?,
    val rawText: String,
    val wordCount: Int,
    val language: String?,
    val heroImageUrl: String?,

    // Email-specific metadata (only populated for SourceType.EMAIL)
    val senderEmail: String? = null,  // e.g., "john@example.com"
    val emailDate: Date? = null,      // When the email was sent/received

    // Source tracking
    val sourceType: SourceType,
    val sourceUrl: String?,
    val sourceFileName: String?,

    // Audio state
    val audioFileUrl: String?,
    val selectedVoiceId: String?,
    val playbackSpeed: Float = 1.0f,
    val synthesisStatus: String = "not_started", // Stored as string for Room

    // Playback progress
    val listenedDuration: Long = 0,
    val totalDuration: Long = 0,
    val lastPosition: Long = 0,
    val isCompleted: Boolean = false,

    // User organization
    val isFavorite: Boolean = false,
    val isArchived: Boolean = false,
    val tags: List<String> = emptyList(),
    val notes: String? = null,

    // Timestamps
    val createdAt: Date = Date(),
    val updatedAt: Date = Date()
) {
    val displayTitle: String
        get() = title ?: "Untitled"

    val displayAuthor: String
        get() = author ?: siteName ?: "Unknown"

    val estimatedDuration: Long
        get() = if (totalDuration > 0) totalDuration else (wordCount / 150 * 60 * 1000L)

    val estimatedDurationFormatted: String
        get() {
            val minutes = (estimatedDuration / 60000).toInt()
            return when {
                minutes < 1 -> "< 1 min"
                minutes == 1 -> "1 min"
                else -> "$minutes min"
            }
        }

    val progress: Float
        get() = if (totalDuration > 0) listenedDuration.toFloat() / totalDuration else 0f
}
