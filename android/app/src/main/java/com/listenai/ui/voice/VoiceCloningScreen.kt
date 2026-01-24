package com.listenai.ui.voice

import android.Manifest
import android.content.pm.PackageManager
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.widget.Toast
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.*
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import com.listenai.service.voice.VoiceCloningService
import com.listenai.ui.theme.Blue
import com.listenai.ui.theme.Green
import com.listenai.ui.theme.Red
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.koin.compose.koinInject
import java.io.File

/**
 * Screen for creating a cloned voice from audio recording or file upload
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceCloningScreen(
    onVoiceCreated: (voiceId: String, name: String) -> Unit,
    onNavigateBack: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val voiceCloningService: VoiceCloningService = koinInject()

    // State
    var voiceName by remember { mutableStateOf("") }
    var voiceDescription by remember { mutableStateOf("") }
    var exaggeration by remember { mutableFloatStateOf(0.5f) }
    var isRecording by remember { mutableStateOf(false) }
    var recordingDuration by remember { mutableIntStateOf(0) }
    var recordedFileUri by remember { mutableStateOf<Uri?>(null) }
    var isUploading by remember { mutableStateOf(false) }
    var errorMessage by remember { mutableStateOf<String?>(null) }
    var showSampleText by remember { mutableStateOf(false) }
    var sampleText by remember { mutableStateOf(voiceCloningService.getRandomSampleText()) }

    // Recording state
    var mediaRecorder by remember { mutableStateOf<MediaRecorder?>(null) }
    var recordingFile by remember { mutableStateOf<File?>(null) }

    // Permission state
    var hasRecordPermission by remember {
        mutableStateOf(
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        )
    }

    // File picker launcher
    val filePickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.GetContent()
    ) { uri ->
        uri?.let {
            recordedFileUri = it
        }
    }

    // Permission launcher
    val permissionLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.RequestPermission()
    ) { granted ->
        hasRecordPermission = granted
        if (!granted) {
            errorMessage = "Microphone permission is required to record your voice"
        }
    }

    // Recording timer
    LaunchedEffect(isRecording) {
        if (isRecording) {
            recordingDuration = 0
            while (isRecording) {
                delay(1000)
                recordingDuration++
            }
        }
    }

    // Start recording
    fun startRecording() {
        if (!hasRecordPermission) {
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
            return
        }

        try {
            val file = File(context.cacheDir, "voice_sample_${System.currentTimeMillis()}.m4a")
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
            errorMessage = null
        } catch (e: Exception) {
            errorMessage = "Failed to start recording: ${e.message}"
            android.util.Log.e("VoiceCloning", "Failed to start recording", e)
        }
    }

    // Stop recording
    fun stopRecording() {
        try {
            mediaRecorder?.apply {
                stop()
                release()
            }
            mediaRecorder = null
            isRecording = false

            recordingFile?.let { file ->
                if (file.exists() && file.length() > 0) {
                    recordedFileUri = Uri.fromFile(file)
                }
            }
        } catch (e: Exception) {
            errorMessage = "Failed to stop recording: ${e.message}"
            android.util.Log.e("VoiceCloning", "Failed to stop recording", e)
        }
    }

    // Create voice clone
    fun createVoiceClone() {
        val uri = recordedFileUri ?: return
        val name = voiceName.trim().ifEmpty { "My Voice" }

        scope.launch {
            isUploading = true
            errorMessage = null

            try {
                val result = voiceCloningService.createInstantClone(
                    name = name,
                    audioSampleUri = uri,
                    description = voiceDescription.trim().ifEmpty { null },
                    exaggeration = exaggeration.toDouble()
                )

                Toast.makeText(context, "Voice created successfully!", Toast.LENGTH_SHORT).show()
                onVoiceCreated(result.voiceId, result.name)
            } catch (e: VoiceCloningService.VoiceCloningError) {
                errorMessage = e.message
            } catch (e: Exception) {
                errorMessage = e.message ?: "Failed to create voice"
                android.util.Log.e("VoiceCloning", "Failed to create voice", e)
            } finally {
                isUploading = false
            }
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Clone Your Voice") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            // Info card
            Card(
                modifier = Modifier.fillMaxWidth(),
                colors = CardDefaults.cardColors(containerColor = Blue.copy(alpha = 0.1f))
            ) {
                Row(
                    modifier = Modifier.padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    Icon(
                        Icons.Default.Info,
                        contentDescription = null,
                        tint = Blue
                    )
                    Column {
                        Text(
                            text = "Create a personalized voice",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold
                        )
                        Spacer(modifier = Modifier.height(4.dp))
                        Text(
                            text = "Record at least 10 seconds of your voice reading the sample text clearly. Longer recordings (30-60 seconds) produce better results.",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // Voice name input
            OutlinedTextField(
                value = voiceName,
                onValueChange = { voiceName = it },
                label = { Text("Voice Name") },
                placeholder = { Text("e.g., My Voice") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true
            )

            // Sample text section
            Card(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { showSampleText = !showSampleText },
                colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant)
            ) {
                Column(modifier = Modifier.padding(16.dp)) {
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "Sample Text to Read",
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.SemiBold
                        )
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            IconButton(
                                onClick = { sampleText = voiceCloningService.getRandomSampleText() },
                                modifier = Modifier.size(32.dp)
                            ) {
                                Icon(
                                    Icons.Default.Refresh,
                                    contentDescription = "New text",
                                    modifier = Modifier.size(20.dp)
                                )
                            }
                            Icon(
                                if (showSampleText) Icons.Default.ExpandLess else Icons.Default.ExpandMore,
                                contentDescription = if (showSampleText) "Collapse" else "Expand"
                            )
                        }
                    }
                    if (showSampleText) {
                        Spacer(modifier = Modifier.height(12.dp))
                        Text(
                            text = sampleText,
                            style = MaterialTheme.typography.bodyMedium,
                            lineHeight = 24.sp
                        )
                    }
                }
            }

            // Recording section
            Card(
                modifier = Modifier.fillMaxWidth()
            ) {
                Column(
                    modifier = Modifier.padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    // Recording button
                    RecordingButton(
                        isRecording = isRecording,
                        duration = recordingDuration,
                        onClick = {
                            if (isRecording) {
                                stopRecording()
                            } else {
                                startRecording()
                            }
                        }
                    )

                    // Status text
                    Text(
                        text = when {
                            isRecording -> "Recording... Tap to stop"
                            recordedFileUri != null -> "Recording ready (${formatDuration(recordingDuration)})"
                            else -> "Tap to start recording"
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = if (isRecording) Red else MaterialTheme.colorScheme.onSurfaceVariant
                    )

                    // Or upload file
                    Row(
                        modifier = Modifier.fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        HorizontalDivider(modifier = Modifier.weight(1f))
                        Text(
                            text = "  or  ",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        HorizontalDivider(modifier = Modifier.weight(1f))
                    }

                    OutlinedButton(
                        onClick = { filePickerLauncher.launch("audio/*") }
                    ) {
                        Icon(Icons.Default.Upload, contentDescription = null)
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Upload Audio File")
                    }
                }
            }

            // Exaggeration slider
            Column {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = "Voice Expressiveness",
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = "${(exaggeration * 100).toInt()}%",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Blue
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                Slider(
                    value = exaggeration,
                    onValueChange = { exaggeration = it },
                    valueRange = 0f..1f,
                    colors = SliderDefaults.colors(
                        thumbColor = Blue,
                        activeTrackColor = Blue
                    )
                )
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    Text(
                        text = "Subtle",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = "Expressive",
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // Error message
            errorMessage?.let { error ->
                Card(
                    colors = CardDefaults.cardColors(containerColor = Red.copy(alpha = 0.1f))
                ) {
                    Row(
                        modifier = Modifier.padding(12.dp),
                        horizontalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(
                            Icons.Default.Error,
                            contentDescription = null,
                            tint = Red
                        )
                        Text(
                            text = error,
                            style = MaterialTheme.typography.bodySmall,
                            color = Red
                        )
                    }
                }
            }

            // Create button
            Button(
                onClick = { createVoiceClone() },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(56.dp),
                enabled = recordedFileUri != null && !isUploading && !isRecording,
                colors = ButtonDefaults.buttonColors(containerColor = Blue),
                shape = RoundedCornerShape(12.dp)
            ) {
                if (isUploading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(24.dp),
                        color = Color.White,
                        strokeWidth = 2.dp
                    )
                    Spacer(modifier = Modifier.width(12.dp))
                    Text("Creating Voice...")
                } else {
                    Icon(Icons.Default.RecordVoiceOver, contentDescription = null)
                    Spacer(modifier = Modifier.width(8.dp))
                    Text(
                        text = "Create Voice Clone",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }

            Spacer(modifier = Modifier.height(16.dp))
        }
    }
}

@Composable
private fun RecordingButton(
    isRecording: Boolean,
    duration: Int,
    onClick: () -> Unit
) {
    val infiniteTransition = rememberInfiniteTransition(label = "pulse")
    val scale by infiniteTransition.animateFloat(
        initialValue = 1f,
        targetValue = if (isRecording) 1.1f else 1f,
        animationSpec = infiniteRepeatable(
            animation = tween(500),
            repeatMode = RepeatMode.Reverse
        ),
        label = "pulse"
    )

    val backgroundColor by animateColorAsState(
        targetValue = if (isRecording) Red else Blue,
        animationSpec = tween(300),
        label = "color"
    )

    Box(
        modifier = Modifier
            .size(120.dp)
            .scale(if (isRecording) scale else 1f)
            .clip(CircleShape)
            .background(backgroundColor.copy(alpha = 0.15f))
            .border(4.dp, backgroundColor, CircleShape)
            .clickable(onClick = onClick),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center
        ) {
            Icon(
                imageVector = if (isRecording) Icons.Default.Stop else Icons.Default.Mic,
                contentDescription = if (isRecording) "Stop" else "Record",
                tint = backgroundColor,
                modifier = Modifier.size(40.dp)
            )
            if (isRecording) {
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    text = formatDuration(duration),
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                    color = Red
                )
            }
        }
    }
}

private fun formatDuration(seconds: Int): String {
    val mins = seconds / 60
    val secs = seconds % 60
    return String.format("%d:%02d", mins, secs)
}
