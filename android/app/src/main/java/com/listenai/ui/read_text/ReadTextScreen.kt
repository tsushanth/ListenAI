package com.listenai.ui.read_text

import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.CameraAlt
import androidx.compose.material.icons.outlined.Image
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import com.listenai.R
import com.listenai.service.LanguageDetector
import com.listenai.service.tts.ReadTextLanguage
import androidx.compose.runtime.rememberCoroutineScope
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import androidx.compose.runtime.mutableIntStateOf
import kotlinx.coroutines.tasks.await
import java.util.Locale

/**
 * Read Text — camera/gallery → on-device OCR (ML Kit) → speak via the
 * user's preferred system TTS engine (which they've set to ReadAloud).
 *
 * v0 ships the **gallery → OCR → speech** path. Camera capture is a
 * second commit because it adds CameraX lifecycle + a runtime permission
 * grant flow — not in scope for the first interactive cut.
 *
 * Accessibility design notes:
 * - All controls have explicit content descriptions tuned for TalkBack.
 * - Status line (idle / loading / no text / ready) is a Compose
 *   ``liveRegion`` so TalkBack announces state changes without forcing
 *   the user to navigate to it.
 * - Recognized text appears in a scrollable area + is auto-spoken via
 *   ``TextToSpeech.speak()`` — which routes to whichever engine the user
 *   has selected in system settings.
 * - Replay button lets the user re-hear the result without re-picking.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ReadTextScreen() {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // Local UI state — kept simple, no ViewModel yet. Promote when state
    // surface grows (camera, history, multi-language, etc.).
    var status by remember { mutableStateOf(Status.Idle) }
    var recognizedText by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    // Set when the phone has no voice for the language of the text: shows the install button, and is re-checked on return.
    var noVoiceLanguage by remember { mutableStateOf<String?>(null) }
    // Bumped to build a fresh engine connection after the user installed voice data (a live one does not see it).
    var ttsGeneration by remember { mutableIntStateOf(0) }
    var speakAgainOnReady by remember { mutableStateOf(false) }

    // System TextToSpeech — uses the user's preferred engine. Initialized
    // once per generation; released in DisposableEffect.
    val mainHandler = remember { Handler(Looper.getMainLooper()) }
    val ready = remember(ttsGeneration) { CompletableDeferred<Boolean>() }
    val tts = remember(ttsGeneration) {
        var instance: TextToSpeech? = null
        instance = TextToSpeech(context.applicationContext) { result ->
            if (result == TextToSpeech.SUCCESS) {
                instance?.language = Locale.US
            }
            ready.complete(result == TextToSpeech.SUCCESS)
        }
        instance
    }

    // Detect the language of [text], then speak it with a voice for that language, or show the missing-voice message.
    // The tab used to force Locale.US, which reads Spanish or French text with an English voice.
    fun speak(text: String, utteranceId: String) {
        scope.launch {
            val engineUp = withTimeoutOrNull(ENGINE_WAIT_MS) { ready.await() } == true
            if (!engineUp) {
                errorMessage = context.getString(R.string.speech_no_engine_message)
                status = Status.Error
                return@launch
            }
            val language = ReadTextLanguage.languageOrDefault(LanguageDetector.detectOrNull(text))
            when (val plan = ReadTextLanguage.plan(language, tts.isLanguageAvailable(ReadTextLanguage.localeFor(language)))) {
                is ReadTextLanguage.Plan.Speak -> {
                    noVoiceLanguage = null
                    tts.language = plan.locale
                    tts.speak(text, TextToSpeech.QUEUE_FLUSH, null, utteranceId)
                }
                is ReadTextLanguage.Plan.NoVoice -> {
                    noVoiceLanguage = plan.language
                    errorMessage = context.getString(R.string.lang_no_voice_message, LanguageDetector.displayName(plan.language) ?: plan.language)
                    status = Status.Error
                }
            }
        }
    }

    // Back from the voice-data installer: build a new engine connection and read the text again.
    var resumeTick by remember { mutableIntStateOf(0) }
    val lifecycleOwner = androidx.compose.ui.platform.LocalLifecycleOwner.current
    DisposableEffect(lifecycleOwner) {
        val observer = androidx.lifecycle.LifecycleEventObserver { _, event ->
            if (event == androidx.lifecycle.Lifecycle.Event.ON_RESUME) resumeTick++
        }
        lifecycleOwner.lifecycle.addObserver(observer)
        onDispose { lifecycleOwner.lifecycle.removeObserver(observer) }
    }
    LaunchedEffect(resumeTick) {
        if (noVoiceLanguage != null && recognizedText.isNotBlank()) {
            speakAgainOnReady = true
            ttsGeneration++
        }
    }
    LaunchedEffect(ttsGeneration) {
        if (speakAgainOnReady) {
            speakAgainOnReady = false
            errorMessage = null
            status = Status.LoadingVoice
            speak(recognizedText, REPLAY_UTTERANCE_ID)
        }
    }

    // Wire TTS lifecycle callbacks → UI status. Engine-spinup time between
    // tts.speak() and the first audible sample can be 0.5-2 s; without
    // explicit feedback the user thinks the app is dead.
    DisposableEffect(tts) {
        tts.setOnUtteranceProgressListener(object : UtteranceProgressListener() {
            override fun onStart(utteranceId: String?) {
                mainHandler.post { if (status == Status.LoadingVoice) status = Status.Speaking }
            }

            override fun onDone(utteranceId: String?) {
                mainHandler.post {
                    if (status == Status.Speaking || status == Status.LoadingVoice) {
                        status = Status.Spoken
                    }
                }
            }

            @Deprecated("Required override even though deprecated")
            override fun onError(utteranceId: String?) {
                mainHandler.post {
                    errorMessage = "Playback failed. Tap Read again to retry."
                    status = Status.Error
                }
            }

            override fun onError(utteranceId: String?, errorCode: Int) {
                mainHandler.post {
                    errorMessage = "Playback failed (code $errorCode). Tap Read again to retry."
                    status = Status.Error
                }
            }
        })
        onDispose {
            tts.stop()
            tts.shutdown()
        }
    }

    // PhotoPicker — modern Android, no READ_MEDIA_IMAGES permission required.
    val pickImage = rememberLauncherForActivityResult(
        ActivityResultContracts.PickVisualMedia()
    ) { uri: Uri? ->
        if (uri == null) {
            // User cancelled the picker — silent return, no state change.
            return@rememberLauncherForActivityResult
        }
        status = Status.Recognizing
        errorMessage = null
        recognizedText = ""
        runOcr(
            context = context,
            uri = uri,
            onResult = { text ->
                recognizedText = text
                // Move straight to LoadingVoice when text was found — the
                // OnUtteranceProgressListener will transition us to
                // Speaking when the TTS engine actually emits audio.
                status = if (text.isBlank()) Status.NoText else Status.LoadingVoice
                if (text.isNotBlank()) speak(text, AUTO_SPEAK_UTTERANCE_ID)
            },
            onError = { msg ->
                errorMessage = msg
                status = Status.Error
            },
        )
    }

    Scaffold(
        topBar = {
            TopAppBar(title = {
                Text(
                    text = stringResource(R.string.read_text_title),
                    modifier = Modifier.semantics { heading() },
                )
            })
        },
    ) { padding ->
        ReadTextContent(
            padding = padding,
            status = status,
            recognizedText = recognizedText,
            errorMessage = errorMessage,
            showInstallVoice = noVoiceLanguage != null,
            onInstallVoice = { com.listenai.service.tts.TtsInstall.open(context, installEngine = false) },
            onPickGallery = {
                pickImage.launch(
                    PickVisualMediaRequest(
                        ActivityResultContracts.PickVisualMedia.ImageOnly
                    )
                )
            },
            onTakePhoto = {
                // TODO: launch CameraX capture flow — next commit.
            },
            onReplay = {
                if (recognizedText.isNotBlank()) {
                    errorMessage = null
                    status = Status.LoadingVoice
                    speak(recognizedText, REPLAY_UTTERANCE_ID)
                }
            },
        )
    }
}

private enum class Status {
    Idle,
    Recognizing,    // OCR running on the picked image
    LoadingVoice,   // OCR done, TTS engine spinning up (no audio yet)
    Speaking,       // TTS engine is actively emitting audio
    Spoken,         // playback finished, show Read again
    NoText,         // OCR returned empty
    Error,          // OCR or TTS failed
}

private const val REPLAY_UTTERANCE_ID = "read_text_replay"
private const val AUTO_SPEAK_UTTERANCE_ID = "read_text_auto"
/** How long to wait for the speech engine to connect before saying there is none. */
private const val ENGINE_WAIT_MS = 5_000L

