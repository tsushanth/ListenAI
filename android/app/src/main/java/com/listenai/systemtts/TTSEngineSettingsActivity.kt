package com.listenai.systemtts

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import android.media.MediaPlayer
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.RadioButtonUnchecked
import androidx.compose.material.icons.filled.Science
import androidx.compose.material.icons.filled.Stop
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import com.listenai.service.settings.SettingsManager
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.platform.LocalContext
import com.listenai.data.models.VoiceQuality
import com.listenai.service.tts.ChatterboxModelDownloader
import com.listenai.service.tts.ChatterboxOnDeviceService
import com.listenai.service.tts.KokoroModelDownloader
import com.listenai.service.tts.SynthesisOptions
import com.listenai.service.tts.TTSCoordinator
import com.listenai.service.tts.TTSServiceFactory
import com.listenai.service.voice.VoiceCloningService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.koin.compose.koinInject
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceTier
import com.listenai.ui.theme.ListenAITheme

/**
 * Settings activity shown inside `Settings → Accessibility → Text-to-speech
 * output → ReadAloud AI Voices → ⚙` so users can browse / preview the voice
 * catalog and (M4) purchase premium voice packs.
 *
 * Linked from `res/xml/tts_engine.xml` via `android:settingsActivity`.
 *
 * M4 scaffolding only — preview and purchase buttons are wired to TODOs.
 * The purchase flow plugs into the existing [com.listenai.service.billing
 * .RevenueCatManager]; products are added in the next iteration.
 */
class TTSEngineSettingsActivity : ComponentActivity() {

    @OptIn(ExperimentalMaterial3Api::class)
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContent {
            ListenAITheme {
                Scaffold(
                    topBar = {
                        TopAppBar(title = { Text("ReadAloud AI Voices") })
                    }
                ) { padding ->
                    VoiceCatalogScreen(padding)
                }
            }
        }
    }
}

/**
 * Lightweight preview controller — keeps one MediaPlayer alive across the
 * screen's lifetime so we can interrupt a preview when the user taps a
 * different voice, and stop cleanly when the activity goes away.
 *
 * `previewing` carries the system voice name of the in-flight or playing
 * preview, or null if idle. `loading` is true while we're synthesizing
 * (waiting on `TTSCoordinator.previewVoice`).
 */
private class PreviewController {
    var player: MediaPlayer? = null
    var job: Job? = null
    var previewing: String? = null
    var loading: Boolean = false
}

/**
 * Run the on-device Chatterbox pipeline directly (bypassing TTSCoordinator)
 * and play the resulting WAV. This is the actual exerciser of the new
 * inference code — separate from the cloud preview path that's always been
 * working.
 *
 * @param onStateChange callback with (inFlightVoiceName, playingVoiceName)
 *   so the composable can render loading / playing icons. Either field
 *   may be null.
 */
