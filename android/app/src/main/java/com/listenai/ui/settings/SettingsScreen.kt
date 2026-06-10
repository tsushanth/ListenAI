package com.listenai.ui.settings

import android.content.Intent
import android.net.Uri
import androidx.appcompat.app.AppCompatDelegate
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.core.os.LocaleListCompat
import com.listenai.R
import com.listenai.service.billing.RevenueCatManager
import com.listenai.service.settings.SettingsManager
import com.listenai.service.tts.KokoroModelDownloader
import com.listenai.service.tts.KokoroOnDeviceService
import com.listenai.ui.theme.*
import com.kreativekoala.paywallkit.models.PaywallFeature
import com.kreativekoala.paywallkit.models.PaywallTheme
import com.kreativekoala.paywallkit.view.PaywallPreview
import org.koin.compose.koinInject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onNavigateToVoices: () -> Unit = {},
    onNavigateToUsage: () -> Unit = {},
    onNavigateToVoiceCloning: () -> Unit = {},
    onNavigateToMarketplace: () -> Unit = {},
    onNavigateToSubscription: () -> Unit = {},
    settingsManager: SettingsManager = koinInject()
) {
    val context = LocalContext.current
    val scrollState = rememberScrollState()

    // Dialog states
    var showSpeedDialog by remember { mutableStateOf(false) }
    var showAppearanceDialog by remember { mutableStateOf(false) }
    var showSkipIntervalDialog by remember { mutableStateOf(false) }
    var showSleepTimerDialog by remember { mutableStateOf(false) }
    var showLanguageDialog by remember { mutableStateOf(false) }
    var tapCount by remember { mutableIntStateOf(0) }
    var showPaywallPreview by remember { mutableStateOf(false) }

    // Settings state from SettingsManager (persisted)
    val playbackSpeed by settingsManager.playbackSpeed.collectAsState()
    val appearanceMode by settingsManager.appearanceMode.collectAsState()
    val skipInterval by settingsManager.skipInterval.collectAsState()
    val sleepTimerDefault by settingsManager.sleepTimerDefault.collectAsState()

    // Offline AI (on-device Kokoro) state
    val useOfflineKokoro by settingsManager.useOfflineKokoro.collectAsState()
    val allowCellularDownload by settingsManager.allowCellularModelDownload.collectAsState()
    val kokoroDownloader = remember { KokoroModelDownloader.getInstance(context) }
    val kokoroState by kokoroDownloader.state.collectAsState()
    val isOnDeviceEligible = remember { KokoroOnDeviceService.isDeviceEligible(context) }

    // Subscription state
    val revenueCatManager = remember { RevenueCatManager.getInstance() }
    val isPremium by revenueCatManager.isPremium.collectAsState()

    // Language picker state
    val languages = remember {
        listOf(
            "en" to R.string.language_english,
            "es" to R.string.language_spanish,
            "fr" to R.string.language_french,
            "de" to R.string.language_german,
            "ja" to R.string.language_japanese,
            "zh-CN" to R.string.language_chinese,
            "ko" to R.string.language_korean,
            "pt-BR" to R.string.language_portuguese,
            "it" to R.string.language_italian,
            "hi" to R.string.language_hindi
        )
    }
    val currentLocaleTag = AppCompatDelegate.getApplicationLocales().toLanguageTags().ifEmpty { "en" }
    val currentLanguageRes = languages.firstOrNull { it.first == currentLocaleTag }?.second ?: R.string.language_english

    // Localized share strings (resolved here so they can be used in Intent)
    val shareSubject = stringResource(R.string.share_subject)
    val shareBody = stringResource(R.string.share_body)
    val shareChooserTitle = stringResource(R.string.share_chooser_title)
    val feedbackEmailSubject = stringResource(R.string.feedback_email_subject)

    if (showPaywallPreview) {
        PaywallPreview(
            appId = "readaloudai",
            appName = "ReadAloud AI",
            features = listOf(
                PaywallFeature("\uD83D\uDD0A", "Unlimited Listening"),
                PaywallFeature("\uD83C\uDFA4", "Premium Voices"),
                PaywallFeature("\uD83D\uDCC4", "Any Document"),
                PaywallFeature("⚡", "Speed Controls"),
                PaywallFeature("\uD83D\uDCE5", "Offline Mode")
            ),
            theme = PaywallTheme(accent = Color(0xFF6C63FF), accent2 = Color(0xFF9C27B0)),
            onDone = { showPaywallPreview = false }
        )
        return
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.settings_title),
                        fontWeight = FontWeight.Bold
                    )
                },
                actions = {
                    ProBadge()
                }
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(scrollState)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            // Subscription Section
            if (!isPremium) {
                SettingsSection(title = stringResource(R.string.settings_subscription)) {
                    SettingsRow(
                        icon = Icons.Default.WorkspacePremium,
                        iconColor = Purple,
                        title = stringResource(R.string.settings_upgrade_to_pro),
                        subtitle = stringResource(R.string.settings_upgrade_to_pro_subtitle),
                        onClick = onNavigateToSubscription
                    )
                }
            } else {
                SettingsSection(title = stringResource(R.string.settings_subscription)) {
                    SettingsRow(
                        icon = Icons.Default.WorkspacePremium,
                        iconColor = Green,
                        title = stringResource(R.string.settings_readaloud_pro),
                        subtitle = stringResource(R.string.settings_pro_member_subtitle),
                        onClick = onNavigateToSubscription
                    )
                }
            }

            // Preferences Section
            SettingsSection(title = stringResource(R.string.settings_preferences)) {
                SettingsRow(
                    icon = Icons.Default.RecordVoiceOver,
                    iconColor = Blue,
                    title = stringResource(R.string.settings_voice),
                    subtitle = stringResource(R.string.settings_voice_subtitle),
                    onClick = onNavigateToVoices
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Mic,
                    iconColor = Purple,
                    title = stringResource(R.string.settings_voice_cloning),
                    subtitle = stringResource(R.string.settings_voice_cloning_subtitle),
                    onClick = onNavigateToVoiceCloning
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Store,
                    iconColor = Green,
                    title = stringResource(R.string.settings_voice_marketplace),
                    subtitle = stringResource(R.string.settings_voice_marketplace_subtitle),
                    onClick = onNavigateToMarketplace
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                OfflineAIRow(
                    eligible = isOnDeviceEligible,
                    enabled = useOfflineKokoro,
                    state = kokoroState,
                    allowCellularDownload = allowCellularDownload,
                    onToggle = { newValue ->
                        settingsManager.setUseOfflineKokoro(newValue)
                        if (newValue && isOnDeviceEligible) {
                            kokoroDownloader.startIfPossible()
                        } else {
                            kokoroDownloader.cancel()
                        }
                    },
                    onToggleCellular = { newValue ->
                        settingsManager.setAllowCellularModelDownload(newValue)
                        if (useOfflineKokoro && isOnDeviceEligible) {
                            kokoroDownloader.startIfPossible()
                        }
                    }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Speed,
                    iconColor = Orange,
                    title = stringResource(R.string.settings_speed),
                    subtitle = "${playbackSpeed}x",
                    onClick = { showSpeedDialog = true }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.DarkMode,
                    iconColor = Purple,
                    title = stringResource(R.string.settings_appearance),
                    subtitle = appearanceMode,
                    onClick = { showAppearanceDialog = true }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Language,
                    iconColor = Blue,
                    title = stringResource(R.string.language),
                    subtitle = stringResource(currentLanguageRes),
                    onClick = { showLanguageDialog = true }
                )
            }

            // Linked Accounts Section
            SettingsSection(title = stringResource(R.string.settings_linked_accounts)) {
                GoogleConnectRow()
            }

            // Share Section
            SettingsSection(title = stringResource(R.string.settings_share)) {
                SettingsRow(
                    icon = Icons.Default.Share,
                    iconColor = Green,
                    title = stringResource(R.string.settings_share_app),
                    subtitle = stringResource(R.string.settings_share_app_subtitle),
                    onClick = {
                        val shareIntent = Intent(Intent.ACTION_SEND).apply {
                            type = "text/plain"
                            putExtra(Intent.EXTRA_SUBJECT, shareSubject)
                            putExtra(Intent.EXTRA_TEXT, shareBody)
                        }
                        context.startActivity(Intent.createChooser(shareIntent, shareChooserTitle))
                    }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Star,
                    iconColor = Orange,
                    title = stringResource(R.string.settings_rate_app),
                    subtitle = stringResource(R.string.settings_rate_app_subtitle),
                    onClick = {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("market://details?id=com.listenai"))
                        try {
                            context.startActivity(intent)
                        } catch (e: Exception) {
                            // Play Store not available, open in browser
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/store/apps/details?id=com.listenai")))
                        }
                    }
                )
            }

            // Playback Section
            SettingsSection(title = stringResource(R.string.settings_playback)) {
                SettingsRow(
                    icon = Icons.Default.Headphones,
                    iconColor = Blue,
                    title = stringResource(R.string.settings_audio_quality),
                    subtitle = stringResource(R.string.settings_audio_quality_hd),
                    onClick = { /* Audio quality is always HD with self-hosted TTS */ }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.SkipNext,
                    iconColor = Purple,
                    title = stringResource(R.string.settings_skip_interval),
                    subtitle = stringResource(R.string.seconds_format, skipInterval),
                    onClick = { showSkipIntervalDialog = true }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Timer,
                    iconColor = Green,
                    title = stringResource(R.string.settings_sleep_timer),
                    subtitle = if (sleepTimerDefault == 0) stringResource(R.string.sleep_timer_off) else stringResource(R.string.sleep_timer_minutes_format, sleepTimerDefault),
                    onClick = { showSleepTimerDialog = true }
                )
            }

            // Support Section
            SettingsSection(title = stringResource(R.string.settings_support)) {
                SettingsRow(
                    icon = Icons.Default.DataUsage,
                    iconColor = Blue,
                    title = stringResource(R.string.settings_usage),
                    subtitle = stringResource(R.string.settings_usage_subtitle),
                    onClick = onNavigateToUsage
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Feedback,
                    iconColor = Purple,
                    title = stringResource(R.string.settings_feedback),
                    subtitle = stringResource(R.string.settings_feedback_subtitle),
                    onClick = {
                        val intent = Intent(Intent.ACTION_SENDTO).apply {
                            data = Uri.parse("mailto:support@kreativekoala.llc")
                            putExtra(Intent.EXTRA_SUBJECT, feedbackEmailSubject)
                        }
                        context.startActivity(intent)
                    }
                )
            }

            // About Section
            SettingsSection(title = stringResource(R.string.settings_about)) {
                SettingsRow(
                    icon = Icons.Default.Info,
                    iconColor = Blue,
                    title = stringResource(R.string.settings_version),
                    subtitle = "1.0.0",
                    onClick = { tapCount++ }
                )

                if (tapCount >= 5) {
                    Button(
                        onClick = { showPaywallPreview = true },
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = 16.dp, vertical = 8.dp)
                    ) {
                        Text("Preview Paywalls")
                    }
                }

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Policy,
                    iconColor = Green,
                    title = stringResource(R.string.settings_privacy),
                    subtitle = stringResource(R.string.settings_privacy_subtitle),
                    onClick = {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://kreativekoala.llc/privacy"))
                        context.startActivity(intent)
                    }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Description,
                    iconColor = Orange,
                    title = stringResource(R.string.settings_terms),
                    subtitle = stringResource(R.string.settings_terms_subtitle),
                    onClick = {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://kreativekoala.llc/terms"))
                        context.startActivity(intent)
                    }
                )
            }

            Spacer(modifier = Modifier.height(32.dp))
        }

        // Playback Speed Dialog
        if (showSpeedDialog) {
            SpeedSelectionDialog(
                currentSpeed = playbackSpeed,
                onSpeedSelected = { speed ->
                    settingsManager.setPlaybackSpeed(speed)
                    showSpeedDialog = false
                },
                onDismiss = { showSpeedDialog = false }
            )
        }

        // Appearance Dialog
        if (showAppearanceDialog) {
            AppearanceSelectionDialog(
                currentMode = appearanceMode,
                onModeSelected = { mode ->
                    settingsManager.setAppearanceMode(mode)
                    showAppearanceDialog = false
                },
                onDismiss = { showAppearanceDialog = false }
            )
        }

        // Skip Interval Dialog
        if (showSkipIntervalDialog) {
            SkipIntervalSelectionDialog(
                currentInterval = skipInterval,
                onIntervalSelected = { interval ->
                    settingsManager.setSkipInterval(interval)
                    showSkipIntervalDialog = false
                },
                onDismiss = { showSkipIntervalDialog = false }
            )
        }

        // Sleep Timer Default Dialog
        if (showSleepTimerDialog) {
            SleepTimerSelectionDialog(
                currentMinutes = sleepTimerDefault,
                onMinutesSelected = { minutes ->
                    settingsManager.setSleepTimerDefault(minutes)
                    showSleepTimerDialog = false
                },
                onDismiss = { showSleepTimerDialog = false }
            )
        }

        // Language Picker Dialog
        if (showLanguageDialog) {
            AlertDialog(
                onDismissRequest = { showLanguageDialog = false },
                title = { Text(stringResource(R.string.language_picker_title)) },
                text = {
                    Column {
                        languages.forEach { (code, nameRes) ->
                            Row(
                                modifier = Modifier
                                    .fillMaxWidth()
                                    .padding(vertical = 4.dp),
                                verticalAlignment = Alignment.CenterVertically
                            ) {
                                RadioButton(
                                    selected = currentLocaleTag == code,
                                    onClick = {
                                        AppCompatDelegate.setApplicationLocales(LocaleListCompat.forLanguageTags(code))
                                        showLanguageDialog = false
                                    }
                                )
                                Spacer(modifier = Modifier.width(8.dp))
                                Text(stringResource(nameRes), style = MaterialTheme.typography.bodyLarge)
                            }
                        }
                    }
                },
                confirmButton = {
                    TextButton(onClick = { showLanguageDialog = false }) {
                        Text(stringResource(R.string.cancel))
                    }
                }
            )
        }
    }
}

