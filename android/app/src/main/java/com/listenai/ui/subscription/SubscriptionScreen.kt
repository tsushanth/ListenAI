package com.listenai.ui.subscription

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.listenai.ui.theme.*
import java.text.SimpleDateFormat
import java.util.*

/**
 * Subscription/Paywall screen - shown when user clicks "Upgrade to Pro".
 *
 * Required information per Play Store Guidelines:
 * - Title of auto-renewing subscription
 * - Length of subscription
 * - Price of subscription
 * - Links to Privacy Policy and Terms of Use
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubscriptionScreen(
    onNavigateBack: () -> Unit = {}
) {
    val context = LocalContext.current
    var freeTrialEnabled by remember { mutableStateOf(true) }

    // Subscription details
    val subscriptionTitle = "ReadAloud AI Pro"
    val subscriptionLength = "Weekly"
    val weeklyPrice = "$9.99"
    val trialDays = 7

    // Legal URLs
    val privacyUrl = "https://kreativekoala.llc/privacy"
    val termsUrl = "https://kreativekoala.llc/terms"

    // Calculate due date
    val dueDateString = remember {
        val calendar = Calendar.getInstance()
        calendar.add(Calendar.DAY_OF_YEAR, trialDays)
        val formatter = SimpleDateFormat("MMMM d, yyyy", Locale.getDefault())
        "Due ${formatter.format(calendar.time)}"
    }

    val scrollState = rememberScrollState()

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(scrollState)
        ) {
            // Top bar with Close and Restore buttons
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 20.dp, vertical = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                // Close button
                IconButton(
                    onClick = onNavigateBack,
                    modifier = Modifier
                        .size(44.dp)
                        .background(
                            MaterialTheme.colorScheme.surfaceVariant,
                            CircleShape
                        )
                ) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = "Close",
                        tint = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }

                // Restore button
                TextButton(
                    onClick = {
                        Toast.makeText(context, "Checking for previous purchases...", Toast.LENGTH_SHORT).show()
                        // TODO: Implement Google Play Billing restore purchases
                    },
                    modifier = Modifier
                        .background(
                            MaterialTheme.colorScheme.surfaceVariant,
                            RoundedCornerShape(50)
                        )
                ) {
                    Text(
                        text = "Restore",
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            // Hero illustration
            HeroIllustration()

            // Title section
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 16.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = "Get Unlimited Access",
                    fontSize = 26.sp,
                    fontWeight = FontWeight.Bold,
                    color = MaterialTheme.colorScheme.onBackground
                )

                Spacer(modifier = Modifier.height(8.dp))

                Text(
                    text = "Read anything aloud in top-quality voices",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Subscription card
            SubscriptionCard(
                title = subscriptionTitle,
                subscriptionLength = subscriptionLength,
                weeklyPrice = weeklyPrice,
                trialDays = trialDays,
                modifier = Modifier
                    .padding(horizontal = 20.dp)
                    .padding(top = 20.dp)
            )

            // Free trial toggle
            FreeTrialToggle(
                enabled = freeTrialEnabled,
                onToggle = { freeTrialEnabled = it },
                modifier = Modifier
                    .padding(horizontal = 20.dp)
                    .padding(top = 16.dp)
            )

            // Pricing breakdown
            PricingBreakdown(
                freeTrialEnabled = freeTrialEnabled,
                trialDays = trialDays,
                weeklyPrice = weeklyPrice,
                dueDateString = dueDateString,
                modifier = Modifier
                    .padding(horizontal = 20.dp)
                    .padding(top = 12.dp)
            )

            Spacer(modifier = Modifier.weight(1f))

            // Bottom CTA section
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = 24.dp)
                    .padding(bottom = 24.dp),
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                // CTA Button
                Button(
                    onClick = {
                        // Start subscription/trial
                        onNavigateBack()
                    },
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(56.dp),
                    shape = RoundedCornerShape(16.dp),
                    colors = ButtonDefaults.buttonColors(
                        containerColor = Color.Black
                    )
                ) {
                    Text(
                        text = if (freeTrialEnabled) "Try for Free" else "Subscribe Now",
                        style = MaterialTheme.typography.titleMedium,
                        fontWeight = FontWeight.SemiBold,
                        color = Color.White
                    )
                }

                Spacer(modifier = Modifier.height(12.dp))

                // Subscription terms
                Text(
                    text = "Auto-renewable $subscriptionLength subscription. $weeklyPrice/week after $trialDays-day free trial. Cancel anytime.",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = 8.dp)
                )

                Spacer(modifier = Modifier.height(12.dp))

                // Footer links
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    // Terms of Use link
                    TextButton(onClick = {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(termsUrl)))
                    }) {
                        Text(
                            text = "Terms of Use",
                            style = MaterialTheme.typography.labelSmall,
                            color = Blue
                        )
                    }

                    // Secured badge
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        horizontalArrangement = Arrangement.spacedBy(4.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.Lock,
                            contentDescription = null,
                            modifier = Modifier.size(12.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Text(
                            text = "Secured with Google",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    // Privacy Policy link
                    TextButton(onClick = {
                        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(privacyUrl)))
                    }) {
                        Text(
                            text = "Privacy Policy",
                            style = MaterialTheme.typography.labelSmall,
                            color = Blue
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun HeroIllustration() {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .height(260.dp)
            .background(
                Brush.verticalGradient(
                    colors = listOf(
                        Color(0xFFFFF8E7),
                        Color(0xFFFFF2D6)
                    )
                )
            ),
        contentAlignment = Alignment.Center
    ) {
        // Waveform bars on sides
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 20.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Left waveform
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                listOf(30, 50, 70, 90, 70, 50).forEach { height ->
                    Box(
                        modifier = Modifier
                            .width(6.dp)
                            .height(height.dp)
                            .clip(RoundedCornerShape(3.dp))
                            .background(Color(0xFFFFD700))
                    )
                }
            }

            // Right waveform
            Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                listOf(50, 70, 90, 70, 50, 30).forEach { height ->
                    Box(
                        modifier = Modifier
                            .width(6.dp)
                            .height(height.dp)
                            .clip(RoundedCornerShape(3.dp))
                            .background(Color(0xFFFFD700))
                    )
                }
            }
        }

        // Phone mockup
        Box(
            modifier = Modifier
                .width(180.dp)
                .height(220.dp)
                .shadow(12.dp, RoundedCornerShape(32.dp))
                .background(
                    MaterialTheme.colorScheme.surface,
                    RoundedCornerShape(32.dp)
                )
        ) {
            // Document lines inside
            Column(
                modifier = Modifier
                    .padding(horizontal = 24.dp)
                    .padding(top = 40.dp),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                repeat(6) {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(8.dp)
                            .clip(RoundedCornerShape(2.dp))
                            .background(Color.Gray.copy(alpha = 0.2f))
                    )
                }
            }
        }

        // File type icons floating around
        FileTypeIcon(
            type = "URL",
            color = Orange,
            modifier = Modifier.offset(x = (-80).dp, y = (-60).dp)
        )
        FileTypeIcon(
            type = "DOC",
            color = Orange,
            modifier = Modifier.offset(x = 80.dp, y = (-40).dp)
        )
        FileTypeIcon(
            type = "PDF",
            color = Purple,
            modifier = Modifier.offset(x = (-90).dp, y = 20.dp)
        )
        FileTypeIcon(
            type = "ePUB",
            color = Green,
            modifier = Modifier.offset(x = 85.dp, y = 50.dp)
        )
    }
}

@Composable
private fun FileTypeIcon(
    type: String,
    color: Color,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier
            .shadow(4.dp, RoundedCornerShape(6.dp))
            .width(36.dp)
            .height(44.dp)
            .background(color, RoundedCornerShape(6.dp)),
        contentAlignment = Alignment.Center
    ) {
        Text(
            text = type,
            fontSize = 8.sp,
            fontWeight = FontWeight.Bold,
            color = Color.White
        )
    }
}

@Composable
private fun SubscriptionCard(
    title: String,
    subscriptionLength: String,
    weeklyPrice: String,
    trialDays: Int,
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier.padding(20.dp)
        ) {
            // Title row
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )

                // Subscription length badge
                Surface(
                    shape = RoundedCornerShape(6.dp),
                    color = Color(0xFFFFE4B5).copy(alpha = 0.5f)
                ) {
                    Text(
                        text = subscriptionLength,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Medium,
                        color = Orange
                    )
                }
            }

            Spacer(modifier = Modifier.height(12.dp))

            // Description
            Text(
                text = "Unlock Unlimited Listening Experience, Download and Listen Offline, Listen Any Text Document, Best AI Voices Available.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Spacer(modifier = Modifier.height(12.dp))

            // Price
            Text(
                text = "Free for $trialDays days, then $weeklyPrice/week",
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = FontWeight.Medium,
                color = MaterialTheme.colorScheme.onSurface
            )
        }
    }
}

@Composable
private fun FreeTrialToggle(
    enabled: Boolean,
    onToggle: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
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
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Text(
                text = "Free Trial Enabled",
                style = MaterialTheme.typography.bodyMedium
            )

            Switch(
                checked = enabled,
                onCheckedChange = onToggle,
                colors = SwitchDefaults.colors(
                    checkedThumbColor = Color.White,
                    checkedTrackColor = Green
                )
            )
        }
    }
}

@Composable
private fun PricingBreakdown(
    freeTrialEnabled: Boolean,
    trialDays: Int,
    weeklyPrice: String,
    dueDateString: String,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier.fillMaxWidth(),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        // Due today row
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .size(6.dp)
                        .clip(CircleShape)
                        .background(MaterialTheme.colorScheme.onBackground)
                )
                Text(
                    text = "Due today",
                    style = MaterialTheme.typography.bodyMedium
                )
            }

            Row(
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                if (freeTrialEnabled) {
                    Text(
                        text = "$trialDays days free",
                        style = MaterialTheme.typography.bodyMedium,
                        color = Green
                    )
                    Text(
                        text = "$0.00",
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                } else {
                    Text(
                        text = weeklyPrice,
                        style = MaterialTheme.typography.bodyMedium,
                        fontWeight = FontWeight.SemiBold
                    )
                }
            }
        }

        // Future charge row
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Box(
                    modifier = Modifier
                        .width(2.dp)
                        .height(20.dp)
                        .padding(start = 2.dp)
                        .background(MaterialTheme.colorScheme.onBackground)
                )
                Text(
                    text = dueDateString,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            Text(
                text = weeklyPrice,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}
