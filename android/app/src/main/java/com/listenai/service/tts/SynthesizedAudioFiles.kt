package com.listenai.service.tts

import com.listenai.service.tts.chain.SourceId
import java.io.File

/**
 * The audio files the app makes for a document and the small files stored next to them (word timings, which kind of
 * voice made the audio). Plain `java.io`, so a unit test covers it.
 */
object SynthesizedAudioFiles {
    private const val VOICE_SUFFIX = ".voice"

    /** "cloud" for audio from the ReadAloud API, "system" for audio made on the phone (its engine or the on-device model). */
    fun kindOf(source: SourceId?): String? = when (source) {
        SourceId.API -> "cloud"
        SourceId.SYSTEM, SourceId.ON_DEVICE -> "system"
        null -> null
    }

    fun writeVoiceKind(audio: File, kind: String?) {
        if (kind != "cloud" && kind != "system") return
        try { File(audio.path + VOICE_SUFFIX).writeText(kind) } catch (_: Exception) { /* analytics detail only */ }
    }

    /** "cloud", "system", or null when unknown (audio made before this was recorded, or by another path). */
    fun readVoiceKind(audioPath: String?): String? {
        if (audioPath.isNullOrBlank()) return null
        return try {
            val f = File(audioPath + VOICE_SUFFIX)
            if (f.isFile && f.length() < 16) f.readText().trim().takeIf { it == "cloud" || it == "system" } else null
        } catch (_: Exception) { null }
    }

    /**
     * Deletes [audioPath] and its sidecars, but only when it is a file directly inside [cacheDir]: a path that points
     * anywhere else (an export, a remote URL) is not ours to remove.
     */
    fun deleteIfOurs(audioPath: String?, cacheDir: File) {
        if (audioPath.isNullOrBlank()) return
        try {
            val f = File(audioPath)
            if (f.parentFile?.canonicalFile != cacheDir.canonicalFile) return
            f.delete()
            File(f.path + ".words.json").delete()
            File(f.path + VOICE_SUFFIX).delete()
        } catch (_: Exception) { }
    }
}