@Composable
private fun SpeedSelectionDialog(
    currentSpeed: Float,
    onSpeedSelected: (Float) -> Unit,
    onDismiss: () -> Unit
) {
    val speeds = listOf(0.5f, 0.75f, 1.0f, 1.25f, 1.5f, 1.75f, 2.0f)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.dialog_playback_speed)) },
        text = {
            Column {
                speeds.forEach { speed ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onSpeedSelected(speed) }
                            .padding(vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = "${speed}x",
                            style = MaterialTheme.typography.bodyLarge
                        )
                        if (speed == currentSpeed) {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = stringResource(R.string.selected_check),
                                tint = Blue
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        }
    )
}

@Composable
private fun AppearanceSelectionDialog(
    currentMode: String,
    onModeSelected: (String) -> Unit,
    onDismiss: () -> Unit
) {
    val modes = listOf("System", "Light", "Dark")

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.dialog_appearance)) },
        text = {
            Column {
                modes.forEach { mode ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onModeSelected(mode) }
                            .padding(vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(12.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                when (mode) {
                                    "Light" -> Icons.Default.LightMode
                                    "Dark" -> Icons.Default.DarkMode
                                    else -> Icons.Default.BrightnessAuto
                                },
                                contentDescription = null,
                                tint = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Text(
                                text = mode,
                                style = MaterialTheme.typography.bodyLarge
                            )
                        }
                        if (mode == currentMode) {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = stringResource(R.string.selected_check),
                                tint = Blue
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        }
    )
}

@Composable
private fun SkipIntervalSelectionDialog(
    currentInterval: Int,
    onIntervalSelected: (Int) -> Unit,
    onDismiss: () -> Unit
) {
    val intervals = listOf(5, 10, 15, 30, 60)

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.dialog_skip_interval)) },
        text = {
            Column {
                intervals.forEach { interval ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onIntervalSelected(interval) }
                            .padding(vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = stringResource(R.string.seconds_format, interval),
                            style = MaterialTheme.typography.bodyLarge
                        )
                        if (interval == currentInterval) {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = stringResource(R.string.selected_check),
                                tint = Blue
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        }
    )
}

