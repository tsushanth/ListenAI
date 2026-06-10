package com.listenai.ui.voice

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.listenai.service.voice.VoiceCloningService
import com.listenai.service.review.AppReviewService
import com.listenai.ui.theme.Blue
import com.listenai.ui.theme.Green
import com.listenai.ui.theme.Purple
import com.listenai.ui.theme.Red
import com.listenai.ui.theme.Yellow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.koin.compose.koinInject
import java.io.File

/**
 * Voice cloning flow steps
 */
enum class VoiceCloningStep {
    INTRO,
    PROFILE,
    RECORDING,
    PROCESSING,
    SUCCESS,
    ERROR
}

/**
 * Multi-step voice cloning flow screen.
 * Steps: Intro → Profile Setup → Recording → Processing → Success
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceCloningFlowScreen(
    onComplete: () -> Unit,
    onCancel: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voiceCloningService: VoiceCloningService = koinInject()
    val appReviewService: AppReviewService = koinInject()

    // Flow state
    var currentStep by remember { mutableStateOf(VoiceCloningStep.INTRO) }
    var voiceName by remember { mutableStateOf("") }
    var errorMessage by remember { mutableStateOf("") }

    // Recording state
    var isRecording by remember { mutableStateOf(false) }
    var isPaused by remember { mutableStateOf(false) }
    var recordingDuration by remember { mutableIntStateOf(0) }
    var recordedFileUri by remember { mutableStateOf<Uri?>(null) }
    var mediaRecorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var recordingFile by remember { mutableStateOf<File?>(null) }

    // Permission state
    var hasRecordPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(
                context,
                Manifest.permission.RECORD_AUDIO
            ) == PackageManager.PERMISSION_GRANTED
        )
    }

    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasRecordPermission = granted
    }

    // File picker for the "upload an existing audio clip" path. Mirrors the
    // record flow but lets users hand us audio they recorded elsewhere — the
    // intended use case is screen-reader users (the on-screen read-aloud
    // sample isn't usable for them since TalkBack speaks the prompt and the
    // mic picks it up). Selecting a file populates `recordedFileUri` and
    // `recordingDuration` so the existing Continue button + createClone
    // path work unchanged.
    val audioFilePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        try {
            // Persist read access so we can pass the URI to the service layer
            // after returning from the picker activity.
            context.contentResolver.takePersistableUriPermission(
                uri,
                android.content.Intent.FLAG_GRANT_READ_URI_PERMISSION
            )
        } catch (_: SecurityException) {
            // Some pickers (e.g., third-party file managers) don't grant
            // persistable permission. The transient grant is enough for the
            // immediate upload since we read the bytes inline.
        }

        // Pull duration from the picked file so the existing "minimum 30s"
        // gating + the recommended-length copy keep working.
        val retriever = android.media.MediaMetadataRetriever()
        val durationSec: Int = try {
            retriever.setDataSource(context, uri)
            val durationMs = retriever
                .extractMetadata(android.media.MediaMetadataRetriever.METADATA_KEY_DURATION)
                ?.toLongOrNull() ?: 0L
            (durationMs / 1000L).toInt()
        } catch (e: Exception) {
            errorMessage = "Could not read the selected audio file. Try a different file (WAV, M4A, or MP3)."
            currentStep = VoiceCloningStep.ERROR
            return@rememberLauncherForActivityResult
        } finally {
            try { retriever.release() } catch (_: Exception) {}
        }

        recordedFileUri = uri
        recordingDuration = durationSec
        isRecording = false
        isPaused = false
    }

    // Recording timer
    LaunchedEffect(isRecording, isPaused) {
        if (isRecording && !isPaused) {
            while (isRecording && !isPaused) {
                delay(1000)
                recordingDuration++
            }
        }
    }

    // Navigation functions
    fun goBack() {
        when (currentStep) {
            VoiceCloningStep.PROFILE -> currentStep = VoiceCloningStep.INTRO
            VoiceCloningStep.RECORDING -> currentStep = VoiceCloningStep.PROFILE
            VoiceCloningStep.ERROR -> currentStep = VoiceCloningStep.RECORDING
            else -> {}
        }
    }

    // Recording functions
    fun startRecording() {
        if (!hasRecordPermission) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }

        try {
            val file = File(context.cacheDir, "voice_clone_${System.currentTimeMillis()}.m4a")
            recordingFile = file

            mediaRecorder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                MediaRecorder(context)
            } else {
                @Suppress("DEPRECATION")
                MediaRecorder()
            }.apply {
                setAudioSource(MediaRecorder.AudioSource.MIC)
                setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
                setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
                setAudioEncodingBitRate(128000)
                setAudioSamplingRate(44100)
                setOutputFile(file.absolutePath)
                prepare()
                start()
            }

            isRecording = true
            isPaused = false
            recordingDuration = 0
        } catch (e: Exception) {
            errorMessage = "Failed to start recording: ${e.message}"
            currentStep = VoiceCloningStep.ERROR
        }
    }

    fun pauseRecording() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            mediaRecorder?.pause()
        }
        isPaused = true
    }

    fun resumeRecording() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            mediaRecorder?.resume()
        }
        isPaused = false
    }

    fun stopRecording() {
        try {
            mediaRecorder?.apply {
                stop()
                release()
            }
            mediaRecorder = null
            isRecording = false
            isPaused = false

            recordingFile?.let { file ->
                if (file.exists() && file.length() > 0) {
                    recordedFileUri = Uri.fromFile(file)
                }
            }
        } catch (e: Exception) {
            errorMessage = "Failed to stop recording: ${e.message}"
        }
    }

    // Create clone function
    fun createClone() {
        val uri = recordedFileUri ?: return
        val name = voiceName.trim().ifEmpty { "My Voice" }

        currentStep = VoiceCloningStep.PROCESSING

        scope.launch {
            try {
                voiceCloningService.createInstantClone(
                    name = name,
                    audioSampleUri = uri
                )
                currentStep = VoiceCloningStep.SUCCESS

                // Record voice clone success for app review prompts
                appReviewService.recordVoiceCloneSuccess()
                appReviewService.checkAndTriggerFeedbackPrompt()
            } catch (e: Exception) {
                errorMessage = e.message ?: "Failed to create voice clone"
                currentStep = VoiceCloningStep.ERROR
            }
        }
    }

    // Cleanup on dispose
    DisposableEffect(Unit) {
        onDispose {
            mediaRecorder?.release()
            mediaRecorder = null
        }
    }

    Scaffold(
        topBar = {
            if (currentStep != VoiceCloningStep.PROCESSING && currentStep != VoiceCloningStep.SUCCESS) {
                TopAppBar(
                    title = { },
                    navigationIcon = {
                        IconButton(onClick = {
                            if (currentStep == VoiceCloningStep.INTRO) {
                                onCancel()
                            } else {
                                goBack()
                            }
                        }) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    },
                    actions = {
                        IconButton(onClick = onCancel) {
                            Icon(Icons.Default.Close, contentDescription = "Cancel")
                        }
                    }
                )
            }
        }
    ) { padding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            when (currentStep) {
                VoiceCloningStep.INTRO -> IntroStep(
                    onContinue = { currentStep = VoiceCloningStep.PROFILE }
                )
                VoiceCloningStep.PROFILE -> ProfileStep(
                    voiceName = voiceName,
                    onVoiceNameChange = { voiceName = it },
                    onContinue = { currentStep = VoiceCloningStep.RECORDING }
                )
                VoiceCloningStep.RECORDING -> RecordingStep(
                    isRecording = isRecording,
                    isPaused = isPaused,
                    recordingDuration = recordingDuration,
                    hasRecording = recordedFileUri != null,
                    onStartRecording = { startRecording() },
                    onPauseRecording = { pauseRecording() },
                    onResumeRecording = { resumeRecording() },
                    onStopRecording = { stopRecording() },
                    onSelectAudioFile = {
                        audioFilePicker.launch(arrayOf("audio/*"))
                    },
                    onContinue = { createClone() }
                )
                VoiceCloningStep.PROCESSING -> ProcessingStep()
                VoiceCloningStep.SUCCESS -> SuccessStep(
                    voiceName = voiceName.ifEmpty { "My Voice" },
                    onDone = onComplete
                )
                VoiceCloningStep.ERROR -> ErrorStep(
                    errorMessage = errorMessage,
                    onRetry = { currentStep = VoiceCloningStep.RECORDING },
                    onCancel = onCancel
                )
            }
        }
    }
}

@Composable
private fun IntroStep(onContinue: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize()) {
        // Header illustration
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .height(200.dp)
                .background(
                    Brush.linearGradient(
                        colors = listOf(
                            Yellow.copy(alpha = 0.3f),
                            Purple.copy(alpha = 0.3f)
                        )
                    )
                ),
            contentAlignment = Alignment.Center
        ) {
            // Waveform and face
            Icon(
                Icons.Default.Person,
                contentDescription = null,
                modifier = Modifier.size(80.dp),
                tint = Color.White.copy(alpha = 0.8f)
            )
        }

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(24.dp)
        ) {
            // Title
            Text(
                text = "INTRODUCE",
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                letterSpacing = 1.sp
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "Voice Cloning",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Features
            FeatureRow(
                icon = Icons.Default.Mic,
                text = "Clone your voice by recording audio"
            )
            Spacer(modifier = Modifier.height(20.dp))
            FeatureRow(
                icon = Icons.Default.GraphicEq,
                text = "Listen to your content in any voice you've cloned."
            )
            Spacer(modifier = Modifier.height(20.dp))
            FeatureRow(
                icon = Icons.Default.Shield,
                text = "Stored securely, never shared, and deletable whenever you want."
            )

            Spacer(modifier = Modifier.height(24.dp))

            // Consent text
            Text(
                text = "By continuing, you agree to the collection and use of your voice for the purpose of creating a digital voice clone. Your recordings may be stored and processed.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        // Continue button
        Button(
            onClick = onContinue,
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp)
                .height(56.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Yellow),
            shape = RoundedCornerShape(12.dp)
        ) {
            Text(
                text = "Agree & Continue",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = Color.Black
            )
        }
    }
}

@Composable
private fun FeatureRow(icon: ImageVector, text: String) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.Top
    ) {
        Icon(
            icon,
            contentDescription = null,
            modifier = Modifier.size(28.dp)
        )
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge
        )
    }
}

@Composable
private fun ProfileStep(
    voiceName: String,
    onVoiceNameChange: (String) -> Unit,
    onContinue: () -> Unit
) {
    val canContinue = voiceName.trim().isNotEmpty()

    Column(modifier = Modifier.fillMaxSize()) {
        // Progress bar
        LinearProgressIndicator(
            progress = { 0.33f },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 60.dp)
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp)),
            color = Yellow,
            trackColor = MaterialTheme.colorScheme.surfaceVariant
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(24.dp)
        ) {
            Spacer(modifier = Modifier.height(24.dp))

            Text(
                text = "Create voice profile",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = "We need this data to create better results.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(modifier = Modifier.height(32.dp))

            // Profile image placeholder (simplified - no image picker for now)
            Box(
                modifier = Modifier.fillMaxWidth(),
                contentAlignment = Alignment.Center
            ) {
                Box(
                    modifier = Modifier
                        .size(140.dp)
                        .clip(RoundedCornerShape(20.dp))
                        .background(MaterialTheme.colorScheme.surfaceVariant),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        Icons.Default.Person,
                        contentDescription = null,
                        modifier = Modifier.size(64.dp),
                        tint = MaterialTheme.colorScheme.outlineVariant
                    )
                }
            }

            Spacer(modifier = Modifier.height(32.dp))

            // Voice name input
            OutlinedTextField(
                value = voiceName,
                onValueChange = onVoiceNameChange,
                label = { Text("Voice Name") },
                placeholder = { Text("Enter a name for your voice") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = RoundedCornerShape(12.dp)
            )
        }

        // Continue button
        Button(
            onClick = onContinue,
            modifier = Modifier
                .fillMaxWidth()
                .padding(24.dp)
                .height(56.dp),
            enabled = canContinue,
            colors = ButtonDefaults.buttonColors(
                containerColor = if (canContinue) Yellow else MaterialTheme.colorScheme.surfaceVariant,
                contentColor = if (canContinue) Color.Black else MaterialTheme.colorScheme.onSurfaceVariant
            ),
            shape = RoundedCornerShape(12.dp)
        ) {
            Text(
                text = "Continue",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

@Composable
private fun RecordingStep(
    isRecording: Boolean,
    isPaused: Boolean,
    recordingDuration: Int,
    hasRecording: Boolean,
    onStartRecording: () -> Unit,
    onPauseRecording: () -> Unit,
    onResumeRecording: () -> Unit,
    onStopRecording: () -> Unit,
    onSelectAudioFile: () -> Unit,
    onContinue: () -> Unit
) {
    // Get sample paragraphs for reading
    val sampleParagraphs = remember { VoiceCloningService.SAMPLE_PARAGRAPHS }

    // Calculate words for highlighting (reading speed: ~90 words per minute = 1.5 words per second)
    val wordsPerSecond = 1.5f
    val currentWordIndex = if (isRecording && !isPaused) {
        (recordingDuration * wordsPerSecond).toInt()
    } else if (hasRecording) {
        (recordingDuration * wordsPerSecond).toInt()
    } else {
        -1
    }

    val minimumDuration = 30
    val recommendedDuration = 60
    val canContinue = hasRecording && recordingDuration >= minimumDuration && !isRecording
    val isRecommendedDuration = recordingDuration >= recommendedDuration

    Column(modifier = Modifier.fillMaxSize()) {
        // Progress bar
        LinearProgressIndicator(
            progress = { 0.66f },
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 60.dp)
                .height(4.dp)
                .clip(RoundedCornerShape(2.dp)),
            color = Yellow,
            trackColor = MaterialTheme.colorScheme.surfaceVariant
        )

        Column(
            modifier = Modifier
                .weight(1f)
                .verticalScroll(rememberScrollState())
                .padding(24.dp)
        ) {
            Spacer(modifier = Modifier.height(24.dp))

            Text(
                text = "Record your voice",
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.Bold
            )

            Spacer(modifier = Modifier.height(16.dp))

            // Instructions banner
            Card(
                colors = CardDefaults.cardColors(containerColor = Yellow.copy(alpha = 0.2f)),
                shape = RoundedCornerShape(12.dp)
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Icon(
                        Icons.Default.Info,
                        contentDescription = null,
                        tint = Yellow,
                        modifier = Modifier.size(20.dp)
                    )
                    Text(
                        text = "Record at least 30 seconds (60+ recommended for best quality). Read naturally in any language you're comfortable with.",
                        style = MaterialTheme.typography.bodySmall
                    )
                }
            }

            Spacer(modifier = Modifier.height(24.dp))

            // Sample text with word highlighting
            HighlightedReadingText(
                paragraphs = sampleParagraphs,
                currentWordIndex = currentWordIndex
            )
        }

        // Recording controls
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally
        ) {
            // Timer
            Text(
                text = formatDuration(recordingDuration),
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Medium,
                color = if (isRecording && !isPaused) Red else MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Status text
            Text(
                text = when {
                    isRecording && !isPaused -> "Recording..."
                    isPaused -> "Recording paused"
                    else -> "Tap to start recording"
                },
                style = MaterialTheme.typography.bodySmall,
                color = when {
                    isPaused -> Yellow
                    else -> MaterialTheme.colorScheme.onSurfaceVariant
                }
            )

            Spacer(modifier = Modifier.height(16.dp))

            // Recording buttons
            Row(
                horizontalArrangement = Arrangement.spacedBy(24.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (isRecording) {
                    // Pause/Resume button
                    Button(
                        onClick = { if (isPaused) onResumeRecording() else onPauseRecording() },
                        modifier = Modifier.size(56.dp),
                        shape = CircleShape,
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (isPaused) Yellow else MaterialTheme.colorScheme.surfaceVariant
                        ),
                        contentPadding = PaddingValues(0.dp)
                    ) {
                        Icon(
                            if (isPaused) Icons.Default.PlayArrow else Icons.Default.Pause,
                            contentDescription = if (isPaused) "Resume" else "Pause",
                            tint = if (isPaused) Color.Black else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    // Stop button
                    Button(
                        onClick = onStopRecording,
                        modifier = Modifier.size(56.dp),
                        shape = CircleShape,
                        colors = ButtonDefaults.buttonColors(containerColor = Red),
                        contentPadding = PaddingValues(0.dp)
                    ) {
                        Icon(
                            Icons.Default.Stop,
                            contentDescription = "Stop",
                            tint = Color.White
                        )
                    }
                } else {
                    // Record button
                    Button(
                        onClick = onStartRecording,
                        modifier = Modifier.size(72.dp),
                        shape = CircleShape,
                        colors = ButtonDefaults.buttonColors(containerColor = Yellow),
                        contentPadding = PaddingValues(0.dp)
                    ) {
                        Icon(
                            Icons.Default.Mic,
                            contentDescription = "Record",
                            tint = Color.Black,
                            modifier = Modifier.size(32.dp)
                        )
                    }
                }
            }

            // Upload-an-existing-clip alternative path. Surfaced only when
            // we're not actively recording so the two options aren't
            // competing for attention mid-take. Screen-reader users
            // specifically can't use the live-recording path (a screen
            // reader speaks the prompt and the mic captures both voices),
            // so this is the supported way for them to clone.
            if (!isRecording) {
                Spacer(modifier = Modifier.height(20.dp))
                TextButton(
                    onClick = onSelectAudioFile,
                    modifier = Modifier.fillMaxWidth()
                ) {
                    Icon(
                        Icons.Default.UploadFile,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = if (hasRecording) "Replace with an audio file" else "Or upload an existing audio file",
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }

            // Continue button (when recording is done)
            if (canContinue) {
                Spacer(modifier = Modifier.height(16.dp))

                if (!isRecommendedDuration) {
                    Text(
                        text = "Longer recordings produce better voice clones",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Spacer(modifier = Modifier.height(8.dp))
                }

                Button(
                    onClick = onContinue,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = if (isRecommendedDuration) Yellow else MaterialTheme.colorScheme.outline
                    ),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Text(
                        text = if (isRecommendedDuration) "Continue" else "Continue Anyway",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = if (isRecommendedDuration) Color.Black else Color.White
                    )
                }
            }
        }
    }
}

@Composable
private fun ProcessingStep() {
    val infiniteTransition = rememberInfiniteTransition(label = "processing")
    val rotation by infiniteTransition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(
            animation = tween(3000, easing = LinearEasing),
            repeatMode = RepeatMode.Restart
        ),
        label = "rotation"
    )

    Column(
        modifier = Modifier.fillMaxSize(),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // Animated infinity symbol (using refresh icon as substitute)
        Text(
            text = "∞",
            fontSize = 80.sp,
            color = Yellow,
            modifier = Modifier.rotate(rotation)
        )

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "Cloning your voice...",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Medium
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "This may take a moment",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun SuccessStep(
    voiceName: String,
    onDone: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // Success icon
        Box(
            modifier = Modifier
                .size(100.dp)
                .clip(CircleShape)
                .background(Green.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                Icons.Default.CheckCircle,
                contentDescription = null,
                modifier = Modifier.size(60.dp),
                tint = Green
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "Voice Clone Created!",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "'$voiceName' is now ready to use.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(48.dp))

        Button(
            onClick = onDone,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Yellow),
            shape = RoundedCornerShape(12.dp)
        ) {
            Text(
                text = "Done",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = Color.Black
            )
        }
    }
}

@Composable
private fun ErrorStep(
    errorMessage: String,
    onRetry: () -> Unit,
    onCancel: () -> Unit
) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // Error icon
        Box(
            modifier = Modifier
                .size(100.dp)
                .clip(CircleShape)
                .background(Red.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                Icons.Default.Warning,
                contentDescription = null,
                modifier = Modifier.size(50.dp),
                tint = Red
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "Cloning Failed",
            style = MaterialTheme.typography.titleLarge,
            fontWeight = FontWeight.Bold
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = errorMessage,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(48.dp))

        Button(
            onClick = onRetry,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Yellow),
            shape = RoundedCornerShape(12.dp)
        ) {
            Text(
                text = "Try Again",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = Color.Black
            )
        }

        Spacer(modifier = Modifier.height(12.dp))

        TextButton(onClick = onCancel) {
            Text(
                text = "Cancel",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
        }
    }
}

private fun formatDuration(seconds: Int): String {
    val mins = seconds / 60
    val secs = seconds % 60
    return String.format("%d:%02d", mins, secs)
}

/**
 * Text display with word-by-word highlighting for reading guidance.
 * Highlights the current word and shows already-read words in a lighter highlight.
 */
