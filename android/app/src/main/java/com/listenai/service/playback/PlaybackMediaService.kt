package com.listenai.service.playback

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.os.Build
import android.os.Bundle
import androidx.annotation.OptIn
import androidx.core.app.NotificationCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import androidx.media3.session.SessionCommand
import androidx.media3.session.SessionResult
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.listenai.MainActivity
import com.listenai.R

/**
 * Media session service for background audio playback.
 * Provides media controls via notification and lock screen.
 */
@OptIn(UnstableApi::class)
class PlaybackMediaService : MediaSessionService() {

    private var mediaSession: MediaSession? = null
    private var player: ExoPlayer? = null

    companion object {
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "listenai_playback"
        private const val CHANNEL_NAME = "Playback"

        // Custom commands
        const val ACTION_SKIP_FORWARD = "com.listenai.action.SKIP_FORWARD"
        const val ACTION_SKIP_BACKWARD = "com.listenai.action.SKIP_BACKWARD"
        const val ACTION_SET_SPEED = "com.listenai.action.SET_SPEED"
        const val EXTRA_SPEED = "speed"
    }

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        initializePlayer()
        initializeMediaSession()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Audio playback controls"
                setShowBadge(false)
            }

            val notificationManager = getSystemService(NotificationManager::class.java)
            notificationManager.createNotificationChannel(channel)
        }
    }

    private fun initializePlayer() {
        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_SPEECH)
            .build()

        player = ExoPlayer.Builder(this)
            .setAudioAttributes(audioAttributes, true)
            .setHandleAudioBecomingNoisy(true)
            .build()
            .apply {
                addListener(playerListener)
            }
    }

    private fun initializeMediaSession() {
        val sessionCallback = object : MediaSession.Callback {
            override fun onConnect(
                session: MediaSession,
                controller: MediaSession.ControllerInfo
            ): MediaSession.ConnectionResult {
                // Accept all connections
                val sessionCommands = MediaSession.ConnectionResult.DEFAULT_SESSION_COMMANDS.buildUpon()
                    .add(SessionCommand(ACTION_SKIP_FORWARD, Bundle.EMPTY))
                    .add(SessionCommand(ACTION_SKIP_BACKWARD, Bundle.EMPTY))
                    .add(SessionCommand(ACTION_SET_SPEED, Bundle.EMPTY))
                    .build()

                return MediaSession.ConnectionResult.AcceptedResultBuilder(session)
                    .setAvailableSessionCommands(sessionCommands)
                    .build()
            }

            override fun onCustomCommand(
                session: MediaSession,
                controller: MediaSession.ControllerInfo,
                customCommand: SessionCommand,
                args: Bundle
            ): ListenableFuture<SessionResult> {
                when (customCommand.customAction) {
                    ACTION_SKIP_FORWARD -> {
                        player?.let {
                            val newPosition = it.currentPosition + 10_000 // 10 seconds
                            it.seekTo(newPosition.coerceAtMost(it.duration))
                        }
                    }
                    ACTION_SKIP_BACKWARD -> {
                        player?.let {
                            val newPosition = it.currentPosition - 10_000 // 10 seconds
                            it.seekTo(newPosition.coerceAtLeast(0))
                        }
                    }
                    ACTION_SET_SPEED -> {
                        val speed = args.getFloat(EXTRA_SPEED, 1.0f)
                        player?.setPlaybackSpeed(speed)
                    }
                }
                return Futures.immediateFuture(SessionResult(SessionResult.RESULT_SUCCESS))
            }
        }

        mediaSession = MediaSession.Builder(this, player!!)
            .setCallback(sessionCallback)
            .build()
    }

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            when (playbackState) {
                Player.STATE_ENDED -> {
                    // Playback finished
                }
                Player.STATE_IDLE -> {
                    // Player is idle
                }
            }
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            // Update notification when play state changes
        }
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? {
        return mediaSession
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Stop playback when app is removed from recents
        player?.let {
            if (!it.playWhenReady || it.mediaItemCount == 0 || it.playbackState == Player.STATE_ENDED) {
                stopSelf()
            }
        }
    }

    override fun onDestroy() {
        mediaSession?.run {
            player?.release()
            release()
            mediaSession = null
        }
        super.onDestroy()
    }

    // MARK: - Public Methods for Playback Control

    fun playArticle(
        title: String,
        author: String?,
        audioUrl: String,
        artworkUrl: String? = null
    ) {
        val metadata = MediaMetadata.Builder()
            .setTitle(title)
            .setArtist(author ?: "ReadAloud AI")
            .setAlbumTitle("ReadAloud AI")
            .build()

        val mediaItem = MediaItem.Builder()
            .setUri(audioUrl)
            .setMediaMetadata(metadata)
            .build()

        player?.apply {
            setMediaItem(mediaItem)
            prepare()
            play()
        }
    }

    fun setPlaybackSpeed(speed: Float) {
        player?.setPlaybackSpeed(speed.coerceIn(0.5f, 3.0f))
    }

    fun skipForward(seconds: Int = 10) {
        player?.let {
            val newPosition = it.currentPosition + (seconds * 1000)
            it.seekTo(newPosition.coerceAtMost(it.duration))
        }
    }

    fun skipBackward(seconds: Int = 10) {
        player?.let {
            val newPosition = it.currentPosition - (seconds * 1000)
            it.seekTo(newPosition.coerceAtLeast(0))
        }
    }
}
