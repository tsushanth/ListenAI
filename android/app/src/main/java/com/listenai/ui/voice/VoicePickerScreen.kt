package com.listenai.ui.voice

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.listenai.data.models.PremiumUsageSummary
import com.listenai.data.models.VoiceGender
import com.listenai.data.models.VoicePreset
import com.listenai.data.models.VoiceQuality
import com.listenai.data.models.VoiceTier
import com.listenai.ui.theme.*

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VoicePickerScreen(
    voices: List<VoicePreset> = VoicePreset.builtInVoices,
    selectedVoice: VoicePreset? = null,
    selectedQuality: VoiceQuality = VoiceQuality.STANDARD,
    premiumSummary: PremiumUsageSummary? = null,
    onVoiceSelected: (VoicePreset) -> Unit = {},
    onQualityChanged: (VoiceQuality) -> Unit = {},
    onPreviewVoice: (VoicePreset, VoiceQuality) -> Unit = { _, _ -> },
    onNavigateBack: () -> Unit = {}
) {
    val standardVoices = remember(voices) { voices.filter { it.quality == VoiceQuality.STANDARD } }
    val premiumVoices = remember(voices) { voices.filter { it.quality == VoiceQuality.PREMIUM || it.supportsPremium } }

    val displayedVoices = when (selectedQuality) {
        VoiceQuality.STANDARD -> standardVoices.ifEmpty { VoicePreset.standardVoices }
        VoiceQuality.PREMIUM -> premiumVoices.ifEmpty { VoicePreset.premiumVoices }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = "Choose Voice",
                        fontWeight = FontWeight.Bold
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
        ) {
            // Quality Toggle
            QualityToggle(
                selectedQuality = selectedQuality,
                premiumSummary = premiumSummary,
                onQualityChanged = onQualityChanged,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
            )

            // Premium exhausted banner
            AnimatedVisibility(
                visible = selectedQuality == VoiceQuality.PREMIUM && premiumSummary?.isExhausted == true
            ) {
                PremiumExhaustedBanner(
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                )
            }

            // Voice list
            LazyColumn(
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(horizontal = 16.dp, vertical = 8.dp),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(displayedVoices) { voice ->
                    VoiceCard(
                        voice = voice,
                        isSelected = selectedVoice?.id == voice.id,
                        quality = selectedQuality,
                        onSelect = { onVoiceSelected(voice) },
                        onPreview = { onPreviewVoice(voice, selectedQuality) }
                    )
                }
            }
        }
    }
}

@Composable
private fun QualityToggle(
    selectedQuality: VoiceQuality,
    premiumSummary: PremiumUsageSummary?,
    onQualityChanged: (VoiceQuality) -> Unit,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            Text(
                text = "Voice Quality",
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold
            )

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                // Standard Quality Button
                QualityButton(
                    quality = VoiceQuality.STANDARD,
                    isSelected = selectedQuality == VoiceQuality.STANDARD,
                    onClick = { onQualityChanged(VoiceQuality.STANDARD) },
                    modifier = Modifier.weight(1f)
                )

                // Premium Quality Button
                QualityButton(
                    quality = VoiceQuality.PREMIUM,
                    isSelected = selectedQuality == VoiceQuality.PREMIUM,
                    onClick = { onQualityChanged(VoiceQuality.PREMIUM) },
                    modifier = Modifier.weight(1f),
                    badge = premiumSummary?.let { "${it.samplesRemaining}" }
                )
            }

            // Description
            Text(
                text = selectedQuality.description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // Premium samples remaining
            if (selectedQuality == VoiceQuality.PREMIUM && premiumSummary != null) {
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    LinearProgressIndicator(
                        progress = premiumSummary.usagePercentage,
                        modifier = Modifier
                            .weight(1f)
                            .height(6.dp)
                            .clip(RoundedCornerShape(3.dp)),
                        color = if (premiumSummary.isExhausted) Red else Purple
                    )
                    Text(
                        text = premiumSummary.formattedSamplesRemaining,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
        }
    }
}

