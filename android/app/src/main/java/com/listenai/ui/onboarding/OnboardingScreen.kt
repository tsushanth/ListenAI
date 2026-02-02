package com.listenai.ui.onboarding

import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInHorizontally
import androidx.compose.animation.slideOutHorizontally
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.ArrowForward
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.DisposableEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.foundation.text.ClickableText
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.foundation.isSystemInDarkTheme
import com.listenai.data.models.VoicePreset
import com.listenai.service.billing.RevenueCatManager
import com.listenai.ui.theme.*
import com.revenuecat.purchases.PackageType
import kotlinx.coroutines.launch

// Theme colors for onboarding - Light mode
private val WarmBackgroundLight = Color(0xFFFFF8E7)
private val WarmBackgroundLightEnd = Color(0xFFFFF5E0)

// Theme colors for onboarding - Dark mode
private val WarmBackgroundDark = Color(0xFF1C1C1E)
private val WarmBackgroundDarkEnd = Color(0xFF2C2C2E)

@Composable
fun OnboardingScreen(
    onboardingManager: OnboardingManager,
    onComplete: () -> Unit
) {
    val currentPage by onboardingManager.currentPage.collectAsState()
    val isDarkTheme = isSystemInDarkTheme()

    // Theme-aware colors
    val backgroundColor = if (isDarkTheme) WarmBackgroundDark else WarmBackgroundLight
    val backgroundEndColor = if (isDarkTheme) WarmBackgroundDarkEnd else WarmBackgroundLightEnd
    val surfaceEndColor = if (isDarkTheme) Color(0xFF000000) else Color.White
    val contentColor = if (isDarkTheme) Color.White else Color.Black

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(backgroundColor, backgroundEndColor, surfaceEndColor)
                )
            )
    ) {
        Column(
            modifier = Modifier.fillMaxSize()
        ) {
            // Top bar with back/skip buttons
            OnboardingTopBar(
                currentPage = currentPage,
                onBack = { onboardingManager.previousPage() },
                onSkip = { onboardingManager.skipToPaywall() }
            )

            // Page content with animation
            AnimatedContent(
                targetState = currentPage,
                transitionSpec = {
                    if (targetState.index > initialState.index) {
                        (slideInHorizontally { it } + fadeIn()) togetherWith
                                (slideOutHorizontally { -it } + fadeOut())
                    } else {
                        (slideInHorizontally { -it } + fadeIn()) togetherWith
                                (slideOutHorizontally { it } + fadeOut())
                    }
                },
                modifier = Modifier.weight(1f),
                label = "page_transition"
            ) { page ->
                when (page) {
                    OnboardingPage.WELCOME -> WelcomePage()
                    OnboardingPage.DOCUMENT_TO_AUDIO -> DocumentToAudioPage()
                    OnboardingPage.TAKE_NOTES -> TakeNotesPage()
                    OnboardingPage.PRODUCTIVITY -> ProductivityPage()
                    OnboardingPage.VOICE_SELECTION -> VoiceSelectionPage(
                        onVoiceSelected = { voiceId ->
                            onboardingManager.setSelectedVoice(voiceId)
                        }
                    )
                    OnboardingPage.PAYWALL -> PaywallPage(
                        onComplete = {
                            // Go to sign-in page instead of completing
                            onboardingManager.nextPage()
                        }
                    )
                    OnboardingPage.SIGN_IN -> SignInPage(
                        onComplete = {
                            onboardingManager.completeOnboarding()
                            onComplete()
                        }
                    )
                }
            }

            // Page indicator and continue button
            if (currentPage != OnboardingPage.PAYWALL && currentPage != OnboardingPage.SIGN_IN) {
                OnboardingFooter(
                    currentPage = currentPage,
                    onContinue = { onboardingManager.nextPage() }
                )
            }
        }
    }
}

