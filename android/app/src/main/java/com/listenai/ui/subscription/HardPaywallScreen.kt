package com.listenai.ui.subscription

import android.app.Activity
import android.content.Intent
import android.net.Uri
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import com.kreativekoala.paywallkit.models.PaywallFeature
import com.kreativekoala.paywallkit.models.PaywallProduct
import com.kreativekoala.paywallkit.models.PaywallTheme
import com.kreativekoala.paywallkit.view.PaywallView
import com.listenai.service.billing.RevenueCatManager
import com.listenai.service.billing.hasFreeTrial
import com.revenuecat.purchases.PackageType
import kotlinx.coroutines.launch

/**
 * Hard paywall — non-dismissible, only exits when user subscribes.
 */
@Composable
fun HardPaywallScreen(
    onSubscribed: () -> Unit
) {
    // Intercept back — cannot dismiss
    BackHandler(enabled = true) {}

    val revenueCatManager = remember { RevenueCatManager.getInstance() }
    val packages by revenueCatManager.packages.collectAsState()
    val isPremium by revenueCatManager.isPremium.collectAsState()
    val context = LocalContext.current
    val activity = context as? Activity
    val scope = rememberCoroutineScope()

    LaunchedEffect(isPremium) {
        if (isPremium) onSubscribed()
    }

    if (packages.isEmpty()) {
        Box(
            modifier = Modifier.fillMaxSize().background(Color(0xFF0A0A0F)),
            contentAlignment = Alignment.Center
        ) {
            CircularProgressIndicator(color = Color(0xFF6C63FF))
        }
        return
    }

    val paywallProducts = packages.map { pkg ->
        PaywallProduct(
            id = pkg.product.id,
            localizedPrice = pkg.product.price.formatted,
            price = pkg.product.price.amountMicros / 1_000_000.0,
            currencyCode = pkg.product.price.currencyCode,
            trialDays = if (pkg.hasFreeTrial) 3 else null,
            period = when (pkg.packageType) {
                PackageType.WEEKLY -> PaywallProduct.Period.WEEKLY
                PackageType.MONTHLY -> PaywallProduct.Period.MONTHLY
                PackageType.ANNUAL -> PaywallProduct.Period.YEARLY
                else -> PaywallProduct.Period.MONTHLY
            }
        )
    }

    PaywallView(
        appId = "readaloudai",
        appName = "ReadAloud AI",
        features = listOf(
            PaywallFeature("\uD83D\uDD0A", "Unlimited Listening", "Listen without limits"),
            PaywallFeature("\uD83C\uDF99\uFE0F", "Premium Voices", "Natural AI voices"),
            PaywallFeature("\uD83D\uDCC4", "Any Document", "PDF, ePub, web pages"),
            PaywallFeature("\u26A1", "Speed Controls", "Adjust playback speed"),
            PaywallFeature("\uD83D\uDCE5", "Offline Mode", "Download for offline")
        ),
        products = paywallProducts,
        theme = PaywallTheme(accent = Color(0xFF6C63FF), accent2 = Color(0xFF9C27B0)),
        showWinback = false,
        isDismissible = false,
        onPurchase = { productId ->
            val pkg = packages.firstOrNull { it.product.id == productId }
            if (pkg != null && activity != null) {
                scope.launch { revenueCatManager.purchase(activity, pkg) }
            }
        },
        onRestore = {
            scope.launch { revenueCatManager.restorePurchases() }
        },
        onRedeemCode = {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/redeem?code=promo-1month-free"))
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            try { activity?.startActivity(intent) } catch (_: Exception) {}
        },
        onDismiss = { /* non-dismissible */ }
    )
}