@Composable
private fun QualityButton(
    quality: VoiceQuality,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    badge: String? = null
) {
    val backgroundColor = if (isSelected) {
        when (quality) {
            VoiceQuality.STANDARD -> Blue
            VoiceQuality.PREMIUM -> Purple
        }
    } else {
        MaterialTheme.colorScheme.surface
    }

    val contentColor = if (isSelected) Color.White else MaterialTheme.colorScheme.onSurface

    Surface(
        modifier = modifier
            .height(48.dp)
            .then(
                if (!isSelected) {
                    Modifier.border(
                        width = 1.dp,
                        color = MaterialTheme.colorScheme.outline,
                        shape = RoundedCornerShape(8.dp)
                    )
                } else {
                    Modifier
                }
            ),
        shape = RoundedCornerShape(8.dp),
        color = backgroundColor,
        onClick = onClick
    ) {
        Row(
            modifier = Modifier
                .fillMaxSize()
                .padding(horizontal = 12.dp),
            horizontalArrangement = Arrangement.Center,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = quality.displayName,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                color = contentColor
            )

            if (badge != null) {
                Spacer(modifier = Modifier.width(6.dp))
                Surface(
                    shape = CircleShape,
                    color = if (isSelected) Color.White.copy(alpha = 0.2f) else Purple.copy(alpha = 0.15f)
                ) {
                    Text(
                        text = badge,
                        modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = if (isSelected) Color.White else Purple
                    )
                }
            }
        }
    }
}

@Composable
private fun PremiumExhaustedBanner(modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = Orange.copy(alpha = 0.15f)
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Icon(
                imageVector = Icons.Default.Warning,
                contentDescription = null,
                tint = Orange
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "Premium samples used for today",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = Orange
                )
                Text(
                    text = "Resets at midnight. Upgrade for more.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            TextButton(onClick = { /* Navigate to upgrade */ }) {
                Text("Upgrade", color = Orange)
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VoiceCard(
    voice: VoicePreset,
    isSelected: Boolean,
    quality: VoiceQuality,
    onSelect: () -> Unit,
    onPreview: () -> Unit
) {
    val borderColor = if (isSelected) {
        when (quality) {
            VoiceQuality.STANDARD -> Blue
            VoiceQuality.PREMIUM -> Purple
        }
    } else {
        Color.Transparent
    }

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .then(
                if (isSelected) {
                    Modifier.border(
                        width = 2.dp,
                        color = borderColor,
                        shape = RoundedCornerShape(12.dp)
                    )
                } else {
                    Modifier
                }
            ),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected) {
                borderColor.copy(alpha = 0.1f)
            } else {
                MaterialTheme.colorScheme.surfaceVariant
            }
        ),
        onClick = onSelect
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Voice Avatar
            VoiceAvatar(voice = voice)

            // Voice Info
            Column(modifier = Modifier.weight(1f)) {
                Row(
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = voice.name,
                        style = MaterialTheme.typography.bodyLarge,
                        fontWeight = FontWeight.SemiBold,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )

                    // Quality badge
                    QualityBadge(quality = voice.quality)

                    // Tier badge
                    if (voice.tier == VoiceTier.PREMIUM) {
                        Surface(
                            shape = RoundedCornerShape(4.dp),
                            color = Purple.copy(alpha = 0.15f)
                        ) {
                            Text(
                                text = "PRO",
                                modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
                                style = MaterialTheme.typography.labelSmall,
                                fontWeight = FontWeight.Bold,
                                color = Purple
                            )
                        }
                    }
                }

                Text(
                    text = buildString {
                        append(voice.style.name.lowercase().replaceFirstChar { it.uppercase() })
                        append(" • ")
                        append(voice.gender.name.lowercase().replaceFirstChar { it.uppercase() })
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Preview button
            IconButton(onClick = onPreview) {
                Icon(
                    imageVector = Icons.Default.PlayCircle,
                    contentDescription = "Preview voice",
                    tint = if (isSelected) borderColor else MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Selected checkmark
            if (isSelected) {
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = "Selected",
                    tint = borderColor
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VoiceAvatar(voice: VoicePreset) {
    val avatarColor = when (voice.gender) {
        VoiceGender.FEMALE -> Pink
        VoiceGender.MALE -> Blue
        VoiceGender.NEUTRAL -> Green
    }

    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(avatarColor.copy(alpha = 0.2f)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = voice.name.take(2).uppercase(),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.Bold,
            color = avatarColor
        )
    }
}

@Composable
private fun QualityBadge(quality: VoiceQuality) {
    val (text, color) = when (quality) {
        VoiceQuality.STANDARD -> "STD" to Blue
        VoiceQuality.PREMIUM -> "PRO" to Purple
    }

    Surface(
        shape = RoundedCornerShape(4.dp),
        color = color.copy(alpha = 0.15f)
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = color
        )
    }
}

// Theme colors (add to your theme)
private val Pink = Color(0xFFEC4899)
