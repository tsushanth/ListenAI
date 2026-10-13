package com.listenai.systemtts

import android.content.Context
import android.util.Log
import java.io.File

/**
 * Kotlin wrapper around the eSpeak NG JNI bridge (`libespeak_bridge.so`).
 * Provides text → IPA phonemization for Piper TTS.
 *
 * Init lifecycle:
 *  1. App startup: [ensureInitialized] — copies espeak-ng-data English
 *     subset from APK assets to `filesDir/espeak-ng-data/` once, then
 *     calls `espeak_Initialize` with that path. Returns the sample
 *     rate; values >0 mean ready.
 *  2. Per-call: [phonemize] takes UTF-8 English text and returns the
 *     IPA string. Thread-safe via a mutex — eSpeak is not.
 *  3. Shutdown is rarely needed; the library survives the process.
 *
 * Falls back gracefully — if the .so fails to load or init returns
 * <=0, [isReady] reports false and callers should use the Kokoro path
 * instead.
 */
object EspeakBridge {
    private const val TAG = "EspeakBridge"
    private const val DATA_ASSET_DIR = "espeak-ng-data"
    private const val DATA_LOCAL_DIR = "espeak-ng-data"

    // Bump when the bundled espeak-ng-data changes so existing installs re-copy it.
    private const val DATA_VERSION = "2"

    @Volatile private var loaded: Boolean = false
    @Volatile private var sampleRate: Int = -1
    @Volatile private var voiceOk: Boolean = false
    private val lock = Any()

    // The voice Piper's phonemizer expects (English); direct synthesis temporarily switches away from it.
    private var phonemizerVoice: String? = null
    private var currentVoice: String? = null

    fun isReady(): Boolean = loaded && sampleRate > 0 && voiceOk

    /**
     * Idempotent. Returns the sample rate from `espeak_Initialize`
     * (positive) or -1 on any failure. Safe to call from any thread;
     * concurrent calls block on a single init.
     */
    fun ensureInitialized(context: Context): Int {
        if (loaded) return sampleRate
        synchronized(lock) {
            if (loaded) return sampleRate
            try {
                System.loadLibrary("c++_shared")
                System.loadLibrary("espeak-ng")
                System.loadLibrary("espeak_bridge")
            } catch (t: Throwable) {
                Log.e(TAG, "loadLibrary failed: ${t.message}", t)
                loaded = true   // don't keep retrying
                sampleRate = -1
                return -1
            }
            val dataDir = File(context.filesDir, DATA_LOCAL_DIR)
            try {
                copyAssetDirOnce(context, DATA_ASSET_DIR, dataDir)
            } catch (t: Throwable) {
                Log.e(TAG, "asset copy failed: ${t.message}", t)
                loaded = true
                sampleRate = -1
                return -1
            }
            // espeak_Initialize expects the directory CONTAINING the
            // espeak-ng-data subdir, not the data dir itself. So we
            // pass filesDir.
            val rc = try {
                nativeInit(context.filesDir.absolutePath)
            } catch (t: Throwable) {
                Log.e(TAG, "nativeInit threw: ${t.message}", t)
                -1
            }
            if (rc > 0) {
                // Try a few voice-name variants — name-resolution rules
                // vary across espeak-ng builds. The first that returns
                // 0 (EE_OK) is the one we keep.
                val tryNames = listOf("en-US", "en-us", "en", "gmw/en-US", "gmw/en")
                for (name in tryNames) {
                    val voiceRc = try { nativeSetVoice(name) } catch (t: Throwable) { -1 }
                    if (voiceRc == 0) {
                        voiceOk = true
                        phonemizerVoice = name
                        currentVoice = name
                        Log.i(TAG, "init ok: sampleRate=$rc, voice='$name' rc=0")
                        break
                    } else {
                        Log.w(TAG, "setVoice '$name' rc=$voiceRc")
                    }
                }
                if (!voiceOk) Log.e(TAG, "no English voice resolved; phonemize disabled")
            } else {
                Log.e(TAG, "init failed: rc=$rc")
            }
            sampleRate = rc
            loaded = true
            return rc
        }
    }