@Composable
private fun HighlightedReadingText(
    paragraphs: List<String>,
    currentWordIndex: Int
) {
    // Calculate global word offset for each paragraph
    var globalOffset = 0

    Column(verticalArrangement = Arrangement.spacedBy(16.dp)) {
        paragraphs.forEach { paragraph ->
            val words = paragraph.split(Regex("\\s+")).filter { it.isNotEmpty() }
            val paragraphStartIndex = globalOffset

            Text(
                text = buildAnnotatedString {
                    words.forEachIndexed { localIndex, word ->
                        val globalIndex = paragraphStartIndex + localIndex
                        val isCurrentWord = globalIndex == currentWordIndex
                        val isAlreadyRead = globalIndex < currentWordIndex && currentWordIndex >= 0

                        when {
                            isCurrentWord -> {
                                // Current word - bright yellow highlight
                                withStyle(
                                    SpanStyle(
                                        background = Yellow,
                                        color = Color.Black
                                    )
                                ) {
                                    append(word)
                                }
                            }
                            isAlreadyRead -> {
                                // Already read words - lighter yellow
                                withStyle(
                                    SpanStyle(
                                        background = Yellow.copy(alpha = 0.3f),
                                        color = Color.Black
                                    )
                                ) {
                                    append(word)
                                }
                            }
                            else -> {
                                // Not yet read
                                append(word)
                            }
                        }

                        // Add space after word (except last)
                        if (localIndex < words.size - 1) {
                            append(" ")
                        }
                    }
                },
                style = MaterialTheme.typography.bodyLarge,
                lineHeight = 28.sp
            )

            globalOffset += words.size
        }
    }
}
