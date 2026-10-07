package com.listenai.service.voice

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import java.io.File
import java.io.IOException

/** Builds [AudioClip]s from recorded files or documents picked with the system file picker. */
object AudioClips {

    /** Backend accepts at most 25 MB per file (multer limit). */
    const val MAX_BYTES: Long = 25L * 1024 * 1024

    /**
     * Maps a raw MIME type / file name to one of the types the backend accepts, or null if the
     * format is not supported. The backend silently drops files whose MIME it does not know
     * (reported as `audio_required`), so this is normalised on the client.
     */
    fun normalizeMime(rawMime: String?, filename: String?): String? {
        val mime = rawMime?.lowercase()?.substringBefore(';')?.trim()
        when (mime) {
            "audio/wav", "audio/x-wav", "audio/wave", "audio/vnd.wave" -> return "audio/wav"
            "audio/flac", "audio/x-flac" -> return "audio/flac"
            "audio/ogg", "application/ogg", "audio/opus" -> return "audio/ogg"
            "audio/mpeg", "audio/mp3" -> return "audio/mpeg"
            "audio/mp4", "audio/x-m4a", "audio/m4a", "audio/aac", "audio/mp4a-latm" -> return "audio/mp4"
            "audio/webm" -> return "audio/webm"
        }
        return when (filename?.substringAfterLast('.', "")?.lowercase()) {
            "wav" -> "audio/wav"
            "flac" -> "audio/flac"
            "ogg", "oga", "opus" -> "audio/ogg"
            "mp3" -> "audio/mpeg"
            "m4a", "mp4", "aac" -> "audio/mp4"
            "webm" -> "audio/webm"
            else -> null
        }
    }

    fun fromFile(file: File, durationSec: Int, mime: String = "audio/mp4"): AudioClip =
        AudioClip(file.name, mime, durationSec) { file.readBytes() }

    /** Result of reading a picked document; [error] is a user-facing message when [clip] is null. */
    data class Picked(val clip: AudioClip?, val error: String? = null)

    fun fromUri(context: Context, uri: Uri): Picked {
        val resolver = context.contentResolver
        val name = try {
            resolver.query(uri, arrayOf(android.provider.OpenableColumns.DISPLAY_NAME), null, null, null)?.use {
                if (it.moveToFirst()) it.getString(0) else null
            }
        } catch (e: Exception) {
            null
        } ?: uri.lastPathSegment ?: "reference"
        val mime = normalizeMime(resolver.getType(uri), name)
            ?: return Picked(null, "That file type isn't supported. Use WAV, FLAC, OGG, MP3 or M4A.")
        val size = try {
            resolver.openAssetFileDescriptor(uri, "r")?.use { it.length } ?: -1L
        } catch (e: Exception) {
            -1L
        }
        if (size > MAX_BYTES) return Picked(null, "That file is too large (25 MB maximum).")
        val durationSec = durationSeconds(context, uri)
            ?: return Picked(null, "Couldn't read that audio file. Try a different file.")
        return Picked(AudioClip(name, mime, durationSec) {
            resolver.openInputStream(uri)?.use { it.readBytes() } ?: throw IOException("Cannot read $name")
        })
    }

    fun durationSeconds(context: Context, uri: Uri): Int? {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(context, uri)
            retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull()
                ?.let { (it / 1000L).toInt() }
        } catch (e: Exception) {
            null
        } finally {
            try { retriever.release() } catch (_: Exception) {}
        }
    }
}
