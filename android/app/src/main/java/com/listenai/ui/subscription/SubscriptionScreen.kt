package com.listenai.ui.subscription

import android.app.Activity
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
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.listenai.service.billing.BillingService
import com.listenai.ui.theme.*
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

    // Initialize billing service
    val billingService = remember { BillingService.getInstance(context) }
    val scope = rememberCoroutineScope()

    // Observe billing state
    val productDetails by billingService.productDetails.collectAsState()
    val purchaseState by billingService.purchaseState.collectAsState()
    val connectionState by billingService.connectionState.collectAsState()

    // Track selected subscription
    var selectedProductId by remember { mutableStateOf(BillingService.PRODUCT_ID_WEEKLY) }

    // Get the products
    val weeklyProduct = productDetails.firstOrNull {
        it.productId == BillingService.PRODUCT_ID_WEEKLY
    }
    val yearlyProduct = productDetails.firstOrNull {
        it.productId == BillingService.PRODUCT_ID_YEARLY
    }

    val selectedProduct = if (selectedProductId == BillingService.PRODUCT_ID_WEEKLY) {
        weeklyProduct
    } else {
        yearlyProduct
    }

    // Get localized price from Google Play, fallback to loading text
    val weeklyPrice = weeklyProduct?.subscriptionOfferDetails
        ?.firstOrNull()
        ?.pricingPhases
        ?.pricingPhaseList
        ?.firstOrNull()
        ?.formattedPrice
        ?: "Loading..."

    val yearlyPrice = yearlyProduct?.subscriptionOfferDetails
        ?.firstOrNull()
        ?.pricingPhases
        ?.pricingPhaseList
        ?.firstOrNull()
        ?.formattedPrice
        ?: "Loading..."

    val freeTrialEnabled = selectedProduct?.subscriptionOfferDetails
        ?.firstOrNull()
        ?.pricingPhases
        ?.pricingPhaseList
        ?.firstOrNull()
        ?.priceAmountMicros == 0L

    // Subscription details
    val subscriptionTitle = "ReadAloud AI Pro"
    val subscriptionLength = "Weekly"
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

    // Handle purchase state
    LaunchedEffect(purchaseState) {
        when (purchaseState) {
            is BillingService.PurchaseState.Purchased -> {
                Toast.makeText(context, "Subscription activated!", Toast.LENGTH_LONG).show()
                onNavigateBack()
            }
            is BillingService.PurchaseState.Error -> {
                val error = (purchaseState as BillingService.PurchaseState.Error).message
                Toast.makeText(context, "Error: $error", Toast.LENGTH_LONG).show()
            }
            else -> {}
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
                                val restored = billingService.restorePurchases()
                                if (restored) {
                                    Toast.makeText(context, "Subscription restored!", Toast.LENGTH_LONG).show()
                                    onNavigateBack()
                                } else {
                                    Toast.makeText(context, "No active subscriptions found", Toast.LENGTH_SHORT).show()
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
                    SubscriptionOption(
                        title = "Weekly",
                        price = weeklyPrice,
                        isSelected = selectedProductId == BillingService.PRODUCT_ID_WEEKLY,
                        onClick = { selectedProductId = BillingService.PRODUCT_ID_WEEKLY },
                        modifier = Modifier.weight(1f)
                    )

                    // Yearly option
                    SubscriptionOption(
                        title = "Yearly",
                        price = yearlyPrice,
                        badge = "Best Value",
                        isSelected = selectedProductId == BillingService.PRODUCT_ID_YEARLY,
                        onClick = { selectedProductId = BillingService.PRODUCT_ID_YEARLY },
                        modifier = Modifier.weight(1f)
                    )
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
                    val selectedPrice = if (selectedProductId == BillingService.PRODUCT_ID_WEEKLY) weeklyPrice else yearlyPrice
                    val selectedPeriod = if (selectedProductId == BillingService.PRODUCT_ID_WEEKLY) "week" else "year"

                    if (freeTrialEnabled) {
                        Text(
                            text = "Free Trial",
                            style = MaterialTheme.typography.displaySmall,
                            fontWeight = FontWeight.Bold,
                            color = Purple
                        )
                        Text(
                            text = "$trialDays days free, then $selectedPrice/$selectedPeriod",
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

                            if (selectedProduct == null) {
                                Toast.makeText(context, "Product not available yet", Toast.LENGTH_SHORT).show()
                                return@Button
                            }

                            // Launch billing flow with Google Play
                            billingService.launchPurchaseFlow(activity, selectedProduct)
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(56.dp),
                        shape = RoundedCornerShape(16.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = Color.Black
                        ),
                        enabled = selectedProduct != null &&
                                  connectionState is BillingService.ConnectionState.Connected &&
                                  purchaseState !is BillingService.PurchaseState.Purchasing
                    ) {
                        if (purchaseState is BillingService.PurchaseState.Purchasing) {
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
                    val selectedSubscriptionLength = if (selectedProductId == BillingService.PRODUCT_ID_WEEKLY) "Weekly" else "Yearly"
                    Text(
                        text = "Auto-renewable $selectedSubscriptionLength subscription. $selectedPrice/$selectedPeriod" +
                               if (freeTrialEnabled) " after $trialDays-day free trial." else "." +
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

            // Loading overlay when connection not ready
            if (connectionState !is BillingService.ConnectionState.Connected) {
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
                            text = when (connectionState) {
                                is BillingService.ConnectionState.Connecting -> "Connecting to Google Play..."
                                is BillingService.ConnectionState.Error -> {
                                    val error = (connectionState as BillingService.ConnectionState.Error).message
                                    "Error: $error"
                                }
                                else -> "Loading..."
                            },
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
