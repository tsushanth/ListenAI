package com.listenai.ui.usage

import androidx.compose.ui.res.stringResource
import com.listenai.R
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.tween
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.listenai.data.models.UsageRecord
import com.listenai.data.models.UsageSummary
import com.listenai.data.models.UsageTier
import com.listenai.service.usage.UsageTrackerService
import com.listenai.ui.theme.*
import org.koin.compose.koinInject
import java.text.SimpleDateFormat
import java.util.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun UsageQuotaScreen(
    onNavigateBack: () -> Unit,
    onUpgrade: () -> Unit,
    usageTrackerService: UsageTrackerService = koinInject()
) {
    val scrollState = rememberScrollState()

    val currentTier by usageTrackerService.currentTier.collectAsState()
    val monthlySummary by usageTrackerService.monthlySummary.collectAsState()
    val standardCharsToday by usageTrackerService.standardCharactersUsedToday.collectAsState()
    val standardSamplesToday by usageTrackerService.standardSamplesUsedToday.collectAsState()

    // Fetch usage on screen load
    LaunchedEffect(Unit) {
        usageTrackerService.refreshUsage()
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_usage), fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = stringResource(R.string.back))
                    }
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
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Tier Card
            TierCard(
                tier = currentTier,
                onUpgrade = onUpgrade
            )

            // Today's Usage
            TodayUsageCard(
                charactersUsed = standardCharsToday,
                requestsUsed = standardSamplesToday
            )

            // Monthly Summary
            monthlySummary?.let { summary ->
                MonthlyUsageCard(summary = summary)
            }

            // Usage Statistics
            UsageStatisticsCard(
                monthlySummary = monthlySummary,
                dailyChars = standardCharsToday,
                dailyRequests = standardSamplesToday
            )

            // Info Card
            InfoCard()

            Spacer(modifier = Modifier.height(32.dp))
        }
    }
}

@Composable
private fun TierCard(
    tier: UsageTier,
    onUpgrade: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = when (tier) {
                UsageTier.FREE -> MaterialTheme.colorScheme.surfaceVariant
                UsageTier.BASIC -> Blue.copy(alpha = 0.1f)
                UsageTier.PRO -> Purple.copy(alpha = 0.1f)
                UsageTier.UNLIMITED -> Orange.copy(alpha = 0.1f)
            }
        )
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Column {
                    Text(
                        text = stringResource(R.string.usage_current_plan),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Text(
                        text = stringResource(tier.labelRes),
                        style = MaterialTheme.typography.headlineMedium,
                        fontWeight = FontWeight.Bold,
                        color = when (tier) {
                            UsageTier.FREE -> MaterialTheme.colorScheme.onSurface
                            UsageTier.BASIC -> Blue
                            UsageTier.PRO -> Purple
                            UsageTier.UNLIMITED -> Orange
                        }
                    )
                }

                if (tier == UsageTier.FREE) {
                    Button(
                        onClick = onUpgrade,
                        colors = ButtonDefaults.buttonColors(containerColor = Green)
                    ) {
                        Text(stringResource(R.string.usage_upgrade))
                    }
                }
            }

            // Plan features
            val features = when (tier) {
                UsageTier.FREE -> listOf(R.string.usage_feat_30_min, R.string.usage_feat_all_voices, R.string.usage_feat_self_hosted)
                UsageTier.BASIC -> listOf(R.string.usage_feat_6_hours, R.string.usage_feat_priority_support, R.string.usage_feat_all_voices)
                UsageTier.PRO -> listOf(R.string.usage_feat_24_hours, R.string.usage_feat_priority_support, R.string.usage_feat_all_features)
                UsageTier.UNLIMITED -> listOf(R.string.usage_feat_unlimited, R.string.usage_feat_priority_support, R.string.usage_feat_all_features)
            }

            features.forEach { feature ->
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Icons.Default.Check,
                        contentDescription = null,
                        modifier = Modifier.size(16.dp),
                        tint = Green
                    )
                    Text(
                        text = stringResource(feature),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

@Composable
private fun TodayUsageCard(
    charactersUsed: Int,
    requestsUsed: Int
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = stringResource(R.string.usage_today),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                UsageMetric(
                    icon = Icons.Default.TextFields,
                    iconColor = Blue,
                    value = formatCharacterCount(charactersUsed),
                    label = stringResource(R.string.usage_characters)
                )

                UsageMetric(
                    icon = Icons.Default.GraphicEq,
                    iconColor = Purple,
                    value = requestsUsed.toString(),
                    label = stringResource(R.string.usage_requests)
                )

                UsageMetric(
                    icon = Icons.Default.Timer,
                    iconColor = Green,
                    value = formatDuration(charactersUsed),
                    label = stringResource(R.string.usage_est_audio)
                )
            }
        }
    }
}

