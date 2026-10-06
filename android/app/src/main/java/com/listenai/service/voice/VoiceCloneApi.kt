package com.listenai.service.voice

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException

/**
 * HTTP client for the consent-gated voice cloning API (`/api/voice-clones`, `/api/tts/cloned`,
 * `/api/tts/job-cloned`). Contract: docs/VOICE_CLONING_CONSENT.md.
 *
 * Every call is authenticated with the user's Supabase access token (`Authorization: Bearer`).
 * There is no X-Device-ID and no client-supplied reference URL any more: the reference audio
 * lives only on the serving app and is never returned by any route.
 */

/** A single-use phrase the user must read aloud. Expires after ~5 minutes. */
data class ConsentChallenge(
    val challengeId: String,
    val phrase: String,
    /** ISO-8601 instant as sent by the server, e.g. 2026-10-06T12:00:00.000Z. */
    val expiresAt: String,
    /** Parsed [expiresAt] in epoch millis, or null if it could not be parsed. */
    val expiresAtMillis: Long?
) {
    fun isExpired(nowMillis: Long): Boolean = expiresAtMillis != null && nowMillis >= expiresAtMillis
}

/** Metadata of a voice created through the consent flow. Never contains audio. */
data class ClonedVoice(
    val id: String,
    val name: String,
    val language: String,
    /** "active" is usable; anything else (deleting, disabled) is not. */
    val status: String,
    val createdAt: String? = null
) {
    val isReady: Boolean get() = status == STATUS_ACTIVE

    companion object {
        const val STATUS_ACTIVE = "active"
    }
}

/** Reply of POST /api/tts/job-cloned. */
data class CloneSynthesisJob(
    val jobId: String,
    /** "processing" or "ready" (cache hit). */
    val status: String,
    val audioUrl: String?,
    val estimatedWaitSec: Int?
)

/**
 * An audio clip to upload. [bytes] is invoked lazily on an IO thread so the caller can stream a
 * file or a content:// Uri without holding it in memory before the request is built.
 */
class AudioClip(
    val filename: String,
    val mimeType: String,
    val durationSec: Int,
    val bytes: () -> ByteArray
)

/** Server-reported failure. [code] is the stable machine code from the response body. */
class VoiceCloneException(
    val httpStatus: Int,
    val code: String,
    val serverMessage: String?,
    val details: JSONObject? = null,
    cause: Throwable? = null
) : Exception(serverMessage ?: code, cause) {
    companion object {
        const val CODE_NETWORK = "network_error"
        const val CODE_SIGN_IN = "unauthenticated"
        const val CODE_MALFORMED = "malformed_response"

        fun network(cause: Throwable) = VoiceCloneException(0, CODE_NETWORK, cause.message, null, cause)
        fun signInRequired() = VoiceCloneException(401, CODE_SIGN_IN, "Sign in required.")
    }
}

/** Operations the app (and the view model) needs. Implemented by [VoiceCloneApi]. */
interface VoiceCloneClient {
    suspend fun requestConsentChallenge(): ConsentChallenge
    suspend fun createVoice(
        challengeId: String,
        name: String,
        language: String,
        consent: AudioClip,
        reference: AudioClip
    ): ClonedVoice

    suspend fun listVoices(): List<ClonedVoice>
    suspend fun deleteVoice(voiceId: String)
}

