package com.listenai.service.notification

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.listenai.MainActivity
import com.listenai.R

/**
 * Service for showing TTS-related notifications.
 * Notifies users when TTS synthesis is complete for:
 * - Article audio generation
 * - Voice clone preview generation
 */
class TTSNotificationService private constructor(private val context: Context) {

    companion object {
        private const val CHANNEL_ID = "listenai_tts"
        private const val CHANNEL_NAME = "TTS Notifications"
        private const val CHANNEL_DESCRIPTION = "Notifications when audio generation is complete"

        // Notification IDs
        private const val NOTIFICATION_ID_ARTICLE_TTS = 2001
        private const val NOTIFICATION_ID_VOICE_CLONE_PREVIEW = 2002

        // Intent extras
        const val EXTRA_ARTICLE_ID = "article_id"
        const val EXTRA_NOTIFICATION_TYPE = "notification_type"
        const val TYPE_ARTICLE_TTS = "article_tts"
        const val TYPE_VOICE_CLONE_PREVIEW = "voice_clone_preview"

        @Volatile
        private var instance: TTSNotificationService? = null

        fun getInstance(context: Context): TTSNotificationService {
            return instance ?: synchronized(this) {
                instance ?: TTSNotificationService(context.applicationContext).also { instance = it }
            }
        }
    }

    private val notificationManager = NotificationManagerCompat.from(context)

    init {
        createNotificationChannel()
    }

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                CHANNEL_NAME,
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = CHANNEL_DESCRIPTION
                setShowBadge(true)
                enableVibration(true)
                vibrationPattern = longArrayOf(0, 250, 250, 250)
            }

            val manager = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            manager.createNotificationChannel(channel)
        }
    }

    /**
     * Check if we have notification permission
     */
    fun hasNotificationPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }
    }

    /**
     * Show notification when article TTS synthesis is complete
     */
    fun showArticleTTSComplete(
        articleId: String,
        articleTitle: String,
        durationFormatted: String
    ) {
        if (!hasNotificationPermission()) {
            android.util.Log.w("TTSNotification", "No notification permission, skipping notification")
            return
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_ARTICLE_ID, articleId)
            putExtra(EXTRA_NOTIFICATION_TYPE, TYPE_ARTICLE_TTS)
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            articleId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Audio Ready")
            .setContentText("\"$articleTitle\" is ready to play ($durationFormatted)")
            .setStyle(NotificationCompat.BigTextStyle()
                .bigText("\"$articleTitle\" is ready to play.\nDuration: $durationFormatted"))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()

        try {
            notificationManager.notify(NOTIFICATION_ID_ARTICLE_TTS + articleId.hashCode(), notification)
            android.util.Log.d("TTSNotification", "Showed article TTS complete notification for: $articleTitle")
        } catch (e: SecurityException) {
            android.util.Log.e("TTSNotification", "Failed to show notification: ${e.message}")
        }
    }

    /**
     * Show notification when article TTS synthesis fails — most useful when
     * it happens after the user has backgrounded the app (e.g. a cloud
     * queue timeout), since PlayerState.Error alone is silent unless
     * they're still looking at the player screen.
     */
    fun showArticleTTSFailed(
        articleId: String,
        articleTitle: String,
        reason: String
    ) {
        if (!hasNotificationPermission()) {
            android.util.Log.w("TTSNotification", "No notification permission, skipping notification")
            return
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_ARTICLE_ID, articleId)
            putExtra(EXTRA_NOTIFICATION_TYPE, TYPE_ARTICLE_TTS)
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            articleId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Audio generation failed")
            .setContentText("\"$articleTitle\" — $reason. Tap to retry.")
            .setStyle(NotificationCompat.BigTextStyle()
                .bigText("\"$articleTitle\" couldn't be generated: $reason\n\nTap to retry, or switch to offline AI voice from the player."))
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_ERROR)
            .build()

        try {
            notificationManager.notify(NOTIFICATION_ID_ARTICLE_TTS + articleId.hashCode(), notification)
            android.util.Log.d("TTSNotification", "Showed article TTS failed notification for: $articleTitle")
        } catch (e: SecurityException) {
            android.util.Log.e("TTSNotification", "Failed to show notification: ${e.message}")
        }
    }

    /**
     * Show notification when voice clone preview is ready
     */
    fun showVoiceClonePreviewReady(
        voiceId: String,
        voiceName: String
    ) {
        if (!hasNotificationPermission()) {
            android.util.Log.w("TTSNotification", "No notification permission, skipping notification")
            return
        }

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_NOTIFICATION_TYPE, TYPE_VOICE_CLONE_PREVIEW)
        }

        val pendingIntent = PendingIntent.getActivity(
            context,
            voiceId.hashCode(),
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Voice Preview Ready")
            .setContentText("Preview for \"$voiceName\" is ready to play")
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setContentIntent(pendingIntent)
            .setAutoCancel(true)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()

        try {
            notificationManager.notify(NOTIFICATION_ID_VOICE_CLONE_PREVIEW, notification)
            android.util.Log.d("TTSNotification", "Showed voice clone preview notification for: $voiceName")
        } catch (e: SecurityException) {
            android.util.Log.e("TTSNotification", "Failed to show notification: ${e.message}")
        }
    }

    /**
     * Cancel article TTS notification
     */
    fun cancelArticleTTSNotification(articleId: String) {
        notificationManager.cancel(NOTIFICATION_ID_ARTICLE_TTS + articleId.hashCode())
    }

    /**
     * Cancel voice clone preview notification
     */
    fun cancelVoiceClonePreviewNotification() {
        notificationManager.cancel(NOTIFICATION_ID_VOICE_CLONE_PREVIEW)
    }
}