private fun previewOnDevice(
    voiceName: String,
    preset: com.listenai.data.models.VoicePreset,
    context: android.content.Context,
    controller: PreviewController,
    scope: kotlinx.coroutines.CoroutineScope,
    onStateChange: (Pair<String?, String?>) -> Unit,
) {
    val tag = "TTSEngineSettings"

    // Stop any in-flight preview.
    controller.job?.cancel()
    controller.player?.runCatching { stop(); release() }
    controller.player = null

    onStateChange(voiceName to null) // inFlight=voiceName, playing=null
    android.util.Log.i(tag, "previewOnDevice START voice=${preset.name}")

    controller.job = scope.launch {
        val t0 = System.currentTimeMillis()
        try {
            val service = ChatterboxOnDeviceService.getInstance(context)
            val result = withContext(Dispatchers.IO) {
                service.synthesize(preset.sampleText, preset, SynthesisOptions.DEFAULT)
            }
            val ms = System.currentTimeMillis() - t0
            android.util.Log.i(tag, "previewOnDevice SYNTH done in ${ms}ms file=${result.audioFile.absolutePath}")

            val mp = MediaPlayer()
            mp.setDataSource(result.audioFile.absolutePath)
            mp.setOnPreparedListener {
                android.util.Log.i(tag, "previewOnDevice PLAY voice=${preset.name}")
                it.start()
                onStateChange(null to voiceName)
            }
            mp.setOnCompletionListener {
                android.util.Log.i(tag, "previewOnDevice DONE voice=${preset.name}")
                onStateChange(null to null)
                it.release()
                if (controller.player === it) controller.player = null
            }
            mp.setOnErrorListener { _, what, extra ->
                android.util.Log.e(tag, "previewOnDevice MediaPlayer error what=$what extra=$extra")
                onStateChange(null to null)
                true
            }
            controller.player = mp
            mp.prepareAsync()
        } catch (e: Exception) {
            android.util.Log.e(tag,
                "previewOnDevice FAILED voice=${preset.name} type=${e.javaClass.simpleName} msg=${e.message}", e)
            onStateChange(null to null)
        }
    }
}

