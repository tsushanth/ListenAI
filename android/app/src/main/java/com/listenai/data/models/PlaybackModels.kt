package com.listenai.data.models

import java.util.UUID

/**
 * Current playback state
 */
sealed class PlaybackState {
    object Idle : PlaybackState()
    data class Loading(val articleId: String) : PlaybackState()
    data class Playing(val articleId: String) : PlaybackState()
    data class Paused(val articleId: String) : PlaybackState()
    data class Buffering(val articleId: String) : PlaybackState()
    data class Error(val message: String) : PlaybackState()

    val isPlaying: Boolean
        get() = this is Playing

    val isPaused: Boolean
        get() = this is Paused

    val isLoading: Boolean
        get() = this is Loading || this is Buffering

    val currentArticleId: String?
        get() = when (this) {
            is Loading -> articleId
            is Playing -> articleId
            is Paused -> articleId
            is Buffering -> articleId
            else -> null
        }
}

/**
 * Playback progress information
 */
data class PlaybackProgress(
    val currentTime: Long = 0,
    val duration: Long = 0,
    val bufferedTime: Long = 0
) {
    val progress: Float
        get() = if (duration > 0) currentTime.toFloat() / duration else 0f

    val remainingTime: Long
        get() = maxOf(0, duration - currentTime)

    val percentComplete: Int
        get() = (progress * 100).toInt()

    val isNearEnd: Boolean
        get() = remainingTime < 30_000 // Less than 30 seconds

    val isComplete: Boolean
        get() = progress >= 0.95f

    companion object {
        val ZERO = PlaybackProgress()
    }
}

/**
 * Sleep timer options
 */
sealed class SleepTimerOption {
    object Off : SleepTimerOption()
    data class Minutes(val minutes: Int) : SleepTimerOption()
    object EndOfArticle : SleepTimerOption()
    object EndOfQueue : SleepTimerOption()

    val displayName: String
        get() = when (this) {
            is Off -> "Off"
            is Minutes -> "$minutes minutes"
            is EndOfArticle -> "End of article"
            is EndOfQueue -> "End of queue"
        }

    companion object {
        val presets = listOf(
            Off,
            Minutes(5),
            Minutes(10),
            Minutes(15),
            Minutes(30),
            Minutes(45),
            Minutes(60),
            EndOfArticle,
            EndOfQueue
        )
    }
}

/**
 * Playback speed options
 */
data class PlaybackSpeed(val rate: Float) {
    val displayName: String
        get() = when {
            rate == 1.0f -> "1x"
            rate == rate.toInt().toFloat() -> "${rate.toInt()}x"
            else -> "${rate}x"
        }

    companion object {
        val speeds = listOf(
            PlaybackSpeed(0.5f),
            PlaybackSpeed(0.75f),
            PlaybackSpeed(1.0f),
            PlaybackSpeed(1.25f),
            PlaybackSpeed(1.5f),
            PlaybackSpeed(1.75f),
            PlaybackSpeed(2.0f),
            PlaybackSpeed(2.5f),
            PlaybackSpeed(3.0f)
        )
        val normal = PlaybackSpeed(1.0f)
    }
}

/**
 * Repeat mode
 */
enum class RepeatMode {
    OFF,
    ALL,
    ONE
}

/**
 * Shuffle mode
 */
enum class ShuffleMode {
    OFF,
    ON
}

/**
 * Now playing item
 */
data class NowPlayingItem(
    val id: String = UUID.randomUUID().toString(),
    val articleId: String,
    val title: String,
    val author: String?,
    val siteName: String?,
    val audioUrl: String,
    val duration: Long,
    val artworkUrl: String?,
    val artworkColor: Long? = null
) {
    val displayAuthor: String
        get() = author ?: siteName ?: "Unknown"
}

/**
 * Queue item
 */
data class QueueItem(
    val id: String = UUID.randomUUID().toString(),
    val articleId: String,
    val title: String,
    val author: String?,
    val siteName: String?,
    val sourceType: SourceType,
    val duration: Long,
    val wordCount: Int,
    val addedAt: Long = System.currentTimeMillis(),
    val heroImageUrl: String?,
    val artworkColor: Long? = null,

    // Playback tracking
    val lastPosition: Long = 0,
    val isCompleted: Boolean = false,
    val completedAt: Long? = null
) {
    val displayAuthor: String
        get() = author ?: siteName ?: "Unknown"

    val remainingTime: Long
        get() = maxOf(0, duration - lastPosition)

    val remainingFormatted: String
        get() {
            val minutes = (remainingTime / 60000).toInt()
            return when {
                minutes < 1 -> "< 1 m left"
                else -> "$minutes m left"
            }
        }
}
