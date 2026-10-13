package com.listenai.systemtts

import android.content.Context
import android.util.Log
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.security.MessageDigest

/**
 * Lazy per-voice TalkBack cache, built up incrementally from real
 * Kokoro live-synth output. Every time the service synthesizes a new
 * label in the user's chosen voice, the resulting PCM is written here
 * keyed by `(voiceId, text)`. Next time the same label is requested,
 * we serve directly from disk — same voice, near-zero latency.
 *
 * This sidesteps the chicken-and-egg problem with the bundled cache:
 * we can't pre-ship audio in every Kokoro voice without ballooning
 * the APK (38 MB × 10 voices = 380 MB), and we can't background-
 * render the full corpus on-device (~4 hours per voice). But TalkBack
 * usage is heavily Zipf-distributed — within a day or two of normal
 * use, the user's top ~200 labels naturally end up cached in the
 * voice they actually picked.
 *
 * Format: raw 16-bit LE PCM at the synthesizing service's native
 * sample rate (24 kHz for Kokoro). No compression — write cost
 * matters more than disk cost here, and a typical TalkBack label
 * weighs ~60 KB raw, so the steady-state cache per voice tops out at
 * a few tens of MB.
 *
 * Disk layout:
 *   filesDir/voice_cache/<voiceKey>/<sha16(text.lowercase)>.pcm
 *   filesDir/voice_cache/<voiceKey>/<sha16>.sr      (sample rate text)
 *
 * Eviction: none for v1 — the cache is small enough that we don't
 * need it. If real usage shows growth beyond ~50 MB per voice, add
 * an LRU sweep.
 */
class PerVoiceCache private constructor(private val context: Context) {

    data class Hit(val pcm: ShortArray, val sampleRate: Int)

    private val rootDir: File = File(context.filesDir, ROOT_DIR).apply { mkdirs() }

    /** Read the cache for [text] under [voiceKey]. Returns null on miss. */
    fun lookup(text: String, voiceKey: String): Hit? {
        if (voiceKey.isBlank() || text.isBlank()) return null
        val hash = sha16(text.trim().lowercase())
        val voiceDir = File(rootDir, voiceKey)
        val pcmFile = File(voiceDir, "$hash.pcm")
        val srFile = File(voiceDir, "$hash.sr")
        if (!pcmFile.exists() || !srFile.exists()) return null
        return try {
            val sr = srFile.readText().trim().toInt()
            val bytes = pcmFile.readBytes()
            val shorts = ShortArray(bytes.size / 2)
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(shorts)
            Hit(shorts, sr)
        } catch (t: Throwable) {
            Log.w(TAG, "lookup parse failed for $voiceKey/$hash: ${t.message}")
            null
        }
    }

    /**
     * Write [pcm] for [text] under [voiceKey]. Safe to call from any
     * thread. Silently no-ops if [voiceKey] is blank or [pcm] empty.
     * Writes are best-effort — failures log but don't throw.
     */
    fun store(text: String, voiceKey: String, pcm: ShortArray, sampleRate: Int) {
        if (voiceKey.isBlank() || text.isBlank() || pcm.isEmpty() || sampleRate <= 0) return
        val hash = sha16(text.trim().lowercase())
        val voiceDir = File(rootDir, voiceKey).apply { mkdirs() }
        val pcmFile = File(voiceDir, "$hash.pcm")
        val srFile = File(voiceDir, "$hash.sr")
        try {
            val bytes = ByteArray(pcm.size * 2)
            ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().put(pcm)
            // Atomic-ish write — temp file then rename. A crash mid-write
            // shouldn't leave a half-written .pcm that fakes a hit.
            val tmp = File(voiceDir, "$hash.pcm.tmp")
            tmp.writeBytes(bytes)
            tmp.renameTo(pcmFile)
            srFile.writeText(sampleRate.toString())
            Log.i(TAG, "wrote $voiceKey/$hash (${pcm.size} samples @ ${sampleRate}Hz)")
        } catch (t: Throwable) {
            Log.w(TAG, "store failed for $voiceKey/$hash: ${t.message}")
        }
    }

    companion object {
        private const val TAG = "PerVoiceCache"
        private const val ROOT_DIR = "voice_cache"

        @Volatile private var INSTANCE: PerVoiceCache? = null

        fun getInstance(context: Context): PerVoiceCache {
            INSTANCE?.let { return it }
            synchronized(this) {
                INSTANCE?.let { return it }
                val created = PerVoiceCache(context.applicationContext)
                INSTANCE = created
                return created
            }
        }

        private fun sha16(s: String): String {
            val md = MessageDigest.getInstance("SHA-256")
            val digest = md.digest(s.toByteArray(Charsets.UTF_8))
            val sb = StringBuilder(16)
            for (i in 0 until 8) sb.append(String.format("%02x", digest[i]))
            return sb.toString()
        }
    }
}