@Composable
private fun OnboardingTopBar(
    currentPage: OnboardingPage,
    onBack: () -> Unit,
    onSkip: () -> Unit
) {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
            .statusBarsPadding(),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Back button
        if (currentPage.showsBackButton) {
            IconButton(onClick = onBack) {
                Icon(
                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                    contentDescription = "Back",
                    tint = contentColor
                )
            }
        } else {
            Spacer(modifier = Modifier.size(48.dp))
        }

        // Page indicator dots
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            OnboardingPage.entries.forEach { page ->
                Box(
                    modifier = Modifier
                        .size(if (page == currentPage) 10.dp else 8.dp)
                        .clip(CircleShape)
                        .background(
                            if (page == currentPage) contentColor
                            else contentColor.copy(alpha = 0.2f)
                        )
                )
            }
        }

        // Skip button
        if (currentPage.showsSkipButton) {
            TextButton(onClick = onSkip) {
                Text("Skip", color = contentColor.copy(alpha = 0.6f))
            }
        } else {
            Spacer(modifier = Modifier.size(48.dp))
        }
    }
}

@Composable
private fun OnboardingFooter(
    currentPage: OnboardingPage,
    onContinue: () -> Unit
) {
    val uriHandler = LocalUriHandler.current
    val privacyUrl = "https://kreativekoala.llc/privacy"
    val termsUrl = "https://kreativekoala.llc/terms"
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black
    val buttonColor = if (isDarkTheme) Color.White else Color.Black
    val buttonTextColor = if (isDarkTheme) Color.Black else Color.White

    Column(
        modifier = Modifier
            .fillMaxWidth()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(16.dp)
    ) {
        Button(
            onClick = onContinue,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = buttonColor,
                contentColor = buttonTextColor
            )
        ) {
            Text(
                text = if (currentPage == OnboardingPage.VOICE_SELECTION) "Continue" else "Next",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold,
                color = buttonTextColor
            )
        }

        // Terms text with clickable links
        if (currentPage == OnboardingPage.WELCOME) {
            val annotatedText = buildAnnotatedString {
                append("By continuing, you agree to our ")

                pushStringAnnotation(tag = "privacy", annotation = privacyUrl)
                withStyle(style = SpanStyle(color = Blue, textDecoration = TextDecoration.Underline)) {
                    append("Privacy Policy")
                }
                pop()

                append(" and ")

                pushStringAnnotation(tag = "terms", annotation = termsUrl)
                withStyle(style = SpanStyle(color = Blue, textDecoration = TextDecoration.Underline)) {
                    append("Terms of Use")
                }
                pop()

                append(".")
            }

            ClickableText(
                text = annotatedText,
                style = MaterialTheme.typography.bodySmall.copy(
                    color = contentColor.copy(alpha = 0.5f),
                    textAlign = TextAlign.Center
                ),
                onClick = { offset ->
                    annotatedText.getStringAnnotations(tag = "privacy", start = offset, end = offset)
                        .firstOrNull()?.let { uriHandler.openUri(it.item) }
                    annotatedText.getStringAnnotations(tag = "terms", start = offset, end = offset)
                        .firstOrNull()?.let { uriHandler.openUri(it.item) }
                }
            )
        }
    }
}

// MARK: - Welcome Page

@Composable
private fun WelcomePage() {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black
    val iconBgColor = if (isDarkTheme) Color.White else Color.Black
    val iconTintColor = if (isDarkTheme) Color.Black else Color.White

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        // App icon or illustration
        Box(
            modifier = Modifier
                .size(120.dp)
                .clip(RoundedCornerShape(24.dp))
                .background(iconBgColor),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Headphones,
                contentDescription = null,
                modifier = Modifier.size(60.dp),
                tint = iconTintColor
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        Text(
            text = "Welcome to",
            style = MaterialTheme.typography.headlineMedium,
            color = contentColor.copy(alpha = 0.6f)
        )

        Text(
            text = "ReadAloud AI",
            style = MaterialTheme.typography.displayMedium,
            fontWeight = FontWeight.Bold,
            color = contentColor
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Transform any document into natural-sounding audio. Listen to articles, PDFs, and more on the go.",
            style = MaterialTheme.typography.bodyLarge,
            color = contentColor.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Feature pills
        Row(
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            FeaturePill("PDF")
            FeaturePill("Web")
            FeaturePill("ePUB")
            FeaturePill("Text")
        }
    }
}

@Composable
private fun FeaturePill(text: String) {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black

    Surface(
        shape = RoundedCornerShape(20.dp),
        color = contentColor.copy(alpha = 0.08f)
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Medium,
            color = contentColor
        )
    }
}