@Composable
private fun SleepTimerSelectionDialog(
    currentMinutes: Int,
    onMinutesSelected: (Int) -> Unit,
    onDismiss: () -> Unit
) {
    val options = listOf(
        0 to R.string.sleep_timer_off,
        15 to R.string.sleep_timer_15_min,
        30 to R.string.sleep_timer_30_min,
        45 to R.string.sleep_timer_45_min,
        60 to R.string.sleep_timer_1_hour
    )

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.dialog_sleep_timer_default)) },
        text = {
            Column {
                options.forEach { (minutes, labelRes) ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onMinutesSelected(minutes) }
                            .padding(vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = stringResource(labelRes),
                            style = MaterialTheme.typography.bodyLarge
                        )
                        if (minutes == currentMinutes) {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = stringResource(R.string.selected_check),
                                tint = Blue
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        }
    )
}

@Composable
private fun ProBadge() {
    Surface(
        shape = CircleShape,
        color = Green.copy(alpha = 0.9f)
    ) {
        Text(
            text = stringResource(R.string.pro),
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 6.dp),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = Color.White
        )
    }
}

@Composable
private fun SettingsSection(
    title: String,
    content: @Composable ColumnScope.() -> Unit
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Text(
            text = title,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.SemiBold,
            modifier = Modifier.padding(horizontal = 4.dp)
        )

        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(12.dp),
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant
            )
        ) {
            Column {
                content()
            }
        }
    }
}

