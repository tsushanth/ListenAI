package com.listenai.ui.settings

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
import androidx.compose.material3.Divider
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.listenai.R
import com.listenai.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onNavigateToVoices: () -> Unit = {},
    onNavigateToUsage: () -> Unit = {}
) {
    val scrollState = rememberScrollState()

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

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Speed,
                    iconColor = Orange,
                    title = stringResource(R.string.settings_speed),
                    subtitle = stringResource(R.string.settings_speed_subtitle),
                    onClick = { }
                )

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.DarkMode,
                    iconColor = Purple,
                    title = stringResource(R.string.settings_appearance),
                    subtitle = stringResource(R.string.settings_appearance_subtitle),
                    onClick = { }
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
                    onClick = { }
                )

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Star,
                    iconColor = Orange,
                    title = stringResource(R.string.settings_rate_app),
                    subtitle = stringResource(R.string.settings_rate_app_subtitle),
                    onClick = { }
                )
            }

            // Playback Section
            SettingsSection(title = stringResource(R.string.settings_playback)) {
                SettingsRow(
                    icon = Icons.Default.Headphones,
                    iconColor = Blue,
                    title = stringResource(R.string.settings_audio_quality),
                    subtitle = stringResource(R.string.settings_audio_quality_subtitle),
                    onClick = { }
                )

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.SkipNext,
                    iconColor = Purple,
                    title = stringResource(R.string.settings_skip_interval),
                    subtitle = stringResource(R.string.settings_skip_interval_subtitle),
                    onClick = { }
                )

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Timer,
                    iconColor = Green,
                    title = stringResource(R.string.settings_sleep_timer),
                    subtitle = stringResource(R.string.settings_sleep_timer_subtitle),
                    onClick = { }
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

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Help,
                    iconColor = Orange,
                    title = stringResource(R.string.settings_help),
                    subtitle = stringResource(R.string.settings_help_subtitle),
                    onClick = { }
                )

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Feedback,
                    iconColor = Purple,
                    title = stringResource(R.string.settings_feedback),
                    subtitle = stringResource(R.string.settings_feedback_subtitle),
                    onClick = { }
                )
            }

            // About Section
            SettingsSection(title = stringResource(R.string.settings_about)) {
                SettingsRow(
                    icon = Icons.Default.Info,
                    iconColor = Blue,
                    title = stringResource(R.string.settings_version),
                    subtitle = "1.0.0",
                    onClick = { }
                )

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Policy,
                    iconColor = Green,
                    title = stringResource(R.string.settings_privacy),
                    subtitle = stringResource(R.string.settings_privacy_subtitle),
                    onClick = { }
                )

                Divider(modifier = Modifier.padding(start = 56.dp))

                SettingsRow(
                    icon = Icons.Default.Description,
                    iconColor = Orange,
                    title = stringResource(R.string.settings_terms),
                    subtitle = stringResource(R.string.settings_terms_subtitle),
                    onClick = { }
                )
            }

            Spacer(modifier = Modifier.height(32.dp))
        }
    }
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