// MARK: - Document to Audio Page

@Composable
private fun DocumentToAudioPage() {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "Import from Anywhere",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = contentColor,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Paste a link, upload a PDF, or type text directly",
            style = MaterialTheme.typography.bodyLarge,
            color = contentColor.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(48.dp))

        // Import method cards
        Column(
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            ImportMethodCard(
                icon = Icons.Default.Link,
                title = "Web Links",
                subtitle = "Paste any article URL"
            )
            ImportMethodCard(
                icon = Icons.Default.PictureAsPdf,
                title = "PDF Documents",
                subtitle = "Upload PDFs from your device"
            )
            ImportMethodCard(
                icon = Icons.Default.TextFields,
                title = "Direct Text",
                subtitle = "Type or paste any text"
            )
            ImportMethodCard(
                icon = Icons.Default.ContentPaste,
                title = "Clipboard",
                subtitle = "Auto-detect copied content"
            )
        }
    }
}

@Composable
private fun ImportMethodCard(
    icon: ImageVector,
    title: String,
    subtitle: String
) {
    val isDarkTheme = isSystemInDarkTheme()
    val cardBgColor = if (isDarkTheme) CardDark else Color.White
    val contentColor = if (isDarkTheme) Color.White else Color.Black

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(cardBgColor)
            .padding(16.dp),
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(48.dp)
                .clip(RoundedCornerShape(12.dp))
                .background(Blue.copy(alpha = 0.1f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = Blue
            )
        }

        Column {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.SemiBold,
                color = contentColor
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = contentColor.copy(alpha = 0.6f)
            )
        }
    }
}

// MARK: - Take Notes Page

@Composable
private fun TakeNotesPage() {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black
    val cardBgColor = if (isDarkTheme) CardDark else Color.White
    val buttonBgColor = if (isDarkTheme) Color.White else Color.Black
    val buttonTintColor = if (isDarkTheme) Color.Black else Color.White

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "Take Notes While Listening",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = contentColor,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Capture key insights without interrupting playback",
            style = MaterialTheme.typography.bodyLarge,
            color = contentColor.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(48.dp))

        // Mock playback UI with notes
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = cardBgColor)
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                // Playback controls mock
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(Icons.Default.SkipPrevious, contentDescription = null, modifier = Modifier.size(32.dp), tint = contentColor)
                    Box(
                        modifier = Modifier
                            .size(64.dp)
                            .clip(CircleShape)
                            .background(buttonBgColor),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(Icons.Default.Pause, contentDescription = null, tint = buttonTintColor, modifier = Modifier.size(32.dp))
                    }
                    Icon(Icons.Default.SkipNext, contentDescription = null, modifier = Modifier.size(32.dp), tint = contentColor)
                }

                // Progress bar
                LinearProgressIndicator(
                    progress = 0.4f,
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(4.dp)
                        .clip(RoundedCornerShape(2.dp)),
                    color = Blue
                )

                // Note input mock
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(contentColor.copy(alpha = 0.05f))
                        .padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Icons.Default.Edit,
                        contentDescription = null,
                        tint = contentColor.copy(alpha = 0.5f)
                    )
                    Text(
                        text = "Add a note at 2:34...",
                        style = MaterialTheme.typography.bodyMedium,
                        color = contentColor.copy(alpha = 0.5f)
                    )
                }
            }
        }
    }
}

// MARK: - Productivity Page

