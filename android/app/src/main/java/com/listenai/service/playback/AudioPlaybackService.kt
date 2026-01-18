package com.listenai.service.playback

import android.content.Context
import androidx.annotation.OptIn
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import com.listenai.data.models.Article
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.io.File

/**
 * Playback status enum for AudioPlaybackService
 */
enum class AudioPlaybackStatus {
    IDLE,
    LOADING,
    PLAYING,
    PAUSED,
    COMPLETED,
    ERROR
}

/**
 * Internal playback state data class for AudioPlaybackService
 */
data class AudioPlaybackState(
    val status: AudioPlaybackStatus = AudioPlaybackStatus.IDLE,
    val articleId: String? = null,
    val currentTime: Double = 0.0,
    val duration: Double = 0.0,
    val progress: Float = 0f,
    val speed: Float = 1.0f,
    val sleepTimerRemaining: Int? = null,
    val errorMessage: String? = null
)

/**
 * Audio playback service using ExoPlayer (Media3).
 * Handles audio playback, progress tracking, and playback controls.
 */
@OptIn(UnstableApi::class)
class AudioPlaybackService(private val context: Context) {

    // Playback state
    private val _playbackState = MutableStateFlow(AudioPlaybackState())
    val playbackState: StateFlow<AudioPlaybackState> = _playbackState.asStateFlow()

    // Current article
    private val _currentArticle = MutableStateFlow<Article?>(null)
    val currentArticle: StateFlow<Article?> = _currentArticle.asStateFlow()

    // Player instance
    private var player: ExoPlayer? = null

    // Coroutine scope for progress updates
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private var progressJob: kotlinx.coroutines.Job? = null

    // Playback speed
    private var currentSpeed: Float = 1.0f

    // Sleep timer
    private var sleepTimerJob: kotlinx.coroutines.Job? = null
    private var sleepTimerEndTime: Long? = null

    init {
        initializePlayer()
    }

    private fun initializePlayer() {
        player = ExoPlayer.Builder(context)
            .build()
            .apply {
                addListener(playerListener)
            }
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            updatePlaybackState(playbackState)
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            _playbackState.value = _playbackState.value.copy(
                status = if (isPlaying) AudioPlaybackStatus.PLAYING else AudioPlaybackStatus.PAUSED
            )

            if (isPlaying) {
                startProgressUpdates()
            } else {
                stopProgressUpdates()
            }
        }

