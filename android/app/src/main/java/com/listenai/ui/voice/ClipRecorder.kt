package com.listenai.ui.voice

import android.content.Context
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import com.listenai.service.voice.AudioClip
import com.listenai.service.voice.AudioClips
import java.io.File

/**
 * Thin MediaRecorder wrapper (AAC in MP4/M4A, mono). Needs only the RECORD_AUDIO runtime
 * permission: recordings go to the app's own cache dir, no storage permission involved.
 */
class ClipRecorder(private val context: Context) {

    private var recorder: MediaRecorder? = null
    private var file: File? = null

    val isRecording: Boolean get() = recorder != null

    /** @return null on success, otherwise a user-facing error message. */
    fun start(prefix: String): String? {
        stopQuietly()
        return try {
            val f = File(context.cacheDir, "${prefix}_${System.currentTimeMillis()}.m4a")
            file = f
            recorder = (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) MediaRecorder(context) else @Suppress("DEPRECATION") MediaRecorder()).apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioChannels(1)
                setAudioEncodingBitRate(128_000)
                setAudioSamplingRate(44_100)
                setOutputFile(f.absolutePath)
                prepare()
                start()
            }
            null
        } catch (e: Exception) {
            stopQuietly()
            "Couldn't start recording. Another app may be using the microphone."
        }
    }

    fun pause() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) runCatching { recorder?.pause() }
    }

    fun resume() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) runCatching { recorder?.resume() }
    }

    /** Stops and returns the clip, or null if nothing usable was captured. */
    fun stop(): AudioClip? {
        val r = recorder ?: return null
        val f = file
        recorder = null
        try {
            r.stop()
        } catch (e: RuntimeException) {
            // stop() throws if nothing was captured (very short recording).
            runCatching { r.release() }
            f?.delete()
            return null
        }
        runCatching { r.release() }
        if (f == null || !f.exists() || f.length() == 0L) return null
        val seconds = AudioClips.durationSeconds(context, Uri.fromFile(f)) ?: 0
        return AudioClips.fromFile(f, seconds)
    }

    fun release() = stopQuietly()

    private fun stopQuietly() {
        recorder?.let { r ->
            runCatching { r.stop() }
            runCatching { r.release() }
        }
        recorder = null
    }
}