@Composable
private fun MonthlyUsageCard(summary: UsageSummary) {
    val animatedProgress by animateFloatAsState(
        targetValue = summary.usagePercentage.coerceIn(0f, 1f),
        animationSpec = tween(1000),
        label = "progress"
    )

    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = stringResource(R.string.usage_monthly),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )

                Text(
                    text = "${(summary.usagePercentage * 100).toInt()}%",
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.Bold,
                    color = when {
                        summary.usagePercentage >= 0.9f -> Red
                        summary.usagePercentage >= 0.7f -> Orange
                        else -> Green
                    }
                )
            }

            // Progress bar
            LinearProgressIndicator(
                progress = { animatedProgress },
                modifier = Modifier
                    .fillMaxWidth()
                    .height(8.dp)
                    .clip(RoundedCornerShape(4.dp)),
                color = when {
                    summary.usagePercentage >= 0.9f -> Red
                    summary.usagePercentage >= 0.7f -> Orange
                    else -> Green
                },
                trackColor = MaterialTheme.colorScheme.surfaceVariant
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Text(
                    text = stringResource(R.string.usage_chars_used, formatCharacterCount(summary.totalCharacters)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Text(
                    text = stringResource(R.string.usage_chars_remaining, formatCharacterCount(summary.remaining)),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            HorizontalDivider()

            // Stats row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceEvenly
            ) {
                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = summary.totalRequests.toString(),
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold
                    )
                    Text(
                        text = stringResource(R.string.usage_total_requests),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                Column(horizontalAlignment = Alignment.CenterHorizontally) {
                    Text(
                        text = "${((summary.successfulRequests.toFloat() / summary.totalRequests.coerceAtLeast(1)) * 100).toInt()}%",
                        style = MaterialTheme.typography.titleLarge,
                        fontWeight = FontWeight.Bold,
                        color = Green
                    )
                    Text(
                        text = stringResource(R.string.usage_success_rate),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // Period info
            val dateFormat = SimpleDateFormat("MMM d", Locale.getDefault())
            Text(
                text = stringResource(R.string.usage_period, dateFormat.format(summary.startDate), dateFormat.format(summary.endDate)),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.align(Alignment.CenterHorizontally)
            )
        }
    }
}

@Composable
private fun UsageStatisticsCard(
    monthlySummary: UsageSummary?,
    dailyChars: Int,
    dailyRequests: Int
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp)
    ) {
        Column(
            modifier = Modifier.padding(20.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                text = stringResource(R.string.usage_statistics),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )

            StatRow(
                label = stringResource(R.string.usage_today_characters),
                value = formatCharacterCount(dailyChars)
            )

            StatRow(
                label = stringResource(R.string.usage_today_requests),
                value = dailyRequests.toString()
            )

            HorizontalDivider()

            monthlySummary?.let { summary ->
                StatRow(
                    label = stringResource(R.string.usage_monthly_characters),
                    value = formatCharacterCount(summary.totalCharacters)
                )

                StatRow(
                    label = stringResource(R.string.usage_monthly_requests),
                    value = summary.totalRequests.toString()
                )

                StatRow(
                    label = stringResource(R.string.usage_successful_requests),
                    value = summary.successfulRequests.toString()
                )

                StatRow(
                    label = stringResource(R.string.usage_failed_requests),
                    value = summary.failedRequests.toString(),
                    valueColor = if (summary.failedRequests > 0) Red else null
                )
            }
        }
    }
}

@Composable
private fun StatRow(
    label: String,
    value: String,
    valueColor: Color? = null
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Text(
            text = value,
            style = MaterialTheme.typography.bodyMedium,
            fontWeight = FontWeight.Medium,
            color = valueColor ?: MaterialTheme.colorScheme.onSurface
        )
    }
}

@Composable
private fun UsageMetric(
    icon: ImageVector,
    iconColor: Color,
    value: String,
    label: String
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(CircleShape)
                .background(iconColor.copy(alpha = 0.1f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = iconColor,
                modifier = Modifier.size(24.dp)
            )
        }

        Text(
            text = value,
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold
        )

        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Composable
private fun InfoCard() {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = Blue.copy(alpha = 0.1f)
        )
    ) {
        Row(
            modifier = Modifier.padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.Top
        ) {
            Icon(
                Icons.Default.Info,
                contentDescription = null,
                tint = Blue,
                modifier = Modifier.size(20.dp)
            )

            Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                Text(
                    text = stringResource(R.string.usage_information),
                    style = MaterialTheme.typography.labelLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = Blue
                )
                Text(
                    text = stringResource(R.string.usage_information_body),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

private fun formatCharacterCount(count: Int): String {
    return when {
        count >= 1_000_000 -> String.format("%.1fM", count / 1_000_000f)
        count >= 1_000 -> String.format("%.1fK", count / 1_000f)
        else -> count.toString()
    }
}

@Composable
private fun formatDuration(characterCount: Int): String {
    // Approximate: 150 characters per minute of speech
    val minutes = characterCount / 150
    return when {
        minutes >= 60 && minutes % 60 > 0 -> stringResource(R.string.duration_hr_min, minutes / 60, minutes % 60)
        minutes >= 60 -> stringResource(R.string.duration_hr, minutes / 60)
        minutes > 0 -> stringResource(R.string.duration_min, minutes)
        else -> stringResource(R.string.duration_less_than_min)
    }
}
