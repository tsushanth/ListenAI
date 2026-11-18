package com.listenai.ui.voice

import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import com.listenai.R
import com.listenai.ui.common.UiText
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
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.semantics.Role
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
import com.kreativekoala.ratingkit.RatingKit
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
            vm.setClipHint(UiText.Raw(err))
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
        else if (!granted) vm.setClipHint(UiText.Res(R.string.vc_hint_mic_permission))
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
            vm.setClipHint(UiText.Res(R.string.vc_hint_nothing_recorded))
        } else if (target == "consent") vm.setConsentClip(clip) else vm.setReferenceClip(clip)
    }

    // System document picker (no storage / media permission) for an existing reference recording.
    val filePicker = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri: Uri? ->
        if (uri == null) return@rememberLauncherForActivityResult
        val picked = AudioClips.fromUri(context, uri)
        if (picked.clip != null) vm.setReferenceClip(picked.clip) else vm.setClipHint(picked.error?.let { UiText.Raw(it) })
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
            // Magic moment: the user's cloned voice is ready. RatingKit decides whether to ask.
            (context as? Activity)?.let { RatingKit.trackAction(it) }
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
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
                    IconButton(onClick = onCancel) {
                        Icon(Icons.Default.Close, contentDescription = stringResource(R.string.cancel))
                    }
                }
            }
        }
    ) { padding ->
        Box(modifier = Modifier.fillMaxSize().padding(padding)) {
            when (state.step) {
                CloneStep.INTRO -> IntroStep(onNext = vm::agreeAndContinue)
                CloneStep.SIGN_IN -> SignInStep(
                    signingIn = state.signingIn,
                    waitingForGoogle = state.waitingForGoogle,
                    onContinueWithGoogle = {
                        val activity = context.findActivity()
                        if (auth != null && activity != null) vm.signInWithGoogle { auth.signInWithGoogleBrowser(activity) }
                    },
                    onCancelGoogle = vm::cancelGoogleSignIn,
                    signInError = if (state.failureSource == FailureSource.SIGN_IN) state.failure?.text?.resolve(context) else null,
                    notice = state.authNotice?.resolve(context),
                    onSignInWithPassword = { email, password ->
                        if (auth != null) vm.signIn { auth.signInWithPassword(email, password) }
                    },
                    onCreateAccount = { email, password ->
                        if (auth != null) vm.signUp { auth.signUp(email, password) }
                    },
                    onForgotPassword = { email ->
                        if (auth != null) vm.sendPasswordReset(email) { auth.sendPasswordReset(email) }
                    },
                    onClearMessages = vm::clearAuthMessages
                )
                CloneStep.PROFILE -> ProfileStep(
                    name = state.name,
                    language = state.language,
                    canContinue = state.canContinueFromProfile,
                    showAttestation = !state.consentRequired && !state.configLoading,
                    attested = state.attested,
                    onAttestedChange = vm::setAttested,
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
                    title = stringResource(R.string.vcf_error_title),
                    message = state.failure?.text?.resolve(context) ?: stringResource(R.string.read_text_error_generic),
                    recovery = state.failure?.recovery ?: Recovery.RETRY,
                    primaryLabel = when (state.failure?.recovery) {
                        Recovery.SIGN_IN -> stringResource(R.string.vcf_sign_in)
                        Recovery.RERECORD_CONSENT -> stringResource(R.string.vcf_record_phrase_again)
                        Recovery.NEW_CHALLENGE -> stringResource(R.string.vcf_get_new_phrase)
                        Recovery.FIX_REFERENCE -> stringResource(R.string.vcf_choose_another_recording)
                        else -> stringResource(R.string.incoming_try_again)
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
        title = { Text(stringResource(R.string.vcf_legacy_title)) },
        text = { Text(stringResource(R.string.vcf_legacy_body)) },
        confirmButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.vcf_ok)) } }
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
private fun IntroStep(onNext: () -> Unit) {
    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp)
        ) {
            Text(
                text = stringResource(R.string.settings_voice_cloning),
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(16.dp))
            FeatureRow(Icons.Default.Mic, stringResource(R.string.vcf_intro_feature_record))
            Spacer(modifier = Modifier.height(12.dp))
            FeatureRow(Icons.Default.VerifiedUser, stringResource(R.string.vcf_intro_feature_confirm))
            Spacer(modifier = Modifier.height(12.dp))
            FeatureRow(Icons.Default.Shield, stringResource(R.string.vcf_intro_feature_privacy))
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = stringResource(R.string.vcf_intro_terms),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Box(modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 24.dp, top = 8.dp)) {
            PrimaryButton(stringResource(R.string.next), onNext)
        }
    }
}