    /**
     * Returns the IPA phonemization of [text], or empty string on
     * failure. Caller is expected to have called [ensureInitialized]
     * first; this method returns "" without trying to initialize.
     */
    fun phonemize(text: String): String {
        if (!isReady()) return ""
        return synchronized(lock) {
            try {
                selectVoiceLocked(phonemizerVoice)
                nativePhonemize(text) ?: ""
            } catch (t: Throwable) {
                Log.e(TAG, "phonemize threw: ${t.message}", t)
                ""
            }
        }
    }

    /** Sample rate of the PCM returned by [synthesize] (16-bit mono), or -1 if not initialised. */
    fun outputSampleRate(): Int = sampleRate

    /** True if eSpeak's dictionary for [dictName] (for example "es") was bundled and copied. */
    fun hasDictionary(context: Context, dictName: String): Boolean =
        File(context.filesDir, "$DATA_LOCAL_DIR/${dictName}_dict").exists()

    /**
     * Synthesizes [text] directly with eSpeak NG. Returns 16-bit mono PCM at [outputSampleRate], or
     * null if the engine is not ready, the voice is unknown, or synthesis failed or was cancelled.
     *
     * [rateWpm] is eSpeak words per minute (80..450), [pitch] 0..100, [volume] 0..200,
     * [punctuation] 0 = none, 1 = all, 2 = some.
     */
    fun synthesize(
        text: String,
        voiceName: String,
        rateWpm: Int,
        pitch: Int = 50,
        volume: Int = 100,
        punctuation: Int = 0
    ): ShortArray? {
        if (!isReady() || text.isBlank()) return null
        return synchronized(lock) {
            try {
                if (!selectVoiceLocked(voiceName)) return@synchronized null
                nativeSynthesize(text, rateWpm.coerceIn(80, 450), pitch.coerceIn(0, 100), volume.coerceIn(0, 200), punctuation)
            } catch (t: Throwable) {
                Log.e(TAG, "synthesize threw: ${t.message}", t)
                null
            } finally {
                // Leave the instance on the voice Piper's phonemizer expects.
                runCatching { selectVoiceLocked(phonemizerVoice) }
            }
        }
    }

    /** Asks a synthesis running on another thread to stop at the next audio buffer. */
    fun cancel() {
        if (loaded && sampleRate > 0) runCatching { nativeCancel() }
    }

    // Must be called holding [lock].
    private fun selectVoiceLocked(name: String?): Boolean {
        if (name == null) return false
        if (name == currentVoice) return true
        val rc = nativeSetVoice(name)
        if (rc != 0) {
            Log.w(TAG, "setVoice '$name' rc=$rc")
            return false
        }
        currentVoice = name
        return true
    }

    // Streams assets/<assetSubdir>/* into a target directory the first
    // time. Subsequent calls verify the marker file exists and return.
    // espeak-ng-data is ~800 KB for English; this is single-digit-ms
    // on Pixel-class hardware once the marker is present.
    private fun copyAssetDirOnce(context: Context, assetSubdir: String, dest: File) {
        val marker = File(dest, ".ready-v$DATA_VERSION")
        if (marker.exists()) return
        if (!dest.exists()) dest.mkdirs()
        val am = context.assets
        val entries = am.list(assetSubdir) ?: emptyArray()
        for (name in entries) {
            val sub = "$assetSubdir/$name"
            val outFile = File(dest, name)
            val children = am.list(sub) ?: emptyArray()
            if (children.isNotEmpty()) {
                // Directory (e.g. voices/!v/). Recurse.
                outFile.mkdirs()
                copyAssetDirOnce(context, sub, outFile)
            } else {
                am.open(sub).use { input ->
                    outFile.outputStream().use { out -> input.copyTo(out) }
                }
            }
        }
        marker.writeText("ok")
        Log.i(TAG, "copied $assetSubdir → $dest")
    }

    private external fun nativeInit(dataPath: String): Int
    private external fun nativeSetVoice(voiceName: String): Int
    private external fun nativePhonemize(text: String): String?
    private external fun nativeSynthesize(text: String, rateWpm: Int, pitch: Int, volume: Int, punctuation: Int): ShortArray?
    private external fun nativeCancel()
    private external fun nativeShutdown()
}
