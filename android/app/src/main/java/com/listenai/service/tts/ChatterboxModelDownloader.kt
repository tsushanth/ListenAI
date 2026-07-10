package com.listenai.service.tts

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import java.io.File

/**
 * Thin orchestrator around [ChatterboxDownloadWorker]. Mirrors
 * [KokoroModelDownloader] in shape so the same Settings-UI patterns can
 * render its state without special-casing.
 *
 * Chatterbox ships **four** model files (vs Kokoro's one), all under
 * `onnx-community/chatterbox-ONNX/onnx/` on Hugging Face:
 *   - language_model_q4.onnx       ~350 MB  (Q4-quantized Llama-3.2-1B backbone)
 *   - embed_tokens.onnx              ~50 MB  (input-token embedding lookup)
 *   - conditional_decoder.onnx     ~100 MB  (speech tokens → 24 kHz PCM)
 *   - speech_encoder.onnx            ~30 MB  (audio sample → 256-dim speaker embedding)
 *
 * Total: ~530 MB. Download-on-demand under Wi-Fi constraint.
 *
 * "Ready" requires all four to be present and have plausible sizes.
 */
class ChatterboxModelDownloader private constructor(
    private val context: Context,
) {
    sealed class State {
        object Idle : State()
        object WaitingForWifi : State()
        data class Downloading(val percent: Int, val downloadedMb: Int, val totalMb: Int) : State()
        object Ready : State()
        data class Failed(val message: String) : State()
    }

    private val _state = MutableStateFlow<State>(if (isReady()) State.Ready else State.Idle)
    val state: StateFlow<State> = _state.asStateFlow()

    // ------------------------------------------------------------------
    // File layout on disk
    // ------------------------------------------------------------------

    private val modelDir: File
        get() = File(context.filesDir, "chatterbox").apply { mkdirs() }

    // --- 4 ONNX graph files (small, only graph metadata) ---
    val lmFile: File                  get() = File(modelDir, "language_model_q4.onnx")
    val embedTokensFile: File         get() = File(modelDir, "embed_tokens.onnx")
    val conditionalDecoderFile: File  get() = File(modelDir, "conditional_decoder.onnx")
    val speechEncoderFile: File       get() = File(modelDir, "speech_encoder.onnx")

    // --- 4 .onnx_data weight files (external tensors — this is where the
    //     bulk of the 530 MB lives. HuggingFace splits any model larger than
    //     2 GB by default, and chatterbox-ONNX uses this split for ALL four
    //     models even though they're individually small.) ---
    val lmDataFile: File                  get() = File(modelDir, "language_model_q4.onnx_data")
    val embedTokensDataFile: File         get() = File(modelDir, "embed_tokens.onnx_data")
    val conditionalDecoderDataFile: File  get() = File(modelDir, "conditional_decoder.onnx_data")
    val speechEncoderDataFile: File       get() = File(modelDir, "speech_encoder.onnx_data")

    // --- 5 metadata / preprocessor / config files ---
    val tokenizerFile: File           get() = File(modelDir, "tokenizer.json")
    val tokenizerConfigFile: File     get() = File(modelDir, "tokenizer_config.json")
    val configFile: File              get() = File(modelDir, "config.json")
    val generationConfigFile: File    get() = File(modelDir, "generation_config.json")
    val preprocessorConfigFile: File  get() = File(modelDir, "preprocessor_config.json")
    val defaultVoiceFile: File        get() = File(modelDir, "default_voice.wav")

    /**
     * True when every required ONNX graph + matching .onnx_data weights +
     * config file exists with a plausible size.
     *
     * Note: the *graph* files (.onnx) are tiny (a few KB each) — they only
     * contain the model topology, not weights. The weights live in the
     * matching `.onnx_data` files, which is where the floors below apply.
     */
    fun isReady(): Boolean {
        return lmFile.exists() &&
            embedTokensFile.exists() &&
            conditionalDecoderFile.exists() &&
            speechEncoderFile.exists() &&
            lmDataFile.exists() && lmDataFile.length() > LM_MIN_SIZE &&
            embedTokensDataFile.exists() && embedTokensDataFile.length() > EMBED_TOKENS_MIN_SIZE &&
            conditionalDecoderDataFile.exists() && conditionalDecoderDataFile.length() > CONDITIONAL_DECODER_MIN_SIZE &&
            speechEncoderDataFile.exists() && speechEncoderDataFile.length() > SPEECH_ENCODER_MIN_SIZE &&
            tokenizerFile.exists() && tokenizerFile.length() > 1_000 &&
            configFile.exists() && configFile.length() > 100 &&
            generationConfigFile.exists() && generationConfigFile.length() > 10 &&
            preprocessorConfigFile.exists() && preprocessorConfigFile.length() > 10
    }

    /**
     * Enqueue the WorkManager download. Idempotent — if a job is already
     * running it stays running. UI just observes [state].
     */
    fun startIfPossible() {
        if (isReady()) {
            _state.value = State.Ready
            return
        }
        // TODO(M2.6-download): replace this with the real WorkManager enqueue
        // once ChatterboxDownloadWorker has real HTTP logic. For now the
        // worker stub immediately marks the job as failed so the UI shows a
        // clear state instead of spinning forever.
        val req = OneTimeWorkRequestBuilder<ChatterboxDownloadWorker>()
            .setConstraints(
                Constraints.Builder()
                    .setRequiredNetworkType(NetworkType.UNMETERED)
                    .setRequiresStorageNotLow(true)
                    .build()
            )
            .build()
        WorkManager.getInstance(context).enqueueUniqueWork(
            WORK_NAME,
            ExistingWorkPolicy.KEEP,
            req,
        )
        Log.i(TAG, "startIfPossible: enqueued ChatterboxDownloadWorker")
    }

    /**
     * Used by the Worker to push progress updates into the StateFlow. The
     * UI re-renders on each emit.
     */
    fun reportProgress(state: State) {
        _state.value = state
    }

    companion object {
        private const val TAG = "ChatterboxModelDownloader"
        const val WORK_NAME = "chatterbox-model-download"

        // Plausible minimum sizes used by [isReady] to reject truncated files.
        // Real bundle sizes vary by quantization tier — these are floors.
        // Floors set well below the real sizes (337 / 58 / 563 / 509 MB) to
        // tolerate minor revision drift; high enough to reject smudge files.
        const val LM_MIN_SIZE: Long = 250L * 1024 * 1024                   // ~337 MB real
        const val EMBED_TOKENS_MIN_SIZE: Long = 40L * 1024 * 1024          // ~58 MB real
        const val SPEECH_ENCODER_MIN_SIZE: Long = 400L * 1024 * 1024       // ~563 MB real
        const val CONDITIONAL_DECODER_MIN_SIZE: Long = 350L * 1024 * 1024  // ~509 MB real
        const val TOTAL_DOWNLOAD_BYTES: Long = 1500L * 1024 * 1024         // ~1.47 GB total

        @Volatile
        private var instance: ChatterboxModelDownloader? = null

        fun getInstance(context: Context): ChatterboxModelDownloader {
            return instance ?: synchronized(this) {
                instance ?: ChatterboxModelDownloader(context.applicationContext)
                    .also { instance = it }
            }
        }
    }
}