@Composable
private fun ProductivityPage() {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black
    val cardBgColor = if (isDarkTheme) CardDark else Color.White

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.Center
    ) {
        Text(
            text = "Boost Your Productivity",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = contentColor,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Natural voices and adjustable speed for efficient learning",
            style = MaterialTheme.typography.bodyLarge,
            color = contentColor.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(48.dp))

        // Speed selector
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = cardBgColor)
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text(
                    text = "Playback Speed",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold,
                    color = contentColor
                )

                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceEvenly
                ) {
                    SpeedChip("0.75x", false)
                    SpeedChip("1x", false)
                    SpeedChip("1.5x", true)
                    SpeedChip("2x", false)
                }
            }
        }

        Spacer(modifier = Modifier.height(24.dp))

        // Features list
        Column(
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            FeatureRow(Icons.Default.Headphones, "Background playback")
            FeatureRow(Icons.Default.Timer, "Sleep timer")
            FeatureRow(Icons.Default.Bookmark, "Bookmarks & chapters")
        }
    }
}

@Composable
private fun SpeedChip(speed: String, isSelected: Boolean) {
    val isDarkTheme = isSystemInDarkTheme()
    val selectedBgColor = if (isDarkTheme) Color.White else Color.Black
    val selectedTextColor = if (isDarkTheme) Color.Black else Color.White
    val unselectedBgColor = if (isDarkTheme) Color.White.copy(alpha = 0.1f) else Color.Black.copy(alpha = 0.05f)
    val unselectedTextColor = if (isDarkTheme) Color.White else Color.Black

    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (isSelected) selectedBgColor else unselectedBgColor
    ) {
        Text(
            text = speed,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (isSelected) selectedTextColor else unselectedTextColor
        )
    }
}

@Composable
private fun FeatureRow(icon: ImageVector, text: String) {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black

    Row(
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = Green
        )
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge,
            color = contentColor
        )
    }
}

// MARK: - Voice Selection Page

@Composable
private fun VoiceSelectionPage(
    onVoiceSelected: (String) -> Unit
) {
    val context = LocalContext.current
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black
    var selectedVoiceId by remember { mutableStateOf<String?>(null) }

    // Create audio player
    val audioPlayer = remember { OnboardingAudioPlayer(context) }
    val isPlaying by audioPlayer.isPlaying.collectAsState()
    val currentPlayingVoiceId by audioPlayer.currentVoiceId.collectAsState()

    // Clean up when leaving the page
    DisposableEffect(Unit) {
        onDispose {
            audioPlayer.release()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Choose Your Voice",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = contentColor,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Pick a voice that suits your listening style",
            style = MaterialTheme.typography.bodyLarge,
            color = contentColor.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Voice options
        Column(
            modifier = Modifier
                .verticalScroll(rememberScrollState())
                .weight(1f),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            VoicePreset.builtInVoices.forEach { voice ->
                VoiceOptionCard(
                    voice = voice,
                    isSelected = selectedVoiceId == voice.id,
                    isPlaying = currentPlayingVoiceId == voice.id && isPlaying,
                    onSelect = {
                        selectedVoiceId = voice.id
                        onVoiceSelected(voice.id)
                    },
                    onPlayPreview = {
                        audioPlayer.toggle(voice.id)
                    }
                )
            }
        }
    }
}

@Composable
private fun VoiceOptionCard(
    voice: VoicePreset,
    isSelected: Boolean,
    isPlaying: Boolean = false,
    onSelect: () -> Unit,
    onPlayPreview: () -> Unit = {}
) {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black
    val cardBgColor = if (isDarkTheme) CardDark else Color.White
    val borderColor = if (isSelected) Blue else Color.Transparent

    // Use accent color from voice if available
    val accentColor = voice.accentColorHex?.let { parseHexColor(it) } ?: Blue

    Card(
        modifier = Modifier
            .fillMaxWidth()
            .border(
                width = 2.dp,
                color = borderColor,
                shape = RoundedCornerShape(16.dp)
            )
            .clickable { onSelect() },
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected) accentColor.copy(alpha = 0.1f) else cardBgColor
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Avatar with emoji or initials
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(accentColor.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center
            ) {
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

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = voice.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold,
                    color = contentColor
                )
                Text(
                    text = "${voice.style.name.lowercase().replaceFirstChar { it.uppercase() }} - ${voice.gender.name.lowercase().replaceFirstChar { it.uppercase() }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = contentColor.copy(alpha = 0.6f)
                )
            }

            // Play preview button
            IconButton(onClick = onPlayPreview) {
                Icon(
                    imageVector = if (isPlaying) Icons.Default.StopCircle else Icons.Default.PlayCircle,
                    contentDescription = if (isPlaying) "Stop preview" else "Preview voice",
                    tint = if (isPlaying) Orange else if (isSelected) accentColor else contentColor.copy(alpha = 0.5f)
                )
            }

            if (isSelected) {
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = "Selected",
                    tint = accentColor
                )
            }
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