/**
 * Settings row for the on-device Kokoro (Offline AI) toggle. Mirrors the
 * iOS `offlineAIRow` shape:
 *   - Always-visible icon + title + status subtitle + toggle
 *   - Toggle disabled when the device isn't eligible
 *   - Progress bar + percent label while the model is downloading
 *   - "Waiting for Wi-Fi" hint when WorkManager is gating the download
 *   - Inline error message under the toggle when the last download failed
 *   - "Allow cellular download" sub-toggle, hidden once the model is on disk
 */
@Composable
private fun OfflineAIRow(
    eligible: Boolean,
    enabled: Boolean,
    state: KokoroModelDownloader.State,
    allowCellularDownload: Boolean,
    onToggle: (Boolean) -> Unit,
    onToggleCellular: (Boolean) -> Unit
) {
    val subtitleRes = when {
        !eligible -> R.string.settings_offline_ai_subtitle_ineligible
        state is KokoroModelDownloader.State.Ready -> R.string.settings_offline_ai_subtitle_ready
        else -> R.string.settings_offline_ai_subtitle_not_ready
    }

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp)
    ) {
        Row(
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Box(
                modifier = Modifier
                    .size(36.dp)
                    .clip(RoundedCornerShape(8.dp))
                    .background(Teal.copy(alpha = 0.15f)),
                contentAlignment = Alignment.Center
            ) {
                Icon(
                    imageVector = Icons.Default.PhoneAndroid,
                    contentDescription = null,
                    tint = Teal,
                    modifier = Modifier.size(20.dp)
                )
            }
            Column(
                modifier = Modifier.weight(1f),
                verticalArrangement = Arrangement.spacedBy(2.dp)
            ) {
                Text(
                    text = stringResource(R.string.settings_offline_ai),
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.Medium
                )
                Text(
                    text = stringResource(subtitleRes),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Switch(
                checked = enabled && eligible,
                onCheckedChange = onToggle,
                enabled = eligible
            )
        }

        if (enabled && eligible && state is KokoroModelDownloader.State.Downloading) {
            Column(
                modifier = Modifier.padding(start = 48.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    LinearProgressIndicator(
                        progress = { state.percent / 100f },
                        modifier = Modifier.weight(1f)
                    )
                    Text(
                        text = "${state.percent}%",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Text(
                    text = stringResource(R.string.settings_offline_ai_downloading),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }

        if (enabled && eligible && state is KokoroModelDownloader.State.WaitingForWifi) {
            Text(
                text = stringResource(R.string.settings_offline_ai_waiting_wifi),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(start = 48.dp)
            )
        }

        if (enabled && eligible && state is KokoroModelDownloader.State.Failed) {
            Text(
                text = state.message,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.error,
                modifier = Modifier.padding(start = 48.dp)
            )
        }

        // Cellular policy sub-toggle. Only meaningful when offline AI is on
        // AND the model isn't already downloaded. Hide once Ready to keep
        // the row tidy — matches iOS behavior.
        if (enabled && eligible && state !is KokoroModelDownloader.State.Ready) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(start = 48.dp, top = 4.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = stringResource(R.string.settings_offline_ai_allow_cellular),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f)
                )
                Switch(
                    checked = allowCellularDownload,
                    onCheckedChange = onToggleCellular,
                    modifier = Modifier.scale(0.85f)
                )
            }
        }
    }
}

@Composable
private fun SettingsRow(
    icon: ImageVector,
    iconColor: Color,
    title: String,
    subtitle: String,
    onClick: () -> Unit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Icon with colored background
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(iconColor.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = iconColor,
                modifier = Modifier.size(20.dp)
            )
        }

        // Text
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        // Chevron
        Icon(
            imageVector = Icons.Default.ChevronRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun GoogleConnectRow() {
    var isConnected by remember { mutableStateOf(false) }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable { isConnected = !isConnected }
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Google Icon
        Box(
            modifier = Modifier
                .size(36.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(
                    if (isConnected) Red.copy(alpha = 0.15f)
                    else Blue.copy(alpha = 0.15f)
                ),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Email, // Using email as Google substitute
                contentDescription = null,
                tint = if (isConnected) Red else Blue,
                modifier = Modifier.size(20.dp)
            )
        }

        // Text
        Column(
            modifier = Modifier.weight(1f),
            verticalArrangement = Arrangement.spacedBy(2.dp)
        ) {
            Text(
                text = stringResource(R.string.settings_google),
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium
            )
            Text(
                text = if (isConnected) {
                    stringResource(R.string.settings_google_connected)
                } else {
                    stringResource(R.string.settings_google_subtitle)
                },
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }

        // Connect/Disconnect Button
        Button(
            onClick = { isConnected = !isConnected },
            colors = ButtonDefaults.buttonColors(
                containerColor = if (isConnected) Red else Blue
            ),
            shape = RoundedCornerShape(8.dp),
            contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp)
        ) {
            Text(
                text = if (isConnected) {
                    stringResource(R.string.settings_disconnect)
                } else {
                    stringResource(R.string.settings_connect)
                },
                style = MaterialTheme.typography.labelMedium
            )
        }
    }
}
