package com.listenai.service.tts

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import com.listenai.R

/**
 * Keeps the process foreground for the duration of a cloud TTS synthesis
 * network call.
 *
 * Root cause this exists for: on Android 12+, a backgrounded/cached process
 * can be frozen (the "App Freezer") or have its network access cut by Doze,
 * which severs any in-flight TCP connection outright ("Software caused
 * connection abort" / SocketTimeoutException). Self-hosted CPU-based Kokoro
 * synthesis takes 60-200+ seconds — long enough that a user backgrounding
 * the app (screen lock, notification shade, switching apps) mid-request was
 * reliably killing otherwise-successful synthesis. A foreground service with
 * an active notification exempts the process from freezing/network doze for
 * as long as synthesis is in flight.
 *
 * Started/stopped via [SynthesisForegroundGuard], not directly.
 */
class SynthesisForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureChannel()
        val notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle("Generating audio")
            .setContentText("This can take a couple of minutes for longer articles.")
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .build()

        ServiceCompat.startForeground(
            this,
            NOTIFICATION_ID,
            notification,
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            } else {
                0
            },
        )
        return START_NOT_STICKY
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Audio generation",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Shown while an article's audio is being generated"
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    companion object {
        private const val CHANNEL_ID = "listenai_synthesis_guard"
        private const val NOTIFICATION_ID = 3001
    }
}

/**
 * Reference-counted start/stop so concurrent synthesis calls (or a retry
 * that starts before a prior cancelled call unwinds) don't let one call's
 * `finally` stop the protection out from under another still-in-flight call.
 */
object SynthesisForegroundGuard {
    private var activeCount = 0
    private val lock = Any()

    fun acquire(context: Context) {
        synchronized(lock) {
            activeCount++
            if (activeCount == 1) {
                ContextCompat.startForegroundService(
                    context.applicationContext,
                    Intent(context.applicationContext, SynthesisForegroundService::class.java),
                )
            }
        }
    }

    fun release(context: Context) {
        synchronized(lock) {
            if (activeCount == 0) return
            activeCount--
            if (activeCount == 0) {
                context.applicationContext.stopService(
                    Intent(context.applicationContext, SynthesisForegroundService::class.java),
                )
            }
        }
    }
}
