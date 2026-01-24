package com.listenai.ui.settings

import android.content.Intent
import android.net.Uri
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.listenai.R
import com.listenai.service.settings.SettingsManager
import com.listenai.ui.theme.*
import org.koin.compose.koinInject

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onNavigateToVoices: () -> Unit = {},
    onNavigateToUsage: () -> Unit = {},
    onNavigateToVoiceCloning: () -> Unit = {},
    settingsManager: SettingsManager = koinInject()
) {
    val context = LocalContext.current
    val scrollState = rememberScrollState()

    // Dialog states
    var showSpeedDialog by remember { mutableStateOf(false) }
    var showAppearanceDialog by remember { mutableStateOf(false) }
    var showSkipIntervalDialog by remember { mutableStateOf(false) }
    var showSleepTimerDialog by remember { mutableStateOf(false) }

    // Settings state from SettingsManager (persisted)
    val playbackSpeed by settingsManager.playbackSpeed.collectAsState()
    val appearanceMode by settingsManager.appearanceMode.collectAsState()
    val skipInterval by settingsManager.skipInterval.collectAsState()
    val sleepTimerDefault by settingsManager.sleepTimerDefault.collectAsState()

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
                    title = "Voice Cloning",
                    subtitle = "Create a custom voice from your recording",
                    onClick = onNavigateToVoiceCloning
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
                            putExtra(Intent.EXTRA_SUBJECT, "Check out ListenAI")
                            putExtra(Intent.EXTRA_TEXT, "Listen to any article with natural AI voices! Download ListenAI: https://play.google.com/store/apps/details?id=com.listenai")
                        }
                        context.startActivity(Intent.createChooser(shareIntent, "Share ListenAI"))
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
                    subtitle = "High Quality (HD)",
                    onClick = { /* Audio quality is always HD with self-hosted TTS */ }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.SkipNext,
                    iconColor = Purple,
                    title = stringResource(R.string.settings_skip_interval),
                    subtitle = "${skipInterval} seconds",
                    onClick = { showSkipIntervalDialog = true }
                )

                HorizontalDivider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Timer,
                    iconColor = Green,
                    title = stringResource(R.string.settings_sleep_timer),
                    subtitle = if (sleepTimerDefault == 0) "Off" else "$sleepTimerDefault minutes",
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
                            putExtra(Intent.EXTRA_SUBJECT, "ListenAI Feedback")
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
                    onClick = { /* Version info - no action needed */ }
                )

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
        title = { Text("Playback Speed") },
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
                                contentDescription = "Selected",
                                tint = Blue
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
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
        title = { Text("Appearance") },
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
                                contentDescription = "Selected",
                                tint = Blue
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
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
        title = { Text("Skip Interval") },
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
                            text = "$interval seconds",
                            style = MaterialTheme.typography.bodyLarge
                        )
                        if (interval == currentInterval) {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = "Selected",
                                tint = Blue
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
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
    val options = listOf(0 to "Off", 15 to "15 minutes", 30 to "30 minutes", 45 to "45 minutes", 60 to "1 hour")

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Sleep Timer Default") },
        text = {
            Column {
                options.forEach { (minutes, label) ->
                    Row(
                        modifier = Modifier
                            .fillMaxWidth()
                            .clickable { onMinutesSelected(minutes) }
                            .padding(vertical = 12.dp),
                        horizontalArrangement = Arrangement.SpaceBetween,
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            text = label,
                            style = MaterialTheme.typography.bodyLarge
                        )
                        if (minutes == currentMinutes) {
                            Icon(
                                Icons.Default.Check,
                                contentDescription = "Selected",
                                tint = Blue
                            )
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
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