@Composable
private fun SignInStep(
    signingIn: Boolean,
    waitingForGoogle: Boolean,
    onContinueWithGoogle: () -> Unit,
    onCancelGoogle: () -> Unit,
    signInError: String?,
    notice: String?,
    onSignInWithPassword: (String, String) -> Unit,
    onCreateAccount: (String, String) -> Unit,
    onForgotPassword: (String) -> Unit,
    onClearMessages: () -> Unit
) {
    var email by rememberSaveable { mutableStateOf("") }
    // Never saved into instance state: kept in memory only.
    var password by remember { mutableStateOf("") }
    var showPassword by remember { mutableStateOf(false) }
    var creating by rememberSaveable { mutableStateOf(false) }
    var showEmailForm by rememberSaveable { mutableStateOf(false) }
    val emailOk = email.trim().contains("@") && email.trim().length >= 5
    val canSubmit = !signingIn && emailOk && password.isNotEmpty()
    val submit = {
        if (canSubmit) {
            if (creating) onCreateAccount(email.trim(), password) else onSignInWithPassword(email.trim(), password)
        }
    }

    Column(modifier = Modifier.fillMaxSize()) {
        Column(
            modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(horizontal = 24.dp, vertical = 8.dp)
        ) {
            Text(
                text = stringResource(if (creating) R.string.vcf_create_account else R.string.vcf_sign_in),
                style = MaterialTheme.typography.headlineMedium,
                fontWeight = FontWeight.Bold
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(R.string.vcf_sign_in_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(20.dp))
            if (waitingForGoogle) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                    Text(
                        stringResource(R.string.vcf_waiting_google),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }
                    )
                }
                Spacer(modifier = Modifier.height(8.dp))
                OutlinedButton(onClick = onCancelGoogle, modifier = Modifier.fillMaxWidth(), shape = PrimaryShape) { Text(stringResource(R.string.cancel)) }
            } else {
                PrimaryButton(stringResource(R.string.vcf_continue_google), onContinueWithGoogle, enabled = !signingIn)
            }
            Spacer(modifier = Modifier.height(16.dp))
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                HorizontalDivider(modifier = Modifier.weight(1f))
                Text(stringResource(R.string.vcf_or), style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                HorizontalDivider(modifier = Modifier.weight(1f))
            }
            if (!showEmailForm) {
                TextButton(
                    onClick = { showEmailForm = true },
                    enabled = !signingIn,
                    modifier = Modifier.align(Alignment.CenterHorizontally)
                ) { Text(stringResource(R.string.vcf_use_email_password)) }
            } else {
                Spacer(modifier = Modifier.height(12.dp))
                OutlinedTextField(
                    value = email,
                    onValueChange = { email = it },
                    label = { Text(stringResource(R.string.import_mode_email)) },
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
                    label = { Text(stringResource(R.string.vcf_password)) },
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
                                contentDescription = stringResource(if (showPassword) R.string.vcf_hide_password else R.string.vcf_show_password)
                            )
                        }
                    }
                )
                Spacer(modifier = Modifier.height(4.dp))
                Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                    TextButton(
                        onClick = { creating = !creating; onClearMessages() },
                        enabled = !signingIn
                    ) { Text(stringResource(if (creating) R.string.vcf_have_account else R.string.vcf_create_account)) }
                    if (!creating) {
                        TextButton(
                            onClick = { onForgotPassword(email.trim()) },
                            enabled = !signingIn && emailOk
                        ) { Text(stringResource(R.string.vcf_forgot_password)) }
                    }
                }
                if (!creating) {
                    Text(
                        text = stringResource(R.string.vcf_forgot_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }

        // Outside the scrolling area on purpose so it is always visible. liveRegion makes TalkBack announce changes.
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

        if (showEmailForm) {
        Box(modifier = Modifier.padding(start = 24.dp, end = 24.dp, bottom = 24.dp, top = 8.dp)) {
                PrimaryButton(
                    when {
                        signingIn -> stringResource(if (creating) R.string.vcf_creating_account else R.string.vcf_signing_in)
                        creating -> stringResource(R.string.vcf_create_account)
                        else -> stringResource(R.string.vcf_sign_in)
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
        Icon(icon, contentDescription = null, modifier = Modifier.size(24.dp))
        Text(text = text, style = MaterialTheme.typography.bodyMedium)
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ProfileStep(
    name: String,
    language: String,
    canContinue: Boolean,
    showAttestation: Boolean,
    attested: Boolean,
    onAttestedChange: (Boolean) -> Unit,
    onNameChange: (String) -> Unit,
    onLanguageChange: (String) -> Unit,
    onContinue: () -> Unit
) {
    var expanded by remember { mutableStateOf(false) }
    Column(modifier = Modifier.fillMaxSize()) {
        StepProgress(0.25f)
        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp)) {
            Spacer(modifier = Modifier.height(24.dp))
            Text(stringResource(R.string.vcf_name_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                stringResource(R.string.vcf_name_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(32.dp))
            OutlinedTextField(
                value = name,
                onValueChange = onNameChange,
                label = { Text(stringResource(R.string.vcf_voice_name_label)) },
                placeholder = { Text(stringResource(R.string.vcf_voice_name_placeholder)) },
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
                    label = { Text(stringResource(R.string.language)) },
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
            if (showAttestation) {
                Spacer(modifier = Modifier.height(24.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .toggleable(value = attested, role = Role.Checkbox, onValueChange = onAttestedChange),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Checkbox(checked = attested, onCheckedChange = null)
                    Spacer(modifier = Modifier.width(12.dp))
                    Text(
                        stringResource(R.string.vcf_attestation),
                        style = MaterialTheme.typography.bodyMedium
                    )
                }
            }
        }
        Box(modifier = Modifier.padding(24.dp)) { PrimaryButton(stringResource(R.string.onboarding_continue), onContinue, enabled = canContinue) }
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
        ) { Icon(Icons.Default.Stop, contentDescription = stringResource(R.string.vcf_stop_recording), tint = Color.White, modifier = Modifier.size(32.dp)) }
    } else {
        Button(
            onClick = onRecord,
            modifier = Modifier.size(72.dp),
            shape = CircleShape,
            colors = ButtonDefaults.buttonColors(containerColor = Yellow),
            contentPadding = PaddingValues(0.dp)
        ) { Icon(Icons.Default.Mic, contentDescription = stringResource(R.string.vcf_start_recording), tint = Color.Black, modifier = Modifier.size(32.dp)) }
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
    val context = LocalContext.current
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
            Text(stringResource(R.string.vcf_phrase_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                stringResource(R.string.vcf_phrase_subtitle),
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
                            text = if (expired) stringResource(R.string.vcf_phrase_expired) else remainingSec?.let { stringResource(R.string.vcf_phrase_expires_in, formatDuration(it)) } ?: "",
                            style = MaterialTheme.typography.bodySmall,
                            color = if (expired || (remainingSec ?: 999) < 60) Red else MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            state.attemptsLeft?.let {
                Spacer(modifier = Modifier.height(12.dp))
                Text(
                    pluralStringResource(R.plurals.vcf_attempts_left, it, it),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            state.clipHint?.let {
                Spacer(modifier = Modifier.height(12.dp))
                Text(it.resolve(context), color = Red, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(modifier = Modifier.height(16.dp))
            InfoCard(stringResource(R.string.vcf_phrase_info))
        }

        Column(modifier = Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (state.consentClip != null && !isRecording) {
                Text(stringResource(R.string.vcf_recorded_seconds, state.consentClip.durationSec), style = MaterialTheme.typography.bodyMedium, color = Green)
                Spacer(modifier = Modifier.height(12.dp))
                PrimaryButton(stringResource(R.string.onboarding_continue), onContinue, enabled = !expired)
                TextButton(onClick = onRerecord) { Text(stringResource(R.string.vcf_record_again)) }
            } else {
                Text(
                    formatDuration(seconds),
                    style = MaterialTheme.typography.titleLarge,
                    color = if (isRecording) Red else MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    stringResource(if (isRecording) R.string.vcf_recording_phrase_hint else R.string.vcf_tap_to_record),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(16.dp))
                if (challenge != null && !expired) RecordButton(isRecording, onRecord, onStop)
            }
            if (expired) {
                Spacer(modifier = Modifier.height(8.dp))
                PrimaryButton(stringResource(R.string.vcf_get_new_phrase), onNewPhrase)
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
    val context = LocalContext.current
    val clip = state.referenceClip
    val currentWordIndex = if (isRecording && !isPaused) (seconds * 1.5f).toInt() else if (clip != null) (clip.durationSec * 1.5f).toInt() else -1

    Column(modifier = Modifier.fillMaxSize()) {
        StepProgress(0.75f)
        Column(modifier = Modifier.weight(1f).verticalScroll(rememberScrollState()).padding(24.dp)) {
            Spacer(modifier = Modifier.height(24.dp))
            Text(stringResource(R.string.vcf_reference_title), style = MaterialTheme.typography.headlineSmall, fontWeight = FontWeight.Bold)
            Spacer(modifier = Modifier.height(16.dp))
            InfoCard(stringResource(R.string.vcf_reference_info))
            state.clipHint?.let {
                Spacer(modifier = Modifier.height(12.dp))
                Text(it.resolve(context), color = Red, style = MaterialTheme.typography.bodySmall)
            }
            Spacer(modifier = Modifier.height(24.dp))
            HighlightedReadingText(paragraphs = VoiceCloningService.SAMPLE_PARAGRAPHS, currentWordIndex = currentWordIndex)
        }

        Column(modifier = Modifier.fillMaxWidth().padding(24.dp), horizontalAlignment = Alignment.CenterHorizontally) {
            if (clip != null && !isRecording) {
                Text("${clip.filename.take(32)} (${formatDuration(clip.durationSec)})", style = MaterialTheme.typography.bodyMedium, color = Green)
                Spacer(modifier = Modifier.height(12.dp))
                PrimaryButton(
                    stringResource(if (state.step == CloneStep.UPLOADING) R.string.vcf_uploading else R.string.vcf_create_voice),
                    onSubmit,
                    enabled = state.canSubmit
                )
                TextButton(onClick = onClear) { Text(stringResource(R.string.vcf_choose_different_recording)) }
            } else {
                Text(formatDuration(seconds), style = MaterialTheme.typography.titleLarge, color = if (isRecording && !isPaused) Red else MaterialTheme.colorScheme.onSurfaceVariant)
                Spacer(modifier = Modifier.height(4.dp))
                Text(
                    when {
                        isRecording && !isPaused -> stringResource(R.string.vcf_recording)
                        isPaused -> stringResource(R.string.vcf_recording_paused)
                        else -> stringResource(R.string.vcf_tap_to_record)
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
                                contentDescription = stringResource(if (isPaused) R.string.vcf_resume else R.string.pause),
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
                        Text(stringResource(R.string.vcf_upload_existing))
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
        Text(stringResource(R.string.vcf_processing_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Medium, textAlign = TextAlign.Center)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            stringResource(R.string.vcf_processing_body),
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
        Text(stringResource(R.string.vcf_success_title), style = MaterialTheme.typography.titleLarge, fontWeight = FontWeight.Bold)
        Spacer(modifier = Modifier.height(8.dp))
        Text(
            stringResource(R.string.vcf_success_body, voiceName),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center
        )
        Spacer(modifier = Modifier.height(48.dp))
        PrimaryButton(stringResource(R.string.done), onDone)
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
            TextButton(onClick = onClose) { Text(stringResource(R.string.cancel), style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.SemiBold) }
        } else {
            PrimaryButton(stringResource(R.string.close), onClose)
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