@Composable
private fun ReadTextContent(
    padding: PaddingValues,
    status: Status,
    recognizedText: String,
    errorMessage: String?,
    showInstallVoice: Boolean,
    onInstallVoice: () -> Unit,
    onPickGallery: () -> Unit,
    onTakePhoto: () -> Unit,
    onReplay: () -> Unit,
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(padding)
            .padding(horizontal = 24.dp, vertical = 16.dp)
            .verticalScroll(rememberScrollState()),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text(
            text = stringResource(R.string.read_text_subtitle),
            style = MaterialTheme.typography.bodyLarge,
            textAlign = TextAlign.Center,
        )

        Spacer(modifier = Modifier.height(24.dp))

        Button(
            onClick = onTakePhoto,
            modifier = Modifier
                .fillMaxWidth()
                .height(64.dp)
                .semantics {
                    contentDescription = "Take a photo of text to read aloud. Coming in the next update."
                },
            enabled = false, // Re-enabled when CameraX path lands in the next commit.
            colors = ButtonDefaults.buttonColors(),
        ) {
            Icon(imageVector = Icons.Outlined.CameraAlt, contentDescription = null)
            Text(
                text = "  " + stringResource(R.string.read_text_take_photo),
                style = MaterialTheme.typography.titleMedium,
            )
        }

        Spacer(modifier = Modifier.height(12.dp))

        OutlinedButton(
            onClick = onPickGallery,
            modifier = Modifier
                .fillMaxWidth()
                .height(64.dp)
                .semantics {
                    contentDescription = "Pick an existing photo from your gallery to read aloud"
                },
        ) {
            Icon(imageVector = Icons.Outlined.Image, contentDescription = null)
            Text(
                text = "  " + stringResource(R.string.read_text_pick_gallery),
                style = MaterialTheme.typography.titleMedium,
            )
        }

        Spacer(modifier = Modifier.height(20.dp))

        // Status / progress / result lives in a single liveRegion so TalkBack
        // announces transitions without the user navigating to it.
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .semantics { liveRegion = LiveRegionMode.Polite },
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            when (status) {
                Status.Idle -> {
                    Text(
                        text = stringResource(R.string.read_text_coming_soon),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        textAlign = TextAlign.Center,
                    )
                }
                Status.Recognizing -> {
                    CircularProgressIndicator()
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Reading the image…",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                Status.LoadingVoice -> {
                    CircularProgressIndicator()
                    Spacer(modifier = Modifier.height(8.dp))
                    Text(
                        text = "Starting voice playback…",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    if (recognizedText.isNotBlank()) {
                        Spacer(modifier = Modifier.height(16.dp))
                        Text(
                            text = recognizedText,
                            style = MaterialTheme.typography.bodyLarge,
                        )
                    }
                }
                Status.Speaking -> {
                    Text(
                        text = "🔊  Speaking now",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp),
                    )
                    Text(
                        text = recognizedText,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                }
                Status.Spoken -> {
                    Text(
                        text = "Done.",
                        style = MaterialTheme.typography.titleSmall,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(bottom = 8.dp),
                    )
                    Text(
                        text = recognizedText,
                        style = MaterialTheme.typography.bodyLarge,
                    )
                    Spacer(modifier = Modifier.height(12.dp))
                    TextButton(onClick = onReplay) {
                        Text(text = "Read again")
                    }
                }
                Status.NoText -> {
                    Text(
                        text = "No text found in that image. Try a clearer photo.",
                        style = MaterialTheme.typography.bodyMedium,
                        textAlign = TextAlign.Center,
                    )
                }
                Status.Error -> {
                    Text(
                        text = errorMessage ?: "Something went wrong.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.error,
                        textAlign = TextAlign.Center,
                    )
                    if (showInstallVoice) {
                        Spacer(modifier = Modifier.height(12.dp))
                        Button(onClick = onInstallVoice) {
                            Text(text = stringResource(R.string.player_install_voice_data))
                        }
                    }
                    if (recognizedText.isNotBlank()) {
                        Spacer(modifier = Modifier.height(12.dp))
                        TextButton(onClick = onReplay) {
                            Text(text = "Read again")
                        }
                    }
                }
            }
        }
    }
}

/**
 * Run ML Kit Text Recognition on the picked URI and hand the text to [onResult]; the caller detects its language and
 * speaks it. Errors surface via [onError] so the composable can re-render its status liveRegion.
 */
private fun runOcr(
    context: android.content.Context,
    uri: Uri,
    onResult: (String) -> Unit,
    onError: (String) -> Unit,
) {
    try {
        val image = InputImage.fromFilePath(context, uri)
        val recognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
        recognizer.process(image)
            .addOnSuccessListener { visionText -> onResult(visionText.text) }
            .addOnFailureListener { e ->
                onError("Text recognition failed: ${e.message}")
            }
    } catch (e: Exception) {
        onError("Could not load the image: ${e.message}")
    }
}
