package com.listenai.systemtts

import android.content.Context
import android.util.Log
import org.json.JSONObject
import java.security.MessageDigest

/**
 * Read-only cache of common Android system labels ("Wi-Fi", "Settings",
 * "Bluetooth", etc.) pre-rendered with Piper en_US-amy-low and shipped
 * in the APK at `assets/talkback_cache/`.
 *
 * Lookup is exact-match: `text.trim().lowercase()` → SHA-256 → first 16
 * hex chars → manifest entry. Must match the rendering script
 * `/tmp/piper_spike/render_cache.py` byte-for-byte.
 *
 * On a hit the caller plays the returned `Hit.pcm` bytes directly via
 * AudioTrack — no synthesis, no model load, no waiting. On a miss the
 * caller falls through to the regular Kokoro path.
 *
 * Voice consistency caveat: cached audio is Amy (Piper), Kokoro
 * fallback is whatever voice the user picked. They sound different.
 * Trading consistency for the latency win in v56; the proper fix is
 * shipping the full Piper integration so cache and live synth share a
 * voice.
 */
class TalkbackLabelCache private constructor(private val context: Context) {

    data class Hit(
        val pcm: ByteArray,
        val sampleRate: Int,
        val channels: Int,
        val bitsPerSample: Int,
        val text: String,
        val audioMs: Int,
    )

    private val manifestByHash: Map<String, ManifestEntry>
    private val sampleRate: Int
    private val channels: Int
    private val bitsPerSample: Int

    init {
        val raw = context.assets.open("talkback_cache/manifest.json").bufferedReader().use { it.readText() }
        val json = JSONObject(raw)
        sampleRate = json.getInt("sample_rate")
        channels = json.getInt("channels")
        bitsPerSample = json.getInt("bits_per_sample")
        val labels = json.getJSONObject("labels")
        val parsed = mutableMapOf<String, ManifestEntry>()
        labels.keys().forEach { hash ->
            val e = labels.getJSONObject(hash)
            parsed[hash] = ManifestEntry(
                text = e.getString("text"),
                norm = e.getString("norm"),
                file = e.getString("file"),
                audioMs = e.getInt("ms"),
            )
        }
        manifestByHash = parsed
        Log.i(TAG, "loaded ${manifestByHash.size} label entries (${sampleRate}Hz/${channels}ch/${bitsPerSample}-bit)")
    }

    /** Returns null on miss, the PCM bytes + format on hit. */
    fun lookup(text: String): Hit? {
        val norm = text.trim().lowercase()
        if (norm.isEmpty()) return null
        val hash = sha256First16Hex(norm)
        val entry = manifestByHash[hash] ?: return null
        return try {
            val bytes = context.assets.open("talkback_cache/${entry.file}").use { it.readBytes() }
            Hit(bytes, sampleRate, channels, bitsPerSample, entry.text, entry.audioMs)
        } catch (t: Throwable) {
            Log.w(TAG, "asset open failed for ${entry.file}: ${t.message}")
            null
        }
    }

    private data class ManifestEntry(val text: String, val norm: String, val file: String, val audioMs: Int)

    companion object {
        private const val TAG = "TalkbackLabelCache"

        @Volatile private var INSTANCE: TalkbackLabelCache? = null

        fun getInstance(context: Context): TalkbackLabelCache {
            INSTANCE?.let { return it }
            synchronized(this) {
                INSTANCE?.let { return it }
                val created = TalkbackLabelCache(context.applicationContext)
                INSTANCE = created
                return created
            }
        }

        private fun sha256First16Hex(s: String): String {
            val md = MessageDigest.getInstance("SHA-256")
            val digest = md.digest(s.toByteArray(Charsets.UTF_8))
            val sb = StringBuilder(16)
            for (i in 0 until 8) {
                sb.append(String.format("%02x", digest[i]))
            }
            return sb.toString()
        }
    }
}
