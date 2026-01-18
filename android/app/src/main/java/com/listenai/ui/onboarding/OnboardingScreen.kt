package com.listenai.ui.onboarding

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
import com.listenai.data.models.VoicePreset
import com.listenai.ui.theme.*

// Theme colors for onboarding
private val WarmBackground = Color(0xFFFFF8E7)
private val WarmBackgroundLight = Color(0xFFFFF5E0)

@Composable
fun OnboardingScreen(
    onboardingManager: OnboardingManager,
    onComplete: () -> Unit
) {
    val currentPage by onboardingManager.currentPage.collectAsState()

    Box(
        modifier = Modifier
            .fillMaxSize()
            .background(
                Brush.verticalGradient(
                    colors = listOf(WarmBackground, WarmBackgroundLight, Color.White)
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
                            onboardingManager.completeOnboarding()
                            onComplete()
                        }
                    )
                }
            }

            // Page indicator and continue button
            if (currentPage != OnboardingPage.PAYWALL) {
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
                    tint = Color.Black
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
                            if (page == currentPage) Color.Black
                            else Color.Black.copy(alpha = 0.2f)
                        )
                )
            }
        }

        // Skip button
        if (currentPage.showsSkipButton) {
            TextButton(onClick = onSkip) {
                Text("Skip", color = Color.Black.copy(alpha = 0.6f))
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
                containerColor = Color.Black
            )
        ) {
            Text(
                text = if (currentPage == OnboardingPage.VOICE_SELECTION) "Continue" else "Next",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold
            )
        }

        // Terms text
        if (currentPage == OnboardingPage.WELCOME) {
            Text(
                text = "By continuing, you agree to our Privacy Policy and Terms of Use.",
                style = MaterialTheme.typography.bodySmall,
                color = Color.Black.copy(alpha = 0.5f),
                textAlign = TextAlign.Center
            )
        }
    }
}

// MARK: - Welcome Page

@Composable
private fun WelcomePage() {
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
                .background(Color.Black),
            contentAlignment = Alignment.Center
        ) {
            Icon(
                imageVector = Icons.Default.Headphones,
                contentDescription = null,
                modifier = Modifier.size(60.dp),
                tint = Color.White
            )
        }

        Spacer(modifier = Modifier.height(32.dp))

        Text(
            text = "Welcome to",
            style = MaterialTheme.typography.headlineMedium,
            color = Color.Black.copy(alpha = 0.6f)
        )

        Text(
            text = "ListenAI",
            style = MaterialTheme.typography.displayMedium,
            fontWeight = FontWeight.Bold,
            color = Color.Black
        )

        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = "Transform any document into natural-sounding audio. Listen to articles, PDFs, and more on the go.",
            style = MaterialTheme.typography.bodyLarge,
            color = Color.Black.copy(alpha = 0.7f),
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
    Surface(
        shape = RoundedCornerShape(20.dp),
        color = Color.Black.copy(alpha = 0.08f)
    ) {
        Text(
            text = text,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            style = MaterialTheme.typography.labelMedium,
            fontWeight = FontWeight.Medium,
            color = Color.Black
        )
    }
}

// MARK: - Document to Audio Page

@Composable
private fun DocumentToAudioPage() {
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
            color = Color.Black,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Paste a link, upload a PDF, or type text directly",
            style = MaterialTheme.typography.bodyLarge,
            color = Color.Black.copy(alpha = 0.7f),
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
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(Color.White)
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
                color = Color.Black
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = Color.Black.copy(alpha = 0.6f)
            )
        }
    }
}

// MARK: - Take Notes Page

@Composable
private fun TakeNotesPage() {
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
            color = Color.Black,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Capture key insights without interrupting playback",
            style = MaterialTheme.typography.bodyLarge,
            color = Color.Black.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(48.dp))

        // Mock playback UI with notes
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = Color.White)
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
                    Icon(Icons.Default.SkipPrevious, contentDescription = null, modifier = Modifier.size(32.dp))
                    Box(
                        modifier = Modifier
                            .size(64.dp)
                            .clip(CircleShape)
                            .background(Color.Black),
                        contentAlignment = Alignment.Center
                    ) {
                        Icon(Icons.Default.Pause, contentDescription = null, tint = Color.White, modifier = Modifier.size(32.dp))
                    }
                    Icon(Icons.Default.SkipNext, contentDescription = null, modifier = Modifier.size(32.dp))
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
                        .background(Color.Black.copy(alpha = 0.05f))
                        .padding(12.dp),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        Icons.Default.Edit,
                        contentDescription = null,
                        tint = Color.Black.copy(alpha = 0.5f)
                    )
                    Text(
                        text = "Add a note at 2:34...",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Color.Black.copy(alpha = 0.5f)
                    )
                }
            }
        }
    }
}

// MARK: - Productivity Page

