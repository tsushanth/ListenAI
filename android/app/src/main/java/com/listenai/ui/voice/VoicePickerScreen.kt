package com.listenai.ui.voice

import androidx.compose.foundation.background
import androidx.compose.foundation.border
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
    // All voices are now standard quality (Kokoro GPU-accelerated)
    val displayedVoices = voices.ifEmpty { VoicePreset.builtInVoices }

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
            // Quality info card (simplified - all voices are high quality now)
            QualityInfoCard(
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
            )

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
                        onSelect = { onVoiceSelected(voice) },
                        onPreview = { onPreviewVoice(voice, VoiceQuality.STANDARD) }
                    )
                }
            }
        }
    }
}

@Composable
private fun QualityInfoCard(modifier: Modifier = Modifier) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(12.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
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
                imageVector = Icons.Default.GraphicEq,
                contentDescription = null,
                tint = Blue
            )
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = "High Quality Voices",
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "GPU-accelerated, natural voices - unlimited usage",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Surface(
                shape = RoundedCornerShape(4.dp),
                color = Green.copy(alpha = 0.15f)
            ) {
                Text(
                    text = "FREE",
                    modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                    style = MaterialTheme.typography.labelSmall,
                    fontWeight = FontWeight.Bold,
                    color = Green
                )
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun VoiceCard(
    voice: VoicePreset,
    isSelected: Boolean,
    onSelect: () -> Unit,
    onPreview: () -> Unit
) {
    val borderColor = if (isSelected) Blue else Color.Transparent

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
                    QualityBadge()
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

@Composable
private fun VoiceAvatar(voice: VoicePreset) {
    // Use accent color from voice if available, otherwise fall back to gender-based color
    val accentColor = voice.accentColorHex?.let { parseHexColor(it) }
        ?: when (voice.gender) {
            VoiceGender.FEMALE -> Pink
            VoiceGender.MALE -> Blue
            VoiceGender.NEUTRAL -> Green
        }

    Box(
        modifier = Modifier
            .size(48.dp)
            .clip(CircleShape)
            .background(accentColor.copy(alpha = 0.2f)),
        contentAlignment = Alignment.Center
    ) {
        // Show avatar emoji if available, otherwise show initials
        if (voice.avatarEmoji != null) {
            Text(
                text = voice.avatarEmoji,
                style = MaterialTheme.typography.titleLarge
            )
        } else {
            Text(
                text = voice.name.take(2).uppercase(),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = accentColor
            )
        }
    }
}

/**
 * Parse hex color string to Color
 */
private fun parseHexColor(hex: String): Color {
    return try {
        val cleanHex = hex.removePrefix("#")
        val colorInt = android.graphics.Color.parseColor("#$cleanHex")
        Color(colorInt)
    } catch (e: Exception) {
        Blue // Default fallback
    }
}

@Composable
private fun QualityBadge() {
    Surface(
        shape = RoundedCornerShape(4.dp),
        color = Blue.copy(alpha = 0.15f)
    ) {
        Text(
            text = "HD",
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
            style = MaterialTheme.typography.labelSmall,
            fontWeight = FontWeight.Bold,
            color = Blue
        )
    }
}

// Theme colors (add to your theme)
private val Pink = Color(0xFFEC4899)