class VoiceCloneApi(
    baseUrl: String,
    private val http: OkHttpClient,
    private val accessToken: suspend () -> String?
) : VoiceCloneClient {

    private val baseUrl = baseUrl.trimEnd('/')

    // ---- /api/voice-clones -------------------------------------------------------------

    override suspend fun requestConsentChallenge(): ConsentChallenge {
        val json = executeJson(
            Request.Builder()
                .url("$baseUrl/api/voice-clones/consent-challenges")
                .post(ByteArray(0).toRequestBody(null))
        )
        return ConsentChallenge(
            challengeId = json.requireString("challenge_id"),
            phrase = json.requireString("phrase"),
            expiresAt = json.requireString("expires_at"),
            expiresAtMillis = parseIsoMillis(json.optString("expires_at"))
        )
    }

    override suspend fun createVoice(
        challengeId: String,
        name: String,
        language: String,
        consent: AudioClip,
        reference: AudioClip
    ): ClonedVoice {
        val (consentBytes, referenceBytes) = withContext(Dispatchers.IO) {
            try {
                consent.bytes() to reference.bytes()
            } catch (e: IOException) {
                throw VoiceCloneException.network(e)
            }
        }
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("challenge_id", challengeId)
            .addFormDataPart("name", name)
            .addFormDataPart("language", language)
            .addFormDataPart(
                "consent", consent.filename,
                consentBytes.toRequestBody(consent.mimeType.toMediaType())
            )
            .addFormDataPart(
                "reference", reference.filename,
                referenceBytes.toRequestBody(reference.mimeType.toMediaType())
            )
            .build()
        val json = executeJson(Request.Builder().url("$baseUrl/api/voice-clones").post(body))
        return parseVoice(json)
    }

    override suspend fun listVoices(): List<ClonedVoice> {
        val json = executeJson(Request.Builder().url("$baseUrl/api/voice-clones").get())
        val arr = json.optJSONArray("voices") ?: return emptyList()
        return (0 until arr.length()).map { parseVoice(arr.getJSONObject(it)) }
    }

    override suspend fun deleteVoice(voiceId: String) {
        executeJson(Request.Builder().url("$baseUrl/api/voice-clones/$voiceId").delete())
    }

    // ---- synthesis ---------------------------------------------------------------------

    /** Sync synthesis (<= 1500 chars). Returns WAV bytes. May take 60-180 s on a cold start. */
    suspend fun synthesize(text: String, voiceId: String, speed: Float = 1.0f): ByteArray {
        val request = Request.Builder()
            .url("$baseUrl/api/tts/cloned")
            .post(synthesisBody(text, voiceId, speed).toString().toRequestBody(JSON))
        return withContext(Dispatchers.IO) {
            val response = call(request)
            response.use {
                if (!it.isSuccessful) throw parseError(it)
                it.body?.bytes() ?: throw VoiceCloneException(it.code, VoiceCloneException.CODE_MALFORMED, "Empty audio")
            }
        }
    }

    /** Async synthesis job. Poll `/api/tts/job/:id` (see SelfHostedTTSService). */
    suspend fun createSynthesisJob(
        text: String,
        voiceId: String,
        speed: Float = 1.0f,
        articleId: String? = null,
        articleTitle: String? = null
    ): CloneSynthesisJob {
        val body = synthesisBody(text, voiceId, speed).apply {
            articleId?.let { put("article_id", it) }
            articleTitle?.let { put("article_title", it) }
        }
        val json = executeJson(
            Request.Builder().url("$baseUrl/api/tts/job-cloned").post(body.toString().toRequestBody(JSON))
        )
        return CloneSynthesisJob(
            jobId = json.requireString("job_id"),
            status = json.requireString("status"),
            audioUrl = json.optString("audio_url").takeIf { it.isNotEmpty() && it != "null" },
            estimatedWaitSec = if (json.has("estimated_wait_sec")) json.optInt("estimated_wait_sec") else null
        )
    }

    // ---- plumbing ----------------------------------------------------------------------

    private fun synthesisBody(text: String, voiceId: String, speed: Float) = JSONObject().apply {
        put("text", text)
        put("voice_id", voiceId)
        put("speed", speed.coerceIn(0.5f, 3.0f).toDouble())
    }

    private suspend fun call(builder: Request.Builder): Response {
        val token = accessToken()?.takeIf { it.isNotBlank() } ?: throw VoiceCloneException.signInRequired()
        val request = builder.addHeader("Authorization", "Bearer $token").addHeader("Accept", "application/json").build()
        return try {
            http.newCall(request).execute()
        } catch (e: IOException) {
            throw VoiceCloneException.network(e)
        }
    }

    private suspend fun executeJson(builder: Request.Builder): JSONObject = withContext(Dispatchers.IO) {
        call(builder).use { response ->
            if (!response.isSuccessful) throw parseError(response)
            val text = try {
                response.body?.string().orEmpty()
            } catch (e: IOException) {
                throw VoiceCloneException.network(e)
            }
            if (text.isBlank()) JSONObject() else try {
                JSONObject(text)
            } catch (e: Exception) {
                throw VoiceCloneException(response.code, VoiceCloneException.CODE_MALFORMED, "Unreadable server response")
            }
        }
    }

    private fun parseVoice(json: JSONObject) = ClonedVoice(
        id = json.requireString("id"),
        name = json.optString("name", ""),
        language = json.optString("language", "en"),
        status = json.optString("status", ClonedVoice.STATUS_ACTIVE),
        createdAt = json.optString("created_at").takeIf { it.isNotEmpty() && it != "null" }
    )

    private fun JSONObject.requireString(key: String): String =
        optString(key).takeIf { it.isNotEmpty() && it != "null" }
            ?: throw VoiceCloneException(200, VoiceCloneException.CODE_MALFORMED, "Missing '$key' in response")

    private fun parseError(response: Response): VoiceCloneException {
        val text = try { response.body?.string().orEmpty() } catch (e: IOException) { "" }
        return parseErrorBody(response.code, text)
    }

    companion object {
        private val JSON = "application/json".toMediaType()

        /**
         * Two error envelopes exist on the backend:
         *  - /api/voice-clones: `{ error: <message>, code: <code>, details? }`
         *  - the tts routes (global error handler): `{ error: <CODE>, message: <message>, details? }`
         * Normalised here so callers only ever see a code and a message.
         */
        fun parseErrorBody(httpStatus: Int, body: String): VoiceCloneException {
            val json = try { JSONObject(body) } catch (e: Exception) { null }
            if (json == null) return VoiceCloneException(httpStatus, "http_$httpStatus", null)
            val explicitCode = json.optString("code").takeIf { it.isNotEmpty() && it != "null" }
            val error = json.optString("error").takeIf { it.isNotEmpty() && it != "null" }
            val message = json.optString("message").takeIf { it.isNotEmpty() && it != "null" }
            val code = (explicitCode ?: error ?: "http_$httpStatus")
            val serverMessage = if (explicitCode != null) error ?: message else message ?: error
            return VoiceCloneException(httpStatus, code, serverMessage, json.optJSONObject("details"))
        }

        fun parseIsoMillis(value: String?): Long? {
            if (value.isNullOrEmpty()) return null
            return try {
                java.time.Instant.parse(value).toEpochMilli()
            } catch (e: Exception) {
                null
            }
        }
    }
}
