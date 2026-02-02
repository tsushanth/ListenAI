package com.listenai.ui.subscription

import android.content.Intent
import android.net.Uri
import android.widget.Toast
import androidx.activity.ComponentActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.listenai.service.billing.RevenueCatManager
import com.listenai.service.billing.displayDescription
import com.listenai.service.billing.hasFreeTrial
import com.listenai.service.billing.freeTrialDuration
import com.listenai.ui.theme.*
import com.revenuecat.purchases.Package
import com.revenuecat.purchases.PackageType
import kotlinx.coroutines.launch
import java.text.SimpleDateFormat
import java.util.*

/**
 * Subscription/Paywall screen - shown when user clicks "Upgrade to Pro".
 *
 * Required information per Play Store Guidelines:
 * - Title of auto-renewing subscription
 * - Length of subscription
 * - Price of subscription (LOCALIZED from Google Play)
 * - Links to Privacy Policy and Terms of Use
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SubscriptionScreen(
    onNavigateBack: () -> Unit = {}
) {
    val context = LocalContext.current
    val activity = context as? ComponentActivity

    // Use RevenueCat manager
    val revenueCatManager = remember { RevenueCatManager.getInstance() }
    val scope = rememberCoroutineScope()

    // Observe RevenueCat state
    val packages by revenueCatManager.packages.collectAsState()
    val isPremium by revenueCatManager.isPremium.collectAsState()
    val isLoading by revenueCatManager.isLoading.collectAsState()
    val errorMessage by revenueCatManager.errorMessage.collectAsState()

    // Track selected package type
    var selectedPackageType by remember { mutableStateOf(PackageType.WEEKLY) }

    // Get the packages
    val weeklyPackage = packages.find { it.packageType == PackageType.WEEKLY }
    val yearlyPackage = packages.find { it.packageType == PackageType.ANNUAL }
    val monthlyPackage = packages.find { it.packageType == PackageType.MONTHLY }

    // Use yearly if no weekly available
    val availablePackages = listOfNotNull(weeklyPackage, yearlyPackage, monthlyPackage)

    val selectedPackage: Package? = when (selectedPackageType) {
        PackageType.WEEKLY -> weeklyPackage
        PackageType.ANNUAL -> yearlyPackage
        PackageType.MONTHLY -> monthlyPackage
        else -> weeklyPackage ?: yearlyPackage
    }

    // Get localized prices
    val weeklyPrice = weeklyPackage?.product?.price?.formatted ?: "Loading..."
    val yearlyPrice = yearlyPackage?.product?.price?.formatted ?: "Loading..."
    val monthlyPrice = monthlyPackage?.product?.price?.formatted ?: "Loading..."

    val freeTrialEnabled = selectedPackage?.hasFreeTrial == true
    val trialDuration = selectedPackage?.freeTrialDuration

    // Subscription details
    val subscriptionTitle = "ReadAloud AI Pro"

    // Legal URLs
    val privacyUrl = "https://kreativekoala.llc/privacy"
    val termsUrl = "https://kreativekoala.llc/terms"

    // Calculate due date for trial
    val dueDateString = remember(trialDuration) {
        val calendar = Calendar.getInstance()
        calendar.add(Calendar.DAY_OF_YEAR, 7) // Default 7 days
        val formatter = SimpleDateFormat("MMMM d, yyyy", Locale.getDefault())
        "Due ${formatter.format(calendar.time)}"
    }

    val scrollState = rememberScrollState()

    // Handle errors
    LaunchedEffect(errorMessage) {
        errorMessage?.let { error ->
            Toast.makeText(context, error, Toast.LENGTH_LONG).show()
            revenueCatManager.clearError()
        }
    }

    // Navigate back if user became premium
    LaunchedEffect(isPremium) {
        if (isPremium) {
            Toast.makeText(context, "Welcome to Pro!", Toast.LENGTH_LONG).show()
            onNavigateBack()
        }
    }

    // Load offerings on first composition
    LaunchedEffect(Unit) {
        if (packages.isEmpty()) {
            revenueCatManager.loadOfferings()
        }
    }

    Scaffold(
        containerColor = MaterialTheme.colorScheme.background
    ) { paddingValues ->
        Box(modifier = Modifier.fillMaxSize()) {
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
                            scope.launch {
                                Toast.makeText(context, "Checking for previous purchases...", Toast.LENGTH_SHORT).show()
                                val result = revenueCatManager.restorePurchases()
                                result.onFailure { error ->
                                    if (error.message != "No active subscription found") {
                                        Toast.makeText(context, error.message, Toast.LENGTH_SHORT).show()
                                    }
                                }
                            }
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

                Spacer(modifier = Modifier.height(8.dp))

                // Lock icon
                Box(
                    modifier = Modifier
                        .size(80.dp)
                        .clip(CircleShape)
                        .background(
                            brush = Brush.verticalGradient(
                                colors = listOf(
                                    Purple.copy(alpha = 0.3f),
                                    Purple.copy(alpha = 0.1f)
                                )
                            )
                        )
                        .align(Alignment.CenterHorizontally),
                    contentAlignment = Alignment.Center
                ) {
                    Icon(
                        imageVector = Icons.Default.Lock,
                        contentDescription = null,
                        modifier = Modifier.size(40.dp),
                        tint = Purple
                    )
                }

                Spacer(modifier = Modifier.height(20.dp))

                // Title
                Text(
                    text = subscriptionTitle,
                    style = MaterialTheme.typography.headlineMedium,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp)
                )

                Spacer(modifier = Modifier.height(32.dp))

                // Subscription plan selector
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp)
                ) {
                    // Weekly option
                    if (weeklyPackage != null) {
                        SubscriptionOption(
                            title = "Weekly",
                            price = weeklyPrice,
                            isSelected = selectedPackageType == PackageType.WEEKLY,
                            onClick = { selectedPackageType = PackageType.WEEKLY },
                            modifier = Modifier.weight(1f)
                        )
                    }

                    // Yearly option
                    if (yearlyPackage != null) {
                        SubscriptionOption(
                            title = "Yearly",
                            price = yearlyPrice,
                            badge = "Best Value",
                            isSelected = selectedPackageType == PackageType.ANNUAL,
                            onClick = { selectedPackageType = PackageType.ANNUAL },
                            modifier = Modifier.weight(1f)
                        )
                    }
                }

                Spacer(modifier = Modifier.height(32.dp))

                // Features list
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 32.dp),
                    verticalArrangement = Arrangement.spacedBy(16.dp)
                ) {
                    FeatureItem("Unlimited listening", Purple)
                    FeatureItem("All premium voices", Purple)
                    FeatureItem("Offline downloads", Purple)
                    FeatureItem("No ads", Purple)
                    FeatureItem("Priority support", Purple)
                }

                Spacer(modifier = Modifier.weight(1f))

                // Bottom CTA section
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = 24.dp)
                        .padding(bottom = 24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    // Pricing info
                    val selectedPrice = selectedPackage?.product?.price?.formatted ?: "..."
                    val selectedPeriod = when (selectedPackageType) {
                        PackageType.WEEKLY -> "week"
                        PackageType.ANNUAL -> "year"
                        PackageType.MONTHLY -> "month"
                        else -> "week"
                    }

                    if (freeTrialEnabled && trialDuration != null) {
                        Text(
                            text = "Free Trial",
                            style = MaterialTheme.typography.displaySmall,
                            fontWeight = FontWeight.Bold,
                            color = Purple
                        )
                        Text(
                            text = "$trialDuration free, then $selectedPrice/$selectedPeriod",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            textAlign = TextAlign.Center
                        )
                        Text(
                            text = dueDateString,
                            style = MaterialTheme.typography.labelMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    } else {
                        Text(
                            text = selectedPrice,
                            style = MaterialTheme.typography.displaySmall,
                            fontWeight = FontWeight.Bold,
                            color = Purple
                        )
                        Text(
                            text = "per $selectedPeriod",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }

                    Spacer(modifier = Modifier.height(16.dp))

                    // CTA Button
                    Button(
                        onClick = {
                            if (activity == null) {
                                Toast.makeText(context, "Unable to start purchase", Toast.LENGTH_SHORT).show()
                                return@Button
                            }

                            val pkg = selectedPackage
                            if (pkg == null) {
                                Toast.makeText(context, "Product not available yet", Toast.LENGTH_SHORT).show()
                                return@Button
                            }

                            // Launch purchase with RevenueCat
                            scope.launch {
                                revenueCatManager.purchase(activity, pkg)
                            }
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp),
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color.Black
                        ),
                        enabled = selectedPackage != null && !isLoading
                    ) {
                        if (isLoading) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(24.dp),
                                color = Color.White
                            )
                        } else {
                            Text(
                                text = if (freeTrialEnabled) "Try for Free" else "Subscribe Now",
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                color = Color.White
                            )
                        }
                    }

                    Spacer(modifier = Modifier.height(12.dp))

                    // Subscription terms
                    val selectedSubscriptionLength = when (selectedPackageType) {
                        PackageType.WEEKLY -> "Weekly"
                        PackageType.ANNUAL -> "Yearly"
                        PackageType.MONTHLY -> "Monthly"
                        else -> "Weekly"
                    }
                    val selectedPrice2 = selectedPackage?.product?.price?.formatted ?: "..."
                    val selectedPeriod2 = when (selectedPackageType) {
                        PackageType.WEEKLY -> "week"
                        PackageType.ANNUAL -> "year"
                        PackageType.MONTHLY -> "month"
                        else -> "week"
                    }
                    Text(
                        text = "Auto-renewable $selectedSubscriptionLength subscription. $selectedPrice2/$selectedPeriod2" +
                               if (freeTrialEnabled && trialDuration != null) " after $trialDuration free trial." else "." +
                               " Cancel anytime.",
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
                        TextButton(onClick = {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(termsUrl)))
                        }) {
                            Text(
                                text = "Terms of Use",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                            )
                        }

                        Text(
                            text = "•",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                        )

                        TextButton(onClick = {
                            // Open Google Play subscription management
                            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(
                                "https://play.google.com/store/account/subscriptions?package=${context.packageName}"
                            ))
                            context.startActivity(intent)
                        }) {
                            Text(
                                text = "Manage Subscriptions",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                            )
                        }

                        Text(
                            text = "•",
                            style = MaterialTheme.typography.labelSmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f)
                        )

                        TextButton(onClick = {
                            context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(privacyUrl)))
                        }) {
                            Text(
                                text = "Privacy Policy",
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f)
                            )
                        }
                    }
                }
            }

            // Loading overlay when packages not loaded
            if (packages.isEmpty() && isLoading) {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .background(MaterialTheme.colorScheme.background.copy(alpha = 0.8f)),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        CircularProgressIndicator()
                        Text(
                            text = "Loading subscription options...",
                            style = MaterialTheme.typography.bodyMedium
                        )
                    }
                }
            }
        }
    }
}

@Composable
private fun SubscriptionOption(
    title: String,
    price: String,
    isSelected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    badge: String? = null
) {
    Card(
        modifier = modifier
            .clickable(onClick = onClick),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (isSelected) Purple.copy(alpha = 0.15f) else MaterialTheme.colorScheme.surfaceVariant
        ),
        border = if (isSelected) {
            androidx.compose.foundation.BorderStroke(2.dp, Purple)
        } else null
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            if (badge != null) {
                Surface(
                    shape = RoundedCornerShape(4.dp),
                    color = Green
                ) {
                    Text(
                        text = badge,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 4.dp),
                        style = MaterialTheme.typography.labelSmall,
                        fontWeight = FontWeight.Bold,
                        color = Color.White
                    )
                }
                Spacer(modifier = Modifier.height(4.dp))
            }

            Text(
                text = title,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = price,
                style = MaterialTheme.typography.bodyLarge,
                fontWeight = FontWeight.Bold,
                color = if (isSelected) Purple else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun FeatureItem(text: String, color: Color) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.Start
    ) {
        Box(
            modifier = Modifier
                .size(24.dp)
                .clip(CircleShape)
                .background(color.copy(alpha = 0.15f)),
            contentAlignment = Alignment.Center
        ) {
            Box(
                modifier = Modifier
                    .size(8.dp)
                    .clip(CircleShape)
                    .background(color)
            )
        }
        Spacer(modifier = Modifier.width(12.dp))
        Text(
            text = text,
            style = MaterialTheme.typography.bodyLarge,
            fontWeight = FontWeight.Medium
        )
    }
}
