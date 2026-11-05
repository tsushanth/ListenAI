package com.listenai.service.tts.chain

import android.content.Context
import android.util.Log
import com.listenai.data.models.VoicePreset
import com.listenai.service.tts.KokoroModelDownloader
import com.listenai.service.tts.SynthesisOptions
import com.listenai.service.tts.TTSServiceFactory
import java.io.ByteArrayOutputStream

/**
 * The Kokoro model that ships as an optional download. Used only when it is already on disk and has proven fast
 * enough: the first chunks it speaks measure the real-time factor once ([RtfVerdict], stored per app version), and
 * a model slower than playback is skipped from then on (a read that stalls every few seconds is worse than
 * a clear message). English only.
 */
class OnDeviceModelSource(context: Context) : TtsSource {

    private val app = context.applicationContext
    override val id = SourceId.ON_DEVICE
    private val prefs = app.getSharedPreferences("tts_chain_ondevice", Context.MODE_PRIVATE)
    private val verdict = RtfVerdict()

    private fun storedVerdict(): Boolean? {
        if (prefs.getInt("version", -1) != VERSION_KEY) return null
        return if (prefs.contains("fast")) prefs.getBoolean("fast", true) else null
    }

    override suspend fun unavailableReason(request: TtsRequest): FallbackReason? {
        if (request.language.substringBefore('-').lowercase() != "en") return FallbackReason.UNSUPPORTED_LANGUAGE
        if (!KokoroModelDownloader.getInstance(app).isModelOnDisk()) return FallbackReason.MODEL_ABSENT
        if (storedVerdict() == false) return FallbackReason.MODEL_TOO_SLOW
        return null
    }

    override suspend fun synthesize(text: String, request: TtsRequest): PcmChunk {
        val preset = VoicePreset.builtInVoices.firstOrNull { it.id == request.voiceId } ?: VoicePreset.builtInVoices.first()
        val service = TTSServiceFactory.getKokoroOnDeviceService(app)
        val out = ByteArrayOutputStream()
        val completed = service.synthesizeChunkedPcmWithText(text, preset, SynthesisOptions.DEFAULT.copy(speed = request.speed)) { pcm, _, _ ->
            val b = ByteArray(pcm.size * 2)
            for (i in pcm.indices) { b[2 * i] = pcm[i].toByte(); b[2 * i + 1] = (pcm[i].toInt() shr 8).toByte() }
            out.write(b)
            true
        }
        if (!completed || out.size() == 0) throw SourceFailure(FallbackReason.MODEL_ABSENT, message = "on-device model produced no audio")
        return PcmChunk(out.toByteArray(), 24_000)
    }

    override fun onChunkMeasured(synthMs: Long, audioMs: Long) {
        if (storedVerdict() != null) return
        val v = verdict.add(synthMs, audioMs) ?: return
        prefs.edit().putInt("version", VERSION_KEY).putBoolean("fast", v).apply()
        Log.i(TAG, "on-device model real-time factor verdict: fast=$v median=${verdict.medianRtf}")
    }

    companion object {
        private const val TAG = "OnDeviceModelSource"
        private val VERSION_KEY = com.listenai.BuildConfig.VERSION_CODE
    }
}
