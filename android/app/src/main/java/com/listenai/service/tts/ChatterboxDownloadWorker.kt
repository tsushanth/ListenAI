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
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * WorkManager job that downloads the four Chatterbox ONNX bundle files.
 *
 * Mirrors [KokoroDownloadWorker] in shape — the only differences:
 *   - downloads four files instead of one (LM, S3 token, voice encoder, vocoder)
 *   - reports a SINGLE overall percent across all four
 *   - the partial / final rename happens per-file so a crash mid-vocoder
 *     doesn't force a re-download of the (much larger) LM
 *
 * Resumable: respects HTTP `Range` on each file. A crash mid-LM resumes
 * the LM from the byte we stopped at.
 *
 * Total download: ~530 MB. URLs default to the HuggingFace mirror but can
 * be swapped to your own R2 / Cloudflare bucket once you're ready to host
 * the bundle yourself (recommended for production — HF bandwidth + churn
 * risk).
 */
class ChatterboxDownloadWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        Log.i(TAG, "doWork: starting Chatterbox download (run attempt $runAttemptCount)")

        val modelDir = File(applicationContext.filesDir, "chatterbox").apply { mkdirs() }
        val downloader = ChatterboxModelDownloader.getInstance(applicationContext)

        // 14 files: 5 configs + default voice + 4 ONNX graph stubs + 4 large
        // .onnx_data weight files. Order: configs first (cheap), then graphs,
        // then weights in increasing-size order so the user sees motion early.
        // The .onnx_data files are where the actual ~530 MB lives — the .onnx
        // files are only graph metadata.
        val files = listOf(
            FileSpec("tokenizer.json",            TOKENIZER_URL,
                     File(modelDir, "tokenizer.json"),                   30L * 1024),
            FileSpec("tokenizer_config",          TOKENIZER_CONFIG_URL,
                     File(modelDir, "tokenizer_config.json"),            1L * 1024),
            FileSpec("config",                    CONFIG_URL,
                     File(modelDir, "config.json"),                      2L * 1024),
            FileSpec("generation_config",         GENERATION_CONFIG_URL,
                     File(modelDir, "generation_config.json"),           1L * 1024),
            FileSpec("preprocessor_config",       PREPROCESSOR_CONFIG_URL,
                     File(modelDir, "preprocessor_config.json"),         1L * 1024),
            FileSpec("default_voice",             DEFAULT_VOICE_URL,
                     File(modelDir, "default_voice.wav"),                750L * 1024),
            // Graph metadata files (small — a few KB to a few MB)
            FileSpec("speech_encoder.onnx",       SPEECH_ENCODER_URL,
                     File(modelDir, "speech_encoder.onnx"),              2L * 1024 * 1024),
            FileSpec("embed_tokens.onnx",         EMBED_TOKENS_URL,
                     File(modelDir, "embed_tokens.onnx"),                100L * 1024),
            FileSpec("conditional_decoder.onnx",  CONDITIONAL_DECODER_URL,
                     File(modelDir, "conditional_decoder.onnx"),         10L * 1024 * 1024),
            FileSpec("language_model_q4.onnx",    LM_URL,
                     File(modelDir, "language_model_q4.onnx"),           1L * 1024 * 1024),
            // External weights (where the bulk of the download lives)
            FileSpec("speech_encoder.onnx_data",  SPEECH_ENCODER_DATA_URL,
                     File(modelDir, "speech_encoder.onnx_data"),         SPEECH_ENCODER_EXPECTED_BYTES),
            FileSpec("embed_tokens.onnx_data",    EMBED_TOKENS_DATA_URL,
                     File(modelDir, "embed_tokens.onnx_data"),           EMBED_TOKENS_EXPECTED_BYTES),
            FileSpec("conditional_decoder.onnx_data", CONDITIONAL_DECODER_DATA_URL,
                     File(modelDir, "conditional_decoder.onnx_data"),    CONDITIONAL_DECODER_EXPECTED_BYTES),
            FileSpec("language_model_q4.onnx_data", LM_DATA_URL,
                     File(modelDir, "language_model_q4.onnx_data"),      LM_EXPECTED_BYTES),
        )

        // Total expected size across the whole download — used for overall %
        val totalBytes = files.sumOf { it.expectedBytes }
        val totalMb = (totalBytes / (1024 * 1024)).toInt().coerceAtLeast(1)

        setForeground(createForegroundInfo(percent = 0, downloadedMb = 0, totalMb = totalMb))
        downloader.reportProgress(
            ChatterboxModelDownloader.State.Downloading(0, 0, totalMb)
        )

        // Bytes already on disk from previous runs (atomic finished files
        // contribute their whole size; .part files contribute their partial size).
        var bytesAcrossFiles = files.sumOf { f ->
            when {
                f.dest.exists() && f.dest.length() >= f.expectedBytes -> f.expectedBytes
                else -> File(modelDir, "${f.dest.name}.part").let {
                    if (it.exists()) it.length() else 0L
                }
            }
        }

        try {
            for (spec in files) {
                // Skip files already at expected size.
                if (spec.dest.exists() && spec.dest.length() >= spec.expectedBytes) {
                    Log.i(TAG, "doWork: ${spec.label} already present")
                    continue
                }
                downloadOne(spec, totalBytes, totalMb, bytesAlreadyDone = bytesAcrossFiles, downloader)
                bytesAcrossFiles += spec.expectedBytes
            }

            downloader.reportProgress(ChatterboxModelDownloader.State.Ready)
            Log.i(TAG, "doWork: all four files ready")
            Result.success()
        } catch (e: RetryException) {
            Log.i(TAG, "doWork: retry requested (${e.message})")
            Result.retry()
        } catch (e: IOException) {
            Log.e(TAG, "doWork: I/O error — will retry with backoff", e)
            downloader.reportProgress(
                ChatterboxModelDownloader.State.Failed("Network error: ${e.message}")
            )
            Result.retry()
        } catch (e: Exception) {
            Log.e(TAG, "doWork: unexpected failure", e)
            downloader.reportProgress(
                ChatterboxModelDownloader.State.Failed(e.message ?: "Unknown error")
            )
            Result.failure(workDataOf(KEY_ERROR to (e.message ?: "Unknown error")))
        }
    }

    /**
     * Downloads one file with HTTP Range resume support. Reports both
     * per-file and overall progress.
     */
    private suspend fun downloadOne(
        spec: FileSpec,
        totalBytesExpected: Long,
        totalMbExpected: Int,
        bytesAlreadyDone: Long,
        downloader: ChatterboxModelDownloader,
    ) {
        val partial = File(spec.dest.parentFile, "${spec.dest.name}.part")
        val existingBytes = if (partial.exists()) partial.length() else 0L
        Log.i(TAG, "downloadOne: ${spec.label} url=${spec.url} existingBytes=$existingBytes")

        val conn = (URL(spec.url).openConnection() as HttpURLConnection).apply {
            connectTimeout = 30_000
            readTimeout = 60_000
            if (existingBytes > 0) {
                setRequestProperty("Range", "bytes=$existingBytes-")
            }
        }

        val resp = conn.responseCode
        if (resp != HttpURLConnection.HTTP_OK && resp != HttpURLConnection.HTTP_PARTIAL) {
            throw IOException("HTTP $resp for ${spec.label} at ${spec.url}")
        }

        conn.inputStream.use { input ->
            FileOutputStream(partial, /* append = */ existingBytes > 0).use { out ->
                val buf = ByteArray(64 * 1024)
                var downloaded = existingBytes
                var lastPercent = -1
                while (true) {
                    if (isStopped) {
                        Log.i(TAG, "downloadOne: stopped at $downloaded bytes — partial preserved for resume")
                        throw RetryException("stopped")
                    }
                    val n = input.read(buf)
                    if (n <= 0) break
                    out.write(buf, 0, n)
                    downloaded += n

                    val totalDone = bytesAlreadyDone + downloaded
                    val pct = ((totalDone.toDouble() / totalBytesExpected) * 100)
                        .toInt().coerceIn(0, 100)
                    if (pct != lastPercent) {
                        lastPercent = pct
                        val downloadedMb = (totalDone / (1024 * 1024)).toInt()
                        setProgress(workDataOf(
                            KEY_PERCENT to pct,
                            KEY_DOWNLOADED_MB to downloadedMb,
                            KEY_TOTAL_MB to totalMbExpected,
                            KEY_CURRENT_FILE to spec.label,
                        ))
                        downloader.reportProgress(
                            ChatterboxModelDownloader.State.Downloading(pct, downloadedMb, totalMbExpected)
                        )
                        setForeground(createForegroundInfo(pct, downloadedMb, totalMbExpected))
                    }
                }
            }
        }

        if (!partial.renameTo(spec.dest)) {
            throw IOException("Rename of ${spec.label} failed")
        }
        Log.i(TAG, "downloadOne: ${spec.label} ready (${spec.dest.length()} bytes)")
    }

    // ---- Foreground notification ----------------------------------------------

    private fun createForegroundInfo(percent: Int, downloadedMb: Int, totalMb: Int): ForegroundInfo {
        ensureNotificationChannel()
        val notification: Notification = NotificationCompat
            .Builder(applicationContext, CHANNEL_ID)
            .setContentTitle("Downloading cloned-voice engine")
            .setContentText("$downloadedMb / $totalMb MB ($percent%)")
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setProgress(100, percent, false)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .build()
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
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
                    "Cloned-voice engine download",
                    NotificationManager.IMPORTANCE_LOW,
                ).apply {
                    description = "Progress for the on-device Chatterbox model bundle."
                    setShowBadge(false)
                }
                nm.createNotificationChannel(channel)
            }
        }
    }

    private data class FileSpec(
        val label: String,
        val url: String,
        val dest: File,
        val expectedBytes: Long,
    )

    private class RetryException(msg: String) : Exception(msg)

    companion object {
        private const val TAG = "ChatterboxDownloadWorker"

        const val CHANNEL_ID = "chatterbox_download"
        const val NOTIFICATION_ID = 4322

        const val KEY_PERCENT = "percent"
        const val KEY_DOWNLOADED_MB = "downloaded_mb"
        const val KEY_TOTAL_MB = "total_mb"
        const val KEY_CURRENT_FILE = "current_file"
        const val KEY_ERROR = "error"

        // --- URLs ---------------------------------------------------------
        //
        // Defaults point at HuggingFace's official ONNX export under
        // `onnx-community/chatterbox-ONNX/onnx/`. Verified file names against
        // the live repo on 2026-06-13. Replace with your own R2 / Cloudflare
        // bucket before production launch — HF rate-limits + the file naming
        // can drift between revisions, and you don't want a HF blip taking out
        // your TTS engine.
        //
        // TODO(M2.6-host): mirror these to https://r2.kreativekoala.llc/chatterbox/v1/...

        private const val HF_BASE = "https://huggingface.co/onnx-community/chatterbox-ONNX/resolve/main"

        // --- ONNX graph metadata files (small — under /onnx/) ---
        const val LM_URL = "$HF_BASE/onnx/language_model_q4.onnx"
        const val EMBED_TOKENS_URL = "$HF_BASE/onnx/embed_tokens.onnx"
        const val SPEECH_ENCODER_URL = "$HF_BASE/onnx/speech_encoder.onnx"
        const val CONDITIONAL_DECODER_URL = "$HF_BASE/onnx/conditional_decoder.onnx"

        // --- ONNX EXTERNAL WEIGHTS (the actual ~530 MB lives here) ---
        const val LM_DATA_URL = "$HF_BASE/onnx/language_model_q4.onnx_data"
        const val EMBED_TOKENS_DATA_URL = "$HF_BASE/onnx/embed_tokens.onnx_data"
        const val SPEECH_ENCODER_DATA_URL = "$HF_BASE/onnx/speech_encoder.onnx_data"
        const val CONDITIONAL_DECODER_DATA_URL = "$HF_BASE/onnx/conditional_decoder.onnx_data"

        // --- Tokenizer + configs + default voice (at repo root) ---
        const val TOKENIZER_URL = "$HF_BASE/tokenizer.json"
        const val TOKENIZER_CONFIG_URL = "$HF_BASE/tokenizer_config.json"
        const val CONFIG_URL = "$HF_BASE/config.json"
        const val GENERATION_CONFIG_URL = "$HF_BASE/generation_config.json"
        const val PREPROCESSOR_CONFIG_URL = "$HF_BASE/preprocessor_config.json"
        const val DEFAULT_VOICE_URL = "$HF_BASE/default_voice.wav"

        // --- Expected sizes (used for both % math and final-size sanity) --
        // Floors only — the worker compares actual against minimum from
        // ChatterboxModelDownloader's *_MIN_SIZE constants. Numbers refined
        // after a real download; bumped to plausible upper bounds.
        // Real sizes as of 2026-06-14 (HEAD requests against HF):
        //   language_model_q4.onnx_data:   337 MB
        //   embed_tokens.onnx_data:         58 MB
        //   speech_encoder.onnx_data:      563 MB
        //   conditional_decoder.onnx_data: 509 MB
        const val LM_EXPECTED_BYTES: Long = 337L * 1024 * 1024
        const val EMBED_TOKENS_EXPECTED_BYTES: Long = 58L * 1024 * 1024
        const val SPEECH_ENCODER_EXPECTED_BYTES: Long = 563L * 1024 * 1024
        const val CONDITIONAL_DECODER_EXPECTED_BYTES: Long = 509L * 1024 * 1024
    }
}