@Composable
private fun ProductivityPage() {
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
            color = Color.Black,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Natural voices and adjustable speed for efficient learning",
            style = MaterialTheme.typography.bodyLarge,
            color = Color.Black.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(48.dp))

        // Speed selector
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = Color.White)
        ) {
            Column(
                modifier = Modifier.padding(20.dp),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                Text(
                    text = "Playback Speed",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
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
    Surface(
        shape = RoundedCornerShape(12.dp),
        color = if (isSelected) Color.Black else Color.Black.copy(alpha = 0.05f)
    ) {
        Text(
            text = speed,
            modifier = Modifier.padding(horizontal = 16.dp, vertical = 10.dp),
            style = MaterialTheme.typography.labelLarge,
            fontWeight = FontWeight.SemiBold,
            color = if (isSelected) Color.White else Color.Black
        )
    }
}

@Composable
private fun FeatureRow(icon: ImageVector, text: String) {
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
            color = Color.Black
        )
    }
}

// MARK: - Voice Selection Page

@Composable
private fun VoiceSelectionPage(
    onVoiceSelected: (String) -> Unit
) {
    var selectedVoiceId by remember { mutableStateOf<String?>(null) }

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
            color = Color.Black,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Pick a voice that suits your listening style",
            style = MaterialTheme.typography.bodyLarge,
            color = Color.Black.copy(alpha = 0.7f),
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
                    onSelect = {
                        selectedVoiceId = voice.id
                        onVoiceSelected(voice.id)
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
    onSelect: () -> Unit
) {
    val borderColor = if (isSelected) Blue else Color.Transparent

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
            containerColor = if (isSelected) Blue.copy(alpha = 0.1f) else Color.White
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.spacedBy(16.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Avatar
            Box(
                modifier = Modifier
                    .size(48.dp)
                    .clip(CircleShape)
                    .background(Blue.copy(alpha = 0.2f)),
                contentAlignment = Alignment.Center
            ) {
                Text(
                    text = voice.name.take(2).uppercase(),
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.Bold,
                    color = Blue
                )
            }

            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = voice.name,
                    style = MaterialTheme.typography.bodyLarge,
                    fontWeight = FontWeight.SemiBold
                )
                Text(
                    text = "${voice.style.name.lowercase().replaceFirstChar { it.uppercase() }} - ${voice.gender.name.lowercase().replaceFirstChar { it.uppercase() }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color.Black.copy(alpha = 0.6f)
                )
            }

            // Play preview button
            IconButton(onClick = { /* TODO: Play voice sample */ }) {
                Icon(
                    imageVector = Icons.Default.PlayCircle,
                    contentDescription = "Preview voice",
                    tint = if (isSelected) Blue else Color.Black.copy(alpha = 0.5f)
                )
            }

            if (isSelected) {
                Icon(
                    imageVector = Icons.Default.CheckCircle,
                    contentDescription = "Selected",
                    tint = Blue
                )
            }
        }
    }
}

// MARK: - Paywall Page

@Composable
private fun PaywallPage(
    onComplete: () -> Unit
) {
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
            text = "Unlock ListenAI Pro",
            style = MaterialTheme.typography.headlineMedium,
            fontWeight = FontWeight.Bold,
            color = Color.Black,
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(8.dp))

        Text(
            text = "Get unlimited access to all premium features",
            style = MaterialTheme.typography.bodyLarge,
            color = Color.Black.copy(alpha = 0.7f),
            textAlign = TextAlign.Center
        )

        Spacer(modifier = Modifier.height(32.dp))

        // Features
        Card(
            modifier = Modifier.fillMaxWidth(),
            shape = RoundedCornerShape(20.dp),
            colors = CardDefaults.cardColors(containerColor = Color.White)
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
                    text = "$9.99/week",
                    style = MaterialTheme.typography.headlineSmall,
                    fontWeight = FontWeight.Bold,
                    color = Purple
                )
                Text(
                    text = "7-day free trial, then $9.99/week",
                    style = MaterialTheme.typography.bodySmall,
                    color = Color.Black.copy(alpha = 0.6f)
                )
            }
        }

        Spacer(modifier = Modifier.height(16.dp))

        // Subscribe button
        Button(
            onClick = { /* TODO: Start subscription */ },
            modifier = Modifier
                .fillMaxWidth()
                .height(56.dp),
            shape = RoundedCornerShape(16.dp),
            colors = ButtonDefaults.buttonColors(containerColor = Purple)
        ) {
            Text(
                text = "Start Free Trial",
                fontSize = 16.sp,
                fontWeight = FontWeight.SemiBold
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Skip button
        TextButton(onClick = onComplete) {
            Text(
                text = "Maybe Later",
                color = Color.Black.copy(alpha = 0.5f)
            )
        }

        Spacer(modifier = Modifier.height(8.dp))

        // Terms
        Text(
            text = "By subscribing, you agree to our Terms of Use and Privacy Policy. Subscription auto-renews weekly until cancelled.",
            style = MaterialTheme.typography.labelSmall,
            color = Color.Black.copy(alpha = 0.4f),
            textAlign = TextAlign.Center
        )
    }
}

@Composable
private fun ProFeatureRow(text: String) {
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
            color = Color.Black
        )
    }
}