@Composable
private fun VoiceCatalogScreen(padding: PaddingValues) {
    val context = LocalContext.current
    val onDevice = remember { TTSServiceFactory.getKokoroOnDeviceService(context) }
    val coordinator = koinInject<TTSCoordinator>()
    val downloader = remember { KokoroModelDownloader.getInstance(context) }
    val downloadState by downloader.state.collectAsState()
    val chatterboxDownloader = remember { ChatterboxModelDownloader.getInstance(context) }
    val chatterboxState by chatterboxDownloader.state.collectAsState()
    val scope = rememberCoroutineScope()
    val presets = VoiceCatalog.presets()

    // System-default-voice persistence. SettingsManager.selectedVoiceId is
    // the same preference that drives in-app playback voice — reusing it
    // means a TalkBack user picking a voice here also gets that voice when
    // they open ReadAloud directly to read a book.
    // ReadAloudTTSService.onGetDefaultVoiceNameFor() consults this same
    // value so the user's selection actually takes effect system-wide.
    val settings = remember { SettingsManager.getInstance(context) }
    val selectedVoiceId by settings.selectedVoiceId.collectAsState()
    var clones by remember { mutableStateOf(VoiceCatalog.clonedVoices()) }

    val controller = remember { PreviewController() }
    var inFlight by remember { mutableStateOf<String?>(null) }   // voice name being synthesized
    var playing by remember { mutableStateOf<String?>(null) }    // voice name currently playing

    // Refresh cloned voices when the screen opens, then poll the cache every
    // 2s for ~10s so newly-fetched clones surface without restarting.
    LaunchedEffect(Unit) {
        VoiceCatalog.refreshClonedVoices(context)
        repeat(5) {
            kotlinx.coroutines.delay(2000)
            clones = VoiceCatalog.clonedVoices()
        }
    }

    DisposableEffect(Unit) {
        onDispose {
            controller.job?.cancel()
            controller.player?.runCatching { stop(); release() }
            controller.player = null
        }
    }

    fun preview(voiceName: String, preset: com.listenai.data.models.VoicePreset) {
        // Stop any in-flight preview
        controller.job?.cancel()
        controller.player?.runCatching { stop(); release() }
        controller.player = null

        // Toggle off if user tapped the same voice that's currently playing
        if (playing == voiceName) {
            playing = null
            inFlight = null
            return
        }

        val isClonedVoice = preset.id.startsWith("cloned_") || preset.providerModelId == "chatterbox"

        inFlight = voiceName
        playing = null

        controller.job = scope.launch {
            val t0 = System.currentTimeMillis()
            android.util.Log.i("TTSEngineSettings",
                "preview START voice=${preset.name} provider=${preset.provider} model=${preset.providerModelId} cloned=$isClonedVoice")
            try {
                val result = if (isClonedVoice) {
                    // Cloned voices: use TTSCoordinator (cloud / chatterbox).
                    // This preview is a user-initiated one-shot — latency is
                    // acceptable. The SYSTEM TTS engine path still rejects
                    // clones (TalkBack can't tolerate network synthesis).
                    withContext(Dispatchers.IO) {
                        coordinator.previewVoice(preset, VoiceQuality.STANDARD)
                    }
                } else {
                    // Built-in voices: on-device only.
                    if (!downloader.isModelOnDisk()) {
                        android.util.Log.w("TTSEngineSettings",
                            "preview ABORT — voice model not on disk yet")
                        inFlight = null
                        return@launch
                    }
                    withContext(Dispatchers.IO) {
                        onDevice.synthesize(preset.sampleText, preset, SynthesisOptions.DEFAULT)
                    }
                }
                val synthMs = System.currentTimeMillis() - t0
                android.util.Log.i("TTSEngineSettings",
                    "preview SYNTH done voice=${preset.name} in ${synthMs}ms file=${result.audioFile.absolutePath} size=${result.fileSizeBytes}b duration=${result.duration}s")

                // If the user tapped a different voice while we were synthesizing,
                // abandon this result.
                if (inFlight != voiceName) {
                    android.util.Log.i("TTSEngineSettings", "preview ABANDONED — user switched voices")
                    return@launch
                }

                val mp = MediaPlayer()
                mp.setDataSource(result.audioFile.absolutePath)
                mp.setOnPreparedListener {
                    android.util.Log.i("TTSEngineSettings", "preview PLAY voice=${preset.name}")
                    it.start()
                    playing = voiceName
                    inFlight = null
                }
                mp.setOnCompletionListener {
                    android.util.Log.i("TTSEngineSettings", "preview DONE voice=${preset.name}")
                    playing = null
                    it.release()
                    if (controller.player === it) controller.player = null
                }
                mp.setOnErrorListener { _, what, extra ->
                    android.util.Log.e("TTSEngineSettings",
                        "MediaPlayer ERROR voice=${preset.name} what=$what extra=$extra")
                    playing = null
                    inFlight = null
                    true
                }
                controller.player = mp
                mp.prepareAsync()
            } catch (e: Exception) {
                android.util.Log.e("TTSEngineSettings",
                    "preview FAILED voice=${preset.name} type=${e.javaClass.simpleName} msg=${e.message}", e)
                inFlight = null
                playing = null
            } catch (t: Throwable) {
                android.util.Log.e("TTSEngineSettings",
                    "preview FAILED HARD voice=${preset.name} type=${t.javaClass.simpleName} msg=${t.message}", t)
                inFlight = null
                playing = null
            }
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
    ) {
        Text(
            text = "Selected voice is used by every app on your phone that reads aloud — including TalkBack, Maps, and Kindle. ReadAloud's system voices run entirely on your device.",
            modifier = Modifier.padding(16.dp),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        ModelStatusBanner(downloadState, onDownload = { downloader.startIfPossible() })
        // Show the Chatterbox download banner only when the user actually
        // has clones — otherwise it's noise. Once Ready, the system TTS path
        // will be allowed to use clones (currently still blocked until M2.6
        // inference is wired).
        if (clones.isNotEmpty()) {
            ChatterboxBanner(
                state = chatterboxState,
                onDownload = { chatterboxDownloader.startIfPossible() },
            )
        }
        LazyColumn(
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 4.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            if (clones.isNotEmpty()) {
                item("clones-header") {
                    SectionHeader(
                        title = "Your cloned voices",
                        caption = "Cloud-synthesized — TalkBack will be slower. Built-in voices below recommended for screen reader use."
                    )
                }
                val chatterboxReady = chatterboxState is ChatterboxModelDownloader.State.Ready
                items(clones, key = { "clone-${it.id}" }) { clone ->
                    val voiceName = "readaloud-cloned-${clone.id.lowercase()}-en-us"
                    val preset = remember(clone.id) { VoiceCatalog.resolvePreset(voiceName) }
                    val onDeviceVoiceName = "$voiceName::ondevice"   // distinct key so its play state is separate from cloud
                    ClonedVoiceRow(
                        clone = clone,
                        isLoading = inFlight == voiceName,
                        isPlaying = playing == voiceName,
                        isOnDeviceLoading = inFlight == onDeviceVoiceName,
                        isOnDevicePlaying = playing == onDeviceVoiceName,
                        systemWide = chatterboxReady,
                        onPreview = { if (preset != null) preview(voiceName, preset) },
                        onPreviewOnDevice = if (chatterboxReady && preset != null) {
                            { previewOnDevice(onDeviceVoiceName, preset, context, controller, scope) {
                                inFlight = it.first; playing = it.second
                            } }
                        } else null,
                    )
                }
            }
            item("builtin-header") {
                SectionHeader(
                    title = "Built-in voices",
                    caption = "Lower latency. Best for screen reader use."
                )
            }
            items(presets, key = { "builtin-${it.id}" }) { preset ->
                val (lang, region) = preset.languageCode.split("-", "_").let {
                    if (it.size >= 2) it[0] to it[1] else it[0] to "US"
                }
                val voiceName = "readaloud-${preset.id.lowercase()}-${lang.lowercase()}-${region.lowercase()}"
                VoiceRow(
                    preset = preset,
                    isLoading = inFlight == voiceName,
                    isPlaying = playing == voiceName,
                    isSelected = selectedVoiceId == preset.id,
                    onSelect = { settings.setSelectedVoiceId(preset.id) },
                    onPreview = { preview(voiceName, preset) }
                )
            }
        }
    }
}

@Composable
private fun ChatterboxBanner(
    state: ChatterboxModelDownloader.State,
    onDownload: () -> Unit
) {
    when (state) {
        is ChatterboxModelDownloader.State.Ready -> {
            BannerCard(
                title = "Cloned voices available system-wide",
                caption = "Voice clone engine is on this device. Once on-device cloning inference is finished, your cloned voices will work in TalkBack, Maps, and Kindle too.",
                actionLabel = null,
                onAction = {},
                tint = Color(0xFF22C55E)
            )
        }
        is ChatterboxModelDownloader.State.Idle -> {
            BannerCard(
                title = "Enable cloned voices system-wide",
                caption = "Download the on-device voice clone engine (~1.5 GB, Wi-Fi only). Makes your clones work in TalkBack / Maps / Kindle. Cloud preview below still works without this.",
                actionLabel = "Download",
                onAction = onDownload,
                tint = Color(0xFF7C3AED)
            )
        }
        is ChatterboxModelDownloader.State.WaitingForWifi -> {
            BannerCard(
                title = "Voice clone engine — waiting for Wi-Fi",
                caption = "Will resume when you connect to Wi-Fi. ~1.5 GB download.",
                actionLabel = null,
                onAction = {},
                tint = Color(0xFFE0B341)
            )
        }
        is ChatterboxModelDownloader.State.Downloading -> {
            BannerCard(
                title = "Downloading voice clone engine… ${state.percent}%",
                caption = "${state.downloadedMb} MB of ${state.totalMb} MB · 14 files",
                actionLabel = null,
                onAction = {},
                tint = Color(0xFF60A5FA)
            )
        }
        is ChatterboxModelDownloader.State.Failed -> {
            BannerCard(
                title = "Voice clone engine download failed",
                caption = state.message,
                actionLabel = "Retry",
                onAction = onDownload,
                tint = Color(0xFFEF4444)
            )
        }
    }
}

@Composable
private fun ModelStatusBanner(
    state: KokoroModelDownloader.State,
    onDownload: () -> Unit
) {
    when (state) {
        is KokoroModelDownloader.State.Ready -> {
            // Don't show anything when the model is ready — keeps the UI clean.
        }
        is KokoroModelDownloader.State.Idle -> {
            BannerCard(
                title = "Download voice model",
                caption = "Required for ReadAloud voices to work system-wide. ~80 MB, downloads on Wi-Fi.",
                actionLabel = "Download",
                onAction = onDownload,
                tint = Color(0xFFE0B341)
            )
        }
        is KokoroModelDownloader.State.WaitingForWifi -> {
            BannerCard(
                title = "Waiting for Wi-Fi",
                caption = "Voice model will download when you connect to Wi-Fi.",
                actionLabel = null,
                onAction = {},
                tint = Color(0xFFE0B341)
            )
        }
        is KokoroModelDownloader.State.Downloading -> {
            BannerCard(
                title = "Downloading voice model… ${state.percent}%",
                caption = "${state.downloadedMb} MB of ${state.totalMb} MB",
                actionLabel = null,
                onAction = {},
                tint = Color(0xFF60A5FA)
            )
        }
        is KokoroModelDownloader.State.Failed -> {
            BannerCard(
                title = "Download failed",
                caption = state.message,
                actionLabel = "Retry",
                onAction = onDownload,
                tint = Color(0xFFEF4444)
            )
        }
    }
}

@Composable
private fun BannerCard(
    title: String,
    caption: String,
    actionLabel: String?,
    onAction: () -> Unit,
    tint: Color
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(tint)
            )
            Column(modifier = Modifier
                .padding(start = 12.dp)
                .weight(1f)) {
                Text(title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp)
                Text(caption, fontSize = 12.sp,
                     color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (actionLabel != null) {
                androidx.compose.material3.TextButton(onClick = onAction) {
                    Text(actionLabel)
                }
            }
        }
    }
}

@Composable
private fun SectionHeader(title: String, caption: String) {
    Column(modifier = Modifier.padding(top = 12.dp, bottom = 4.dp)) {
        Text(title, fontWeight = FontWeight.SemiBold, fontSize = 14.sp,
             color = MaterialTheme.colorScheme.onSurface)
        Text(caption, fontSize = 12.sp,
             color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
private fun ClonedVoiceRow(
    clone: VoiceCloningService.ClonedVoice,
    isLoading: Boolean,
    isPlaying: Boolean,
    isOnDeviceLoading: Boolean,
    isOnDevicePlaying: Boolean,
    systemWide: Boolean,
    onPreview: () -> Unit,
    onPreviewOnDevice: (() -> Unit)?,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(Color(0xFF7C3AED).copy(alpha = 0.18f)),
                contentAlignment = Alignment.Center
            ) {
                Text("🎤", fontSize = 22.sp)
            }
            Column(modifier = Modifier
                .padding(start = 16.dp)
                .weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(clone.name, fontWeight = FontWeight.SemiBold, fontSize = 16.sp)
                    if (systemWide) {
                        AssistChip(
                            onClick = {},
                            label = { Text("System-wide") },
                            modifier = Modifier.padding(start = 8.dp)
                        )
                    } else {
                        AssistChip(
                            onClick = {},
                            label = { Text("Cloned") },
                            modifier = Modifier.padding(start = 8.dp)
                        )
                    }
                }
                val caption = buildString {
                    append(if (systemWide) "On-device · works in TalkBack" else "Network preview only")
                    clone.durationSec?.let { append(" · ${it.toInt()}s sample") }
                }
                Text(caption, fontSize = 12.sp,
                     color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            // ▶ cloud preview (always available)
            PreviewButton(isLoading = isLoading, isPlaying = isPlaying, onClick = onPreview)
            // 🔬 on-device test (only when Chatterbox is downloaded)
            if (onPreviewOnDevice != null) {
                IconButton(onClick = onPreviewOnDevice) {
                    when {
                        isOnDeviceLoading -> CircularProgressIndicator(
                            modifier = Modifier.size(20.dp),
                            strokeWidth = 2.dp
                        )
                        isOnDevicePlaying -> Icon(Icons.Default.Stop, contentDescription = "Stop on-device preview")
                        else -> Icon(Icons.Default.Science, contentDescription = "Test on-device synthesis")
                    }
                }
            }
        }
    }
}

@Composable
private fun PreviewButton(isLoading: Boolean, isPlaying: Boolean, onClick: () -> Unit) {
    IconButton(onClick = onClick) {
        when {
            isLoading -> CircularProgressIndicator(
                modifier = Modifier.size(20.dp),
                strokeWidth = 2.dp
            )
            isPlaying -> Icon(Icons.Default.Stop, contentDescription = "Stop preview")
            else -> Icon(Icons.Default.PlayArrow, contentDescription = "Preview voice")
        }
    }
}

@Composable
private fun VoiceRow(
    preset: VoicePreset,
    isLoading: Boolean,
    isPlaying: Boolean,
    isSelected: Boolean,
    onSelect: () -> Unit,
    onPreview: () -> Unit,
) {
    // Build a single accessibility-merged content description so TalkBack
    // reads the row as one focus target, including selected state. Without
    // this, TalkBack hops between sub-elements (avatar, name, language
    // chip, preview button) and the row itself has no announced action.
    val description = buildString {
        append(preset.name)
        append(", ")
        append(preset.languageCode)
        append(", ")
        append(preset.gender.name.lowercase())
        if (preset.tier == VoiceTier.PREMIUM) append(", premium voice")
        append(if (isSelected) ", selected" else ", not selected. Double-tap to select.")
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .selectable(
                selected = isSelected,
                onClick = onSelect,
                role = Role.RadioButton,
            )
            .semantics(mergeDescendants = true) {
                contentDescription = description
            },
        colors = CardDefaults.cardColors(),
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Selection indicator — visible radio/check so sighted users see
            // which voice is currently the system default. Tinted to match
            // the row's state.
            Icon(
                imageVector = if (isSelected) Icons.Default.Check else Icons.Default.RadioButtonUnchecked,
                contentDescription = null,
                tint = if (isSelected) MaterialTheme.colorScheme.primary
                       else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(24.dp),
            )
            Box(modifier = Modifier.size(8.dp))
            VoiceAvatar(preset)
            Column(modifier = Modifier
                .padding(start = 16.dp)
                .weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = preset.name,
                        fontWeight = FontWeight.SemiBold,
                        fontSize = 16.sp
                    )
                    if (preset.tier == VoiceTier.PREMIUM) {
                        AssistChip(
                            onClick = { /* TODO(M4): launch RevenueCat purchase */ },
                            label = { Text("Premium") },
                            leadingIcon = {
                                Icon(Icons.Default.Lock, contentDescription = null,
                                     modifier = Modifier.size(16.dp))
                            },
                            colors = AssistChipDefaults.assistChipColors(),
                            modifier = Modifier.padding(start = 8.dp)
                        )
                    }
                }
                Text(
                    text = "${preset.languageCode} · ${preset.gender.name.lowercase()}",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            PreviewButton(isLoading = isLoading, isPlaying = isPlaying, onClick = onPreview)
        }
    }
}

@Composable
private fun VoiceAvatar(preset: VoicePreset) {
    val hex = preset.accentColorHex?.removePrefix("#")
    val fallback = MaterialTheme.colorScheme.primary
    val color = if (hex != null) {
        runCatching { Color(android.graphics.Color.parseColor("#$hex")) }.getOrDefault(fallback)
    } else fallback
    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(color.copy(alpha = 0.18f)),
        contentAlignment = Alignment.Center
    ) {
        val label = preset.avatarEmoji?.takeIf { it.isNotEmpty() }
            ?: preset.name.firstOrNull()?.toString()
            ?: "♫"
        Text(text = label, fontSize = 22.sp)
    }
}