// MARK: - Paywall Page

@Composable
private fun PaywallPage(
    onComplete: () -> Unit
) {
    val context = LocalContext.current
    val activity = context as? ComponentActivity
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black
    val cardBgColor = if (isDarkTheme) CardDark else Color.White

    // Use RevenueCat manager
    val revenueCatManager = remember { RevenueCatManager.getInstance() }
    val scope = rememberCoroutineScope()

    // Observe RevenueCat state
    val packages by revenueCatManager.packages.collectAsState()
    val isPremium by revenueCatManager.isPremium.collectAsState()
    val isLoading by revenueCatManager.isLoading.collectAsState()

    // Get the weekly package
    val weeklyPackage = packages.find { it.packageType == PackageType.WEEKLY }

    // Get localized price
    val weeklyPrice = weeklyPackage?.product?.price?.formatted ?: "Loading..."

    // Handle purchase success
    LaunchedEffect(isPremium) {
        if (isPremium) {
            Toast.makeText(context, "Welcome to Pro!", Toast.LENGTH_LONG).show()
            onComplete()
        }
    }

    // Load offerings if not already loaded
    LaunchedEffect(Unit) {
        if (packages.isEmpty()) {
            revenueCatManager.loadOfferings()
        }
    }

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(modifier = Modifier.height(16.dp))

        // Pro badge
        Surface(
            shape = RoundedCornerShape(20.dp),
            color = Purple.copy(alpha = 0.1f)
        ) {
            Text(
                text = "PRO",
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 6.dp),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.Bold,
                color = Purple
            )
        }

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Unlock ReadAloud AI Pro",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = contentColor,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Get unlimited access to all premium features",
            style = MaterialTheme.typography.bodyLarge,
            color = contentColor.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Features
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = cardBgColor)
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                ProFeatureRow("Unlimited listening")
                ProFeatureRow("Premium AI voices")
                ProFeatureRow("Offline downloads")
                ProFeatureRow("No ads")
                ProFeatureRow("Priority support")
            }
        }

        Spacer(modifier = Modifier.weight(1f))

        // Price card
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = Purple.copy(alpha = 0.1f))
        ) {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "$weeklyPrice/week",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color = Purple
                )
                Text(
                    text = "7-day free trial, then $weeklyPrice/week",
                    style = MaterialTheme.typography.bodySmall,
                    color = contentColor.copy(alpha = 0.6f)
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Subscribe button
        Button(
            onClick = {
                if (activity == null) {
                    Toast.makeText(context, "Unable to start purchase", Toast.LENGTH_SHORT).show()
                    return@Button
                }

                val pkg = weeklyPackage
                if (pkg == null) {
                    Toast.makeText(context, "Product not available yet, please try again", Toast.LENGTH_SHORT).show()
                    return@Button
                }

                // Launch RevenueCat purchase flow
                scope.launch {
                    revenueCatManager.purchase(activity, pkg)
                }
            },
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = Purple,
                contentColor = Color.White
            ),
            enabled = weeklyPackage != null && !isLoading
        ) {
            if (isLoading) {
                CircularProgressIndicator(
                    modifier = Modifier.size(24.dp),
                    color = Color.White
                )
            } else {
                Text(
                    text = "Start Free Trial",
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = Color.White
                )
            }
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Skip button
        TextButton(onClick = onComplete) {
            Text(
                text = "Maybe Later",
                color = contentColor.copy(alpha = 0.5f)
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Terms with clickable links
        val uriHandler = LocalUriHandler.current
        val privacyUrl = "https://kreativekoala.llc/privacy"
        val termsUrl = "https://kreativekoala.llc/terms"

        val annotatedTermsText = buildAnnotatedString {
            append("By subscribing, you agree to our ")

            pushStringAnnotation(tag = "terms", annotation = termsUrl)
            withStyle(style = SpanStyle(color = Blue, textDecoration = TextDecoration.Underline)) {
                append("Terms of Use")
            }
            pop()

            append(" and ")

            pushStringAnnotation(tag = "privacy", annotation = privacyUrl)
            withStyle(style = SpanStyle(color = Blue, textDecoration = TextDecoration.Underline)) {
                append("Privacy Policy")
            }
            pop()

            append(". Subscription auto-renews weekly until cancelled.")
        }

        ClickableText(
            text = annotatedTermsText,
            style = MaterialTheme.typography.labelSmall.copy(
                color = contentColor.copy(alpha = 0.4f),
                textAlign = TextAlign.Center
            ),
            onClick = { offset ->
                annotatedTermsText.getStringAnnotations(tag = "terms", start = offset, end = offset)
                    .firstOrNull()?.let { uriHandler.openUri(it.item) }
                annotatedTermsText.getStringAnnotations(tag = "privacy", start = offset, end = offset)
                    .firstOrNull()?.let { uriHandler.openUri(it.item) }
            }
        )
    }
}

@Composable
private fun ProFeatureRow(text: String) {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black

    Row(
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = Icons.Default.CheckCircle,
            contentDescription = null,
            tint = Purple,
            modifier = Modifier.size(20.dp)
        )
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = contentColor
        )
    }
}