        override fun onPlayerError(error: PlaybackException) {
            _playbackState.value = _playbackState.value.copy(
                status = AudioPlaybackStatus.ERROR,
                errorMessage = error.message
            )
        }
    }

    private fun updatePlaybackState(state: Int) {
        val status = when (state) {
            Player.STATE_IDLE -> AudioPlaybackStatus.IDLE
            Player.STATE_BUFFERING -> AudioPlaybackStatus.LOADING
            Player.STATE_READY -> if (player?.isPlaying == true) AudioPlaybackStatus.PLAYING else AudioPlaybackStatus.PAUSED
            Player.STATE_ENDED -> AudioPlaybackStatus.COMPLETED
            else -> AudioPlaybackStatus.IDLE
        }

        _playbackState.value = _playbackState.value.copy(status = status)

        if (state == Player.STATE_READY) {
            val duration = player?.duration ?: 0L
            _playbackState.value = _playbackState.value.copy(
                duration = duration / 1000.0
            )
        }
    }

    private fun startProgressUpdates() {
        progressJob?.cancel()
        progressJob = scope.launch {
            while (isActive && player?.isPlaying == true) {
                val position = player?.currentPosition ?: 0L
                val duration = player?.duration ?: 0L

                _playbackState.value = _playbackState.value.copy(
                    currentTime = position / 1000.0,
                    duration = duration / 1000.0,
                    progress = if (duration > 0) position.toFloat() / duration else 0f
                )

                delay(100) // Update every 100ms
            }
        }
    }

    private fun stopProgressUpdates() {
        progressJob?.cancel()
        progressJob = null
    }

    // MARK: - Playback Controls

    /**
     * Play an article's audio file
     */
    fun play(article: Article, audioFile: File) {
        _currentArticle.value = article
        _playbackState.value = _playbackState.value.copy(
            status = AudioPlaybackStatus.LOADING,
            articleId = article.id
        )

        val mediaItem = MediaItem.fromUri(audioFile.toURI().toString())
        player?.apply {
            setMediaItem(mediaItem)
            prepare()
            playWhenReady = true
            setPlaybackSpeed(currentSpeed)
        }
    }

    /**
     * Play from a URL
     */
    fun play(article: Article, audioUrl: String) {
        _currentArticle.value = article
        _playbackState.value = _playbackState.value.copy(
            status = AudioPlaybackStatus.LOADING,
            articleId = article.id
        )

        val mediaItem = MediaItem.fromUri(audioUrl)
        player?.apply {
            setMediaItem(mediaItem)
            prepare()
            playWhenReady = true
            setPlaybackSpeed(currentSpeed)
        }
    }

    /**
     * Resume playback
     */
    fun resume() {
        player?.play()
    }

    /**
     * Pause playback
     */
    fun pause() {
        player?.pause()
    }

    /**
     * Toggle play/pause
     */
    fun togglePlayPause() {
        if (player?.isPlaying == true) {
            pause()
        } else {
            resume()
        }
    }

    /**
     * Stop playback
     */
    fun stop() {
        player?.stop()
        player?.clearMediaItems()
        _currentArticle.value = null
        _playbackState.value = AudioPlaybackState()
        cancelSleepTimer()
    }

    /**
     * Seek to a specific position (in seconds)
     */
    fun seekTo(positionSeconds: Double) {
        player?.seekTo((positionSeconds * 1000).toLong())
    }

    /**
     * Seek forward by a number of seconds
     */
    fun seekForward(seconds: Double = 15.0) {
        val currentPosition = player?.currentPosition ?: 0L
        val newPosition = currentPosition + (seconds * 1000).toLong()
        player?.seekTo(newPosition.coerceAtMost(player?.duration ?: Long.MAX_VALUE))
    }

    /**
     * Seek backward by a number of seconds
     */
    fun seekBackward(seconds: Double = 15.0) {
        val currentPosition = player?.currentPosition ?: 0L
        val newPosition = currentPosition - (seconds * 1000).toLong()
        player?.seekTo(newPosition.coerceAtLeast(0))
    }

    // MARK: - Speed Control

    /**
     * Set playback speed (0.5x to 3.0x)
     */
    fun setSpeed(speed: Float) {
        currentSpeed = speed.coerceIn(0.5f, 3.0f)
        player?.setPlaybackSpeed(currentSpeed)
        _playbackState.value = _playbackState.value.copy(speed = currentSpeed)
    }

    /**
     * Increase speed by 0.25x
     */
    fun increaseSpeed() {
        setSpeed(currentSpeed + 0.25f)
    }

    /**
     * Decrease speed by 0.25x
     */
    fun decreaseSpeed() {
        setSpeed(currentSpeed - 0.25f)
    }

    /**
     * Get current playback speed
     */
    fun getSpeed(): Float = currentSpeed

    // MARK: - Sleep Timer

    /**
     * Set a sleep timer (in minutes)
     */
    fun setSleepTimer(minutes: Int) {
        cancelSleepTimer()

        if (minutes <= 0) return

        sleepTimerEndTime = System.currentTimeMillis() + (minutes * 60 * 1000)

        sleepTimerJob = scope.launch {
            delay(minutes * 60 * 1000L)
            pause()
            sleepTimerEndTime = null
            _playbackState.value = _playbackState.value.copy(
                sleepTimerRemaining = null
            )
        }

        // Update remaining time every second
        scope.launch {
            while (sleepTimerEndTime != null) {
                val remaining = ((sleepTimerEndTime ?: 0L) - System.currentTimeMillis()) / 1000
                if (remaining > 0) {
                    _playbackState.value = _playbackState.value.copy(
                        sleepTimerRemaining = remaining.toInt()
                    )
                }
                delay(1000)
            }
        }
    }

    /**
     * Cancel the sleep timer
     */
    fun cancelSleepTimer() {
        sleepTimerJob?.cancel()
        sleepTimerJob = null
        sleepTimerEndTime = null
        _playbackState.value = _playbackState.value.copy(
            sleepTimerRemaining = null
        )
    }

    /**
     * Get remaining sleep timer time in seconds
     */
    fun getSleepTimerRemaining(): Int? {
        val endTime = sleepTimerEndTime ?: return null
        val remaining = (endTime - System.currentTimeMillis()) / 1000
        return if (remaining > 0) remaining.toInt() else null
    }

    // MARK: - Section Navigation

    /**
     * Jump to a specific section by index
     */
    fun jumpToSection(sectionIndex: Int, timestamps: List<Double>) {
        if (sectionIndex in timestamps.indices) {
            seekTo(timestamps[sectionIndex])
        }
    }

    /**
     * Go to next section
     */
    fun nextSection(timestamps: List<Double>) {
        val currentTime = _playbackState.value.currentTime
        val nextIndex = timestamps.indexOfFirst { it > currentTime + 0.5 }
        if (nextIndex >= 0) {
            seekTo(timestamps[nextIndex])
        }
    }

    /**
     * Go to previous section
     */
    fun previousSection(timestamps: List<Double>) {
        val currentTime = _playbackState.value.currentTime
        val prevIndex = timestamps.indexOfLast { it < currentTime - 1.0 }
        if (prevIndex >= 0) {
            seekTo(timestamps[prevIndex])
        }
    }

    // MARK: - Lifecycle

    /**
     * Release player resources
     */
    fun release() {
        stopProgressUpdates()
        cancelSleepTimer()
        player?.release()
        player = null
    }

    /**
     * Check if currently playing
     */
    fun isPlaying(): Boolean = player?.isPlaying == true

    /**
     * Check if there's an article loaded
     */
    fun hasArticle(): Boolean = _currentArticle.value != null
}
