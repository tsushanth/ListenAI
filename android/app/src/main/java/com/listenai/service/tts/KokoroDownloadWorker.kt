package com.listenai.service.tts

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import com.listenai.R
import com.listenai.service.settings.SettingsManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import kotlin.math.max

/**
 * WorkManager job that downloads the Kokoro ONNX model bundle.
 *
 * Why a Worker (and not a CoroutineScope on the singleton): a singleton
 * scope dies as soon as the OS reclaims the app process — backgrounding
 * the app, screen-off, network change, low-memory. WorkManager owns its
 * own process lifecycle, runs as a foreground service while the
 * notification is showing, and survives all of those. It also enforces
 * the user's "WiFi-only" preference via [androidx.work.Constraints].
 *
 * Resumable: respects HTTP `Range` so a partial file finishes from where
 * it left off after a crash / kill / network drop.
 *
 * Idempotent: enqueued under a unique work name, so calling
 * `enqueueUniqueWork(KEEP)` from multiple places is safe.
 */
class KokoroDownloadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        Log.i(TAG, "doWork: starting (run attempt ${runAttemptCount})")

        val target = File(applicationContext.filesDir, MODEL_FILE_NAME)
        val partial = File(applicationContext.filesDir, "$MODEL_FILE_NAME.part")

        // If the model already exists, we're done.
        if (target.exists() && target.length() in MIN_VALID_SIZE..MAX_VALID_SIZE) {
            Log.i(TAG, "doWork: model already present at ${target.absolutePath}")
            return@withContext Result.success()
        }

        setForeground(createForegroundInfo(percent = 0, downloadedMb = 0, totalMb = ESTIMATED_TOTAL_MB))

        val existingBytes = if (partial.exists()) partial.length() else 0L
        Log.i(TAG, "doWork: starting from existingBytes=$existingBytes url=$MODEL_URL")

        try {
            val conn = (URL(MODEL_URL).openConnection() as HttpURLConnection).apply {
                connectTimeout = 30_000
                readTimeout = 60_000
                if (existingBytes > 0) {
                    setRequestProperty("Range", "bytes=$existingBytes-")
                }
            }

            val resp = conn.responseCode
            Log.i(TAG, "doWork: HTTP $resp")
            if (resp != HttpURLConnection.HTTP_OK && resp != HttpURLConnection.HTTP_PARTIAL) {
                // 4xx / 5xx from the URL itself — no point retrying with
                // exponential backoff. Bail.
                return@withContext Result.failure(
                    workDataOf(KEY_ERROR to "HTTP $resp")
                )
            }

            val totalBytes = run {
                val len = conn.contentLengthLong
                if (len > 0) len + existingBytes else EXPECTED_TOTAL_BYTES
            }
            val totalMb = (totalBytes / (1024 * 1024)).toInt().coerceAtLeast(1)

            val md = MessageDigest.getInstance("SHA-256")
            conn.inputStream.use { input ->
                FileOutputStream(partial, /* append = */ existingBytes > 0).use { out ->
                    val buf = ByteArray(64 * 1024)
                    var downloaded = existingBytes
                    var lastPercent = -1
                    while (true) {
                        // Allow user/system to cancel the work cleanly.
                        if (isStopped) {
                            Log.i(TAG, "doWork: stopped at ${downloaded} bytes — partial preserved for resume")
                            return@withContext Result.retry()
                        }
                        val n = input.read(buf)
                        if (n <= 0) break
                        out.write(buf, 0, n)
                        md.update(buf, 0, n)
                        downloaded += n
                        val pct = ((downloaded.toDouble() / totalBytes) * 100)
                            .toInt().coerceIn(0, 100)
                        if (pct != lastPercent) {
                            lastPercent = pct
                            val downloadedMb = (downloaded / (1024 * 1024)).toInt()
                            setProgress(
                                workDataOf(
                                    KEY_PERCENT to pct,
                                    KEY_DOWNLOADED_MB to downloadedMb,
                                    KEY_TOTAL_MB to totalMb,
                                )
                            )
                            // Throttle notification updates a little — every
                            // percent is fine, every byte would flood.
                            setForeground(createForegroundInfo(pct, downloadedMb, totalMb))
                        }
                    }
                }
            }

            // Verify checksum if we have one. Sentinel `<unknown>` skips
            // verification during development.
            if (EXPECTED_SHA256 != "<unknown>") {
                val digest = md.digest().joinToString("") { "%02x".format(it) }
                if (!digest.equals(EXPECTED_SHA256, ignoreCase = true)) {
                    Log.e(TAG, "doWork: checksum mismatch — deleting partial")
                    partial.delete()
                    return@withContext Result.failure(
                        workDataOf(KEY_ERROR to "Checksum mismatch")
                    )
                }
            }

            if (!partial.renameTo(target)) {
                return@withContext Result.failure(
                    workDataOf(KEY_ERROR to "Rename failed")
                )
            }

            Log.i(TAG, "doWork: ready (${target.length()} bytes at ${target.absolutePath})")
            Result.success()
        } catch (e: IOException) {
            Log.e(TAG, "doWork: I/O error — will retry with backoff", e)
            // Retry on I/O errors; WorkManager will reapply backoff +
            // network constraints automatically.
            Result.retry()
        } catch (e: Exception) {
            Log.e(TAG, "doWork: unexpected error", e)
            Result.failure(workDataOf(KEY_ERROR to (e.message ?: "Unknown error")))
        }
    }

    // ---- Foreground notification ----------------------------------------------

    private fun createForegroundInfo(percent: Int, downloadedMb: Int, totalMb: Int): ForegroundInfo {
        ensureNotificationChannel()

        val notification: Notification = NotificationCompat
            .Builder(applicationContext, CHANNEL_ID)
            .setContentTitle("Downloading on-device voice")
            .setContentText("$downloadedMb / $totalMb MB ($percent%)")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, percent, false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ requires an explicit foreground service type.
            ForegroundInfo(
                NOTIFICATION_ID,
                notification,
                ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            )
        } else {
            ForegroundInfo(NOTIFICATION_ID, notification)
        }
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val channel = NotificationChannel(
                    CHANNEL_ID,
                    "On-device voice download",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Progress for the on-device Kokoro voice download."
                    setShowBadge(false)
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    companion object {
        private const val TAG = "KokoroDownloadWorker"

        const val WORK_NAME = "kokoro_model_download"
        const val CHANNEL_ID = "kokoro_download"
        const val NOTIFICATION_ID = 4321

        // Progress data keys (exposed to UI via WorkInfo)
        const val KEY_PERCENT = "percent"
        const val KEY_DOWNLOADED_MB = "downloaded_mb"
        const val KEY_TOTAL_MB = "total_mb"
        const val KEY_ERROR = "error"

        // Mirror the values in KokoroModelDownloader so both can read the
        // same partial file path / sizes.
        const val MODEL_FILE_NAME = "kokoro_int8.onnx"
        const val MODEL_URL =
            "https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/onnx/model_q8f16.onnx"
        const val EXPECTED_SHA256 = "<unknown>"
        const val EXPECTED_TOTAL_BYTES = 82L * 1024 * 1024
        const val ESTIMATED_TOTAL_MB = 80
        const val MIN_VALID_SIZE = 60L * 1024 * 1024
        const val MAX_VALID_SIZE = 200L * 1024 * 1024
    }
}