// MARK: - Sign-In Page

@Composable
private fun SignInPage(
    onComplete: () -> Unit
) {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black
    val cardBgColor = if (isDarkTheme) CardDark else Color.White

    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(24.dp),
        horizontalAlignment = Alignment.CenterHorizontally
    ) {
        Spacer(modifier = Modifier.height(16.dp))

        // Skip button
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.End
        ) {
            TextButton(onClick = onComplete) {
                Text(
                    text = "Skip",
                    color = contentColor.copy(alpha = 0.6f)
                )
            }
        }

        Spacer(modifier = Modifier.height(32.dp))

        // Icon
        Box(
            modifier = Modifier
                .size(100.dp)
                .clip(CircleShape)
                .background(Blue.copy(alpha = 0.1f)),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Person,
                contentDescription = null,
                modifier = Modifier.size(50.dp),
                tint = Blue
            )
        }

        Spacer(modifier = Modifier.height(24.dp))

        Text(
            text = "Sign In (Optional)",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = contentColor,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Sign in to unlock all features including voice sharing and cross-device sync.",
            style = MaterialTheme.typography.bodyLarge,
            color = contentColor.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Benefits
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(16.dp),
            colors = CardDefaults.cardColors(containerColor = cardBgColor)
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                SignInBenefitRow(Icons.Default.Mic, "Share Your Voice", "Share cloned voices with the community")
                SignInBenefitRow(Icons.Default.Groups, "Community Voices", "Use voices shared by others")
                SignInBenefitRow(Icons.Default.CardGiftcard, "Earn Rewards", "Get listening minutes when others use your voices")
                SignInBenefitRow(Icons.Default.Cloud, "Sync Across Devices", "Your data follows you everywhere")
            }
        }

        Spacer(modifier = Modifier.weight(1f))

        // Continue without signing in
        Button(
            onClick = onComplete,
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(
                containerColor = if (isDarkTheme) Color.White else Color.Black,
                contentColor = if (isDarkTheme) Color.Black else Color.White
            )
        ) {
            Text(
                text = "Continue Without Signing In",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold
            )
        }

        Spacer(modifier = Modifier.height(24.dp))
    }
}

@Composable
private fun SignInBenefitRow(
    icon: ImageVector,
    title: String,
    subtitle: String
) {
    val isDarkTheme = isSystemInDarkTheme()
    val contentColor = if (isDarkTheme) Color.White else Color.Black

    Row(
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = Blue,
            modifier = Modifier.size(24.dp)
        )
        Column {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.SemiBold,
                color = contentColor
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = contentColor.copy(alpha = 0.6f)
            )
        }
    }
}
