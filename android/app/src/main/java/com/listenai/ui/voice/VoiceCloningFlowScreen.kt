package com.listenai.ui.voice

import android.Manifest
import android.app.Activity
import android.content.ContextWrapper
import android.content.pm.PackageManager
import android.net.Uri
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
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.error
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.VisualTransformation
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.core.content.ContextCompat
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.lifecycle.viewmodel.viewModelFactory
import androidx.lifecycle.viewmodel.initializer
import com.listenai.service.review.AppReviewService
import com.listenai.service.voice.AudioClips
import com.listenai.service.voice.Recovery
import com.listenai.service.voice.VoiceCloningService
import com.listenai.ui.theme.Green
import com.listenai.ui.theme.Purple
import com.listenai.ui.theme.Red
import com.listenai.ui.theme.Yellow
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.koin.compose.koinInject
import java.util.Locale

private fun android.content.Context.findActivity(): Activity? {
    var c = this
    while (c is ContextWrapper) {
        if (c is Activity) return c
        c = c.baseContext
    }
    return null
}

/**
 * Consent-gated voice cloning flow:
 * Intro (sign in) -> Profile -> Say the phrase -> Reference recording -> Upload -> Done.
 * Server rules and error codes: docs/VOICE_CLONING_CONSENT.md.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoiceCloningFlowScreen(
    onComplete: () -> Unit,
    onCancel: () -> Unit
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val cloning: VoiceCloningService = koinInject()
    val appReviewService: AppReviewService = koinInject()
    val auth = cloning.authState

    val vm: VoiceCloneFlowViewModel = viewModel(
        factory = viewModelFactory {
            initializer {
                VoiceCloneFlowViewModel(
                    client = cloning.api,
                    initialSignedIn = auth?.isSignedIn?.value == true,
                    initialLanguage = VoiceCloneFlowViewModel.languageFor(Locale.getDefault().language),
                    onCreated = { cloning.invalidateCache() }
                )
            }
        }
    )
    val state by vm.state.collectAsState()

    // Keep the VM's sign-in flag in sync with the auth service.
    val signedIn by (auth?.isSignedIn ?: remember { kotlinx.coroutines.flow.MutableStateFlow(false) }).collectAsState()
    LaunchedEffect(signedIn) { vm.onSignedInChanged(signedIn) }

    // Recording
    val recorder = remember { ClipRecorder(context) }
    var recordingFor by remember { mutableStateOf<String?>(null) } // "consent" | "reference"
    var paused by remember { mutableStateOf(false) }
    var seconds by remember { mutableIntStateOf(0) }
    var pendingRecordTarget by remember { mutableStateOf<String?>(null) }

    fun beginRecording(target: String) {
        val err = recorder.start("voiceclone_$target")
        if (err != null) {
            vm.setClipHint(err)
        } else {
            recordingFor = target
            paused = false
            seconds = 0
            vm.setClipHint(null)
        }
    }

    // RECORD_AUDIO is the only runtime permission used. File selection goes through the system picker.
    val permissionLauncher = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val target = pendingRecordTarget
        pendingRecordTarget = null
        if (granted && target != null) beginRecording(target)
        else if (!granted) vm.setClipHint("Microphone permission is needed to record. You can allow it in system settings.")
    }

    fun startRecording(target: String) {
        val granted = ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED
        if (granted) beginRecording(target) else {
            pendingRecordTarget = target
            permissionLauncher.launch(Manifest.permission.RECORD_AUDIO)
        }
    }

    fun stopRecording() {
        val target = recordingFor ?: return
        val clip = recorder.stop()
        recordingFor = null
        paused = false
        if (clip == null) {
            vm.setClipHint("Nothing was recorded. Try again.")
        } else if (target == "consent") vm.setConsentClip(clip) else vm.setReferenceClip(clip)
    }

    // System document picker (no storage / media permission) for an existing reference recording.
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        val picked = AudioClips.fromUri(context, uri)
        if (picked.clip != null) vm.setReferenceClip(picked.clip) else vm.setClipHint(picked.error)
    }

    LaunchedEffect(recordingFor, paused) {
        while (recordingFor != null && !paused) {
            delay(1000)
            seconds++
        }
    }

    // Stop the mic if the user leaves the step mid-recording; drop recorded temp files on exit.
    LaunchedEffect(state.step) {
        if (recordingFor != null) {
            recorder.release()
            recordingFor = null
        }
        if (state.step == CloneStep.SUCCESS) {
            appReviewService.recordVoiceCloneSuccess()
            appReviewService.checkAndTriggerFeedbackPrompt()
        }
    }
    DisposableEffect(Unit) {
        onDispose {
            recorder.release()
            context.cacheDir.listFiles { f -> f.name.startsWith("voiceclone_") }?.forEach { it.delete() }
        }
    }

    Scaffold(
        topBar = {
            if (state.step != CloneStep.UPLOADING && state.step != CloneStep.SUCCESS) {
                // Compact header: the host already applies the status-bar inset, so a Material TopAppBar (its own inset + 64dp)
                // left a large empty band above the buttons.
                Row(
                    modifier = Modifier.fillMaxWidth().height(48.dp).padding(horizontal = 4.dp),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    IconButton(onClick = { if (!vm.back()) onCancel() }) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                    IconButton(onClick = onCancel) {
                        Icon(Icons.Default.Close, contentDescription = "Cancel")
                    }
                }
            }
        }
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when (state.step) {
                CloneStep.INTRO -> IntroStep(
                    signedIn = state.signedIn,
                    signingIn = state.signingIn,
                    signInError = if (state.failureSource == FailureSource.SIGN_IN) state.failure?.message else null,
                    notice = state.authNotice,
                    onSignInWithPassword = { email, password ->
                        if (auth != null) vm.signIn { auth.signInWithPassword(email, password) }
                    },
                    onCreateAccount = { email, password ->
                        if (auth != null) vm.signUp { auth.signUp(email, password) }
                    },
                    onForgotPassword = { email ->
                        if (auth != null) vm.sendPasswordReset(email) { auth.sendPasswordReset(email) }
                    },
                    onClearMessages = vm::clearAuthMessages,
                    onContinue = vm::agreeAndContinue
                )
                CloneStep.PROFILE -> ProfileStep(
                    name = state.name,
                    language = state.language,
                    canContinue = state.canContinueFromProfile,
                    onNameChange = vm::setName,
                    onLanguageChange = vm::setLanguage,
                    onContinue = vm::continueFromProfile
                )
                CloneStep.CONSENT -> ConsentStep(
                    state = state,
                    isRecording = recordingFor == "consent",
                    seconds = seconds,
                    onRecord = { startRecording("consent") },
                    onStop = { stopRecording() },
                    onRerecord = vm::clearConsentClip,
                    onContinue = vm::continueFromConsent,
                    onNewPhrase = vm::requestChallenge
                )
                CloneStep.REFERENCE -> ReferenceStep(
                    state = state,
                    isRecording = recordingFor == "reference",
                    isPaused = paused,
                    seconds = seconds,
                    onRecord = { startRecording("reference") },
                    onPause = { recorder.pause(); paused = true },
                    onResume = { recorder.resume(); paused = false },
                    onStop = { stopRecording() },
                    onPick = { filePicker.launch(arrayOf("audio/*")) },
                    onClear = vm::clearReferenceClip,
                    onSubmit = vm::submit
                )
                CloneStep.UPLOADING -> ProcessingStep()
                CloneStep.SUCCESS -> SuccessStep(
                    voiceName = state.created?.name ?: state.name,
                    onDone = onComplete
                )
                CloneStep.ERROR -> ErrorStep(
                    title = "Couldn't create your voice",
                    message = state.failure?.message ?: "Something went wrong.",
                    recovery = state.failure?.recovery ?: Recovery.RETRY,
                    primaryLabel = when (state.failure?.recovery) {
                        Recovery.SIGN_IN -> "Sign in"
                        Recovery.RERECORD_CONSENT -> "Record the phrase again"
                        Recovery.NEW_CHALLENGE -> "Get a new phrase"
                        Recovery.FIX_REFERENCE -> "Choose another recording"
                        else -> "Try again"
                    },
                    onPrimary = vm::recover,
                    onClose = onCancel
                )
            }
        }
    }
}

@Composable
internal fun LegacyVoicesDialog(onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Re-create your voices") },
        text = {
            Text(
                "Voices you cloned before this update can't be used any more. Cloned voices now require " +
                    "a quick consent check (you read a short phrase aloud), so please create them again."
            )
        },
        confirmButton = { TextButton(onClick = onDismiss) { Text("OK") } }
    )
}

// ---------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------

private val PrimaryShape = RoundedCornerShape(12.dp)

@Composable
private fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    Button(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.fillMaxWidth().height(56.dp),
        colors = ButtonDefaults.buttonColors(
            containerColor = Yellow,
            contentColor = Color.Black,
            disabledContainerColor = MaterialTheme.colorScheme.surfaceVariant,
            disabledContentColor = MaterialTheme.colorScheme.onSurfaceVariant
        ),
        shape = PrimaryShape
    ) {
        Text(text, style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold)
    }
}

@Composable
private fun StepProgress(fraction: Float) {
    LinearProgressIndicator(
        progress = { fraction },
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 60.dp)
            .height(4.dp)
            .clip(RoundedCornerShape(2.dp)),
        color = Yellow,
        trackColor = MaterialTheme.colorScheme.surfaceVariant
    )
}

@Composable
private fun InfoCard(text: String, icon: ImageVector = Icons.Default.Info, tint: Color = Yellow) {
    Card(
        colors = CardDefaults.cardColors(containerColor = tint.copy(alpha = 0.2f)),
        shape = PrimaryShape
    ) {
        Row(modifier = Modifier.padding(16.dp), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(20.dp))
            Text(text = text, style = MaterialTheme.typography.bodySmall)
        }
    }
}

@Composable
private fun IntroStep(
    signedIn: Boolean,
    signingIn: Boolean,
    signInError: String?,
    notice: String?,
    onSignInWithPassword: (String, String) -> Unit,
    onCreateAccount: (String, String) -> Unit,
    onForgotPassword: (String) -> Unit,
    onClearMessages: () -> Unit,
    onContinue: () -> Unit
) {
    var email by rememberSaveable { mutableStateOf("") }
    // Never saved into instance state: kept in memory only.
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var creating by rememberSaveable { mutableStateOf(false) }
    val emailOk = email.trim().contains("@") && email.trim().length >= 5
    val canSubmit = !signingIn && emailOk && password.isNotEmpty()
    val submit = {
        if (canSubmit) {
            if (creating) onCreateAccount(email.trim(), password) else onSignInWithPassword(email.trim(), password)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp)
        ) {
            Text(
                text = "Voice Cloning",
                style = MaterialTheme.typography.headlineLarge,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(24.dp))
            FeatureRow(Icons.Default.Mic, "Create a voice from your own recording and listen to your content in it.")
            Spacer(modifier = Modifier.height(20.dp))
            FeatureRow(Icons.Default.VerifiedUser, "To make sure it's your voice, you'll read a short phrase aloud, and we check it matches your recording. You can only clone your own voice.")
            Spacer(modifier = Modifier.height(20.dp))
            FeatureRow(Icons.Default.Shield, "Your recordings are not kept on this device or shared, and you can delete the voice at any time.")
            Spacer(modifier = Modifier.height(24.dp))
            Text(
                text = "By continuing, you confirm the voice is yours and you agree to the collection and processing of your voice recordings to create a synthetic voice. Audio generated with it carries an inaudible watermark.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = "Voice cloning needs a verified email and an active paid plan.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (!signedIn) {
                Spacer(modifier = Modifier.height(16.dp))
                InfoCard(
                    if (creating) "Create an account to make a cloned voice. It's tied to your account so only you can use it."
                    else "Sign in to create a cloned voice. It's tied to your account so only you can use it.",
                    Icons.Default.Lock
                )
                Spacer(modifier = Modifier.height(16.dp))
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text("Email") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    enabled = !signingIn,
                    shape = PrimaryShape,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Email, imeAction = ImeAction.Next, autoCorrect = false)
                )
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = password,
                    onValueChange = { password = it },
                    label = { Text("Password") },
                    modifier = Modifier.fillMaxWidth(),
                    singleLine = true,
                    enabled = !signingIn,
                    shape = PrimaryShape,
                    visualTransformation = if (showPassword) VisualTransformation.None else PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, imeAction = ImeAction.Done, autoCorrect = false),
                    keyboardActions = KeyboardActions(onDone = { submit() }),
                    trailingIcon = {
                        IconButton(onClick = { showPassword = !showPassword }) {
                            Icon(
                                if (showPassword) Icons.Default.VisibilityOff else Icons.Default.Visibility,
                                contentDescription = if (showPassword) "Hide password" else "Show password"
                            )
                        }
                    }
                )
                Spacer(modifier = Modifier.height(4.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(
                        onClick = { creating = !creating; onClearMessages() },
                        enabled = !signingIn
                    ) { Text(if (creating) "Have an account? Sign in" else "Create account") }
                    if (!creating) {
                        TextButton(
                            onClick = { onForgotPassword(email.trim()) },
                            enabled = !signingIn && emailOk
                        ) { Text("Forgot password?") }
                    }
                }
                if (!creating) {
                    Text(
                        text = "Enter your email above, then tap Forgot password? to get a reset link.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        // Outside the scrolling area on purpose: placed at the end of the scroll content this text sat
        // below the fold on phones and was never seen. liveRegion makes TalkBack announce changes.
        if (signInError != null) {
            Text(
                text = signInError,
                color = Red,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp, vertical = 8.dp)
                    .semantics { liveRegion = LiveRegionMode.Assertive; error(signInError) }
            )
        } else if (notice != null) {
            Text(
                text = notice,
                color = Green,
                style = MaterialTheme.typography.bodyMedium,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp, vertical = 8.dp)
                    .semantics { liveRegion = LiveRegionMode.Polite }
            )
        }

        Box(modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 24.dp, top = 8.dp)) {
            if (signedIn) {
                PrimaryButton("Agree & Continue", onContinue)
            } else {
                PrimaryButton(
                    when {
                        signingIn -> if (creating) "Creating account..." else "Signing in..."
                        creating -> "Create account"
                        else -> "Sign in"
                    },
                    { submit() },
                    enabled = canSubmit
                )
            }
        }
    }
}

@Composable
private fun FeatureRow(icon: ImageVector, text: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(16.dp), verticalAlignment = Alignment.Top) {
        Icon(icon, contentDescription = null, modifier = Modifier.size(28.dp))
        Text(text = text, style = MaterialTheme.typography.bodyLarge)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProfileStep(
    name: String,
    language: String,
    canContinue: Boolean,
    onNameChange: (String) -> Unit,
    onLanguageChange: (String) -> Unit,
    onContinue: () -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxSize()) {
        StepProgress(0.25f)
        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp)) {
            Spacer(modifier = Modifier.height(24.dp))
            Text("Name your voice", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                "Pick the language you'll speak in your recordings.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(32.dp))
            OutlinedTextField(
                value = name,
                onValueChange = onNameChange,
                label = { Text("Voice Name") },
                placeholder = { Text("Enter a name for your voice") },
                modifier = Modifier.fillMaxWidth(),
                singleLine = true,
                shape = PrimaryShape
            )
            Spacer(modifier = Modifier.height(16.dp))
            ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { expanded = it }) {
                OutlinedTextField(
                    value = languageName(language),
                    onValueChange = {},
                    readOnly = true,
                    label = { Text("Language") },
                    trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                    modifier = Modifier.fillMaxWidth().menuAnchor(),
                    shape = PrimaryShape
                )
                ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                    SUPPORTED_LANGUAGES.sortedBy { languageName(it) }.forEach { code ->
                        DropdownMenuItem(
                            text = { Text(languageName(code)) },
                            onClick = { onLanguageChange(code); expanded = false }
                        )
                    }
                }
            }
        }
        Box(modifier = Modifier.padding(24.dp)) { PrimaryButton("Continue", onContinue, enabled = canContinue) }
    }
}

private fun languageName(code: String): String =
    Locale(code).getDisplayLanguage(Locale.getDefault()).replaceFirstChar { it.titlecase() }.ifEmpty { code }

@Composable
private fun RecordButton(isRecording: Boolean, onRecord: () -> Unit, onStop: () -> Unit) {
    if (isRecording) {
        Button(
            onClick = onStop,
            modifier = Modifier.size(72.dp),
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(containerColor = Red),
            contentPadding = PaddingValues(0.dp)
        ) { Icon(Icons.Default.Stop, contentDescription = "Stop recording", tint = Color.White, modifier = Modifier.size(32.dp)) }
    } else {
        Button(
            onClick = onRecord,
            modifier = Modifier.size(72.dp),
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(containerColor = Yellow),
            contentPadding = PaddingValues(0.dp)
        ) { Icon(Icons.Default.Mic, contentDescription = "Start recording", tint = Color.Black, modifier = Modifier.size(32.dp)) }
    }
}

@Composable
private fun ConsentStep(
    state: CloneFlowState,
    isRecording: Boolean,
    seconds: Int,
    onRecord: () -> Unit,
    onStop: () -> Unit,
    onRerecord: () -> Unit,
    onContinue: () -> Unit,
    onNewPhrase: () -> Unit
) {
    // Live countdown to the phrase expiry.
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(state.challenge) {
        while (true) {
            now = System.currentTimeMillis()
            delay(1000)
        }
    }
    val challenge = state.challenge
    val expired = challenge?.isExpired(now) == true
    val remainingSec = challenge?.expiresAtMillis?.let { ((it - now) / 1000).toInt().coerceAtLeast(0) }

    Column(modifier = Modifier.fillMaxSize()) {
        StepProgress(0.5f)
        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp)) {
            Spacer(modifier = Modifier.height(24.dp))
            Text("Say the phrase", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                "Read this phrase aloud, exactly as written, in your own voice. This confirms the voice is yours.",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(24.dp))

            when {
                state.loadingChallenge || challenge == null -> Box(
                    modifier = Modifier.fillMaxWidth().height(120.dp),
                    contentAlignment = Alignment.Center
                ) { CircularProgressIndicator() }

                else -> Card(
                    colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.surfaceVariant),
                    shape = PrimaryShape
                ) {
                    Column(modifier = Modifier.padding(20.dp)) {
                        Text(
                            text = challenge.phrase,
                            style = MaterialTheme.typography.titleLarge,
                            fontWeight = FontWeight.Medium,
                            lineHeight = 32.sp
                        )
                        Spacer(modifier = Modifier.height(12.dp))
                        Text(
                            text = if (expired) "This phrase has expired." else remainingSec?.let { "Expires in ${formatDuration(it)}" } ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (expired || (remainingSec ?: 999) < 60) Red else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            state.attemptsLeft?.let {
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    if (it == 1) "1 attempt left for this phrase." else "$it attempts left for this phrase.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            state.clipHint?.let {
                Spacer(modifier = Modifier.height(12.dp))
                Text(it, color = Red, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(modifier = Modifier.height(16.dp))
            InfoCard("Record it live and in a quiet room. Uploading a file isn't allowed for this step. If you use a screen reader, listen to the phrase first, then pause the screen reader before you start recording.")
        }

        Column(modifier = Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (state.consentClip != null && !isRecording) {
                Text("Recorded ${state.consentClip.durationSec}s", style = MaterialTheme.typography.bodyMedium, color = Green)
                Spacer(modifier = Modifier.height(12.dp))
                PrimaryButton("Continue", onContinue, enabled = !expired)
                TextButton(onClick = onRerecord) { Text("Record again") }
            } else {
                Text(
                    formatDuration(seconds),
                    style = MaterialTheme.typography.titleLarge,
                    color = if (isRecording) Red else MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    if (isRecording) "Recording... tap stop when you've finished the phrase" else "Tap to start recording",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(16.dp))
                if (challenge != null && !expired) RecordButton(isRecording, onRecord, onStop)
            }
            if (expired) {
                Spacer(modifier = Modifier.height(8.dp))
                PrimaryButton("Get a new phrase", onNewPhrase)
            }
        }
    }
}

@Composable
private fun ReferenceStep(
    state: CloneFlowState,
    isRecording: Boolean,
    isPaused: Boolean,
    seconds: Int,
    onRecord: () -> Unit,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onStop: () -> Unit,
    onPick: () -> Unit,
    onClear: () -> Unit,
    onSubmit: () -> Unit
) {
    val clip = state.referenceClip
    val currentWordIndex = if (isRecording && !isPaused) (seconds * 1.5f).toInt() else if (clip != null) (clip.durationSec * 1.5f).toInt() else -1

    Column(modifier = Modifier.fillMaxSize()) {
        StepProgress(0.75f)
        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp)) {
            Spacer(modifier = Modifier.height(24.dp))
            Text("Record your voice", style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(16.dp))
            InfoCard("Record 30 to 60 seconds of natural speech (8 seconds minimum, 2 minutes maximum) in a quiet room, alone, with no music. Read the text below or speak freely in the language you chose. Or upload a clean recording of your voice.")
            state.clipHint?.let {
                Spacer(modifier = Modifier.height(12.dp))
                Text(it, color = Red, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(modifier = Modifier.height(24.dp))
            HighlightedReadingText(paragraphs = VoiceCloningService.SAMPLE_PARAGRAPHS, currentWordIndex = currentWordIndex)
        }

        Column(modifier = Modifier.padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (clip != null && !isRecording) {
                Text("${clip.filename.take(32)} (${formatDuration(clip.durationSec)})", style = MaterialTheme.typography.bodyMedium, color = Green)
                Spacer(modifier = Modifier.height(12.dp))
                PrimaryButton(
                    if (state.step == CloneStep.UPLOADING) "Uploading..." else "Create voice",
                    onSubmit,
                    enabled = state.canSubmit
                )
                TextButton(onClick = onClear) { Text("Choose a different recording") }
            } else {
                Text(formatDuration(seconds), style = MaterialTheme.typography.titleLarge, color = if (isRecording && !isPaused) Red else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    when {
                        isRecording && !isPaused -> "Recording..."
                        isPaused -> "Recording paused"
                        else -> "Tap to start recording"
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(16.dp))
                Row(horizontalArrangement = Arrangement.spacedBy(24.dp), verticalAlignment = Alignment.CenterVertically) {
                    if (isRecording) {
                        Button(
                            onClick = { if (isPaused) onResume() else onPause() },
                            modifier = Modifier.size(56.dp),
                            shape = CircleShape,
                            colors = ButtonDefaults.buttonColors(containerColor = if (isPaused) Yellow else MaterialTheme.colorScheme.surfaceVariant),
                            contentPadding = PaddingValues(0.dp)
                        ) {
                            Icon(
                                if (isPaused) Icons.Default.PlayArrow else Icons.Default.Pause,
                                contentDescription = if (isPaused) "Resume" else "Pause",
                                tint = if (isPaused) Color.Black else MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    RecordButton(isRecording, onRecord, onStop)
                }
                if (!isRecording) {
                    Spacer(modifier = Modifier.height(16.dp))
                    TextButton(onClick = onPick, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Default.UploadFile, contentDescription = null, modifier = Modifier.size(20.dp))
                        Spacer(modifier = Modifier.width(8.dp))
                        Text("Or upload an existing audio file")
                    }
                }
            }
        }
    }
}

@Composable
private fun ProcessingStep() {
    val transition = rememberInfiniteTransition(label = "processing")
    val rotation by transition.animateFloat(
        initialValue = 0f,
        targetValue = 360f,
        animationSpec = infiniteRepeatable(tween(3000, easing = LinearEasing), RepeatMode.Restart),
        label = "rotation"
    )
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text("∞", fontSize = 80.sp, color = Yellow, modifier = Modifier.rotate(rotation))
        Spacer(modifier = Modifier.height(24.dp))
        Text("Verifying and creating your voice...", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "We're checking your phrase and recording. This can take a minute, so please keep this screen open.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
    }
}

@Composable
private fun SuccessStep(voiceName: String, onDone: () -> Unit) {
    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(
            modifier = Modifier.size(100.dp).clip(CircleShape).background(Green.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) { Icon(Icons.Default.CheckCircle, contentDescription = null, modifier = Modifier.size(60.dp), tint = Green) }
        Spacer(modifier = Modifier.height(24.dp))
        Text("Voice Created!", style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            "'$voiceName' is ready. The first time you use it, it can take a couple of minutes to start up.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(48.dp))
        PrimaryButton("Done", onDone)
    }
}

@Composable
private fun ErrorStep(
    title: String,
    message: String,
    recovery: Recovery,
    primaryLabel: String,
    onPrimary: () -> Unit,
    onClose: () -> Unit
) {
    Column(
        modifier = Modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Box(
            modifier = Modifier.size(100.dp).clip(CircleShape).background(Red.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) { Icon(Icons.Default.Warning, contentDescription = null, modifier = Modifier.size(50.dp), tint = Red) }
        Spacer(modifier = Modifier.height(24.dp))
        Text(title, style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Spacer(modifier = Modifier.height(8.dp))
        Text(message, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Spacer(modifier = Modifier.height(48.dp))
        if (recovery != Recovery.STOP) {
            PrimaryButton(primaryLabel, onPrimary)
            Spacer(modifier = Modifier.height(12.dp))
            TextButton(onClick = onClose) { Text("Cancel", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold) }
        } else {
            PrimaryButton("Close", onClose)
        }
    }
}

private fun formatDuration(seconds: Int): String = String.format(Locale.US, "%d:%02d", seconds / 60, seconds % 60)

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
