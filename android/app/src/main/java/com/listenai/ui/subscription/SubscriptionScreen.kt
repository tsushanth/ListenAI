package com.listenai.ui.subscription

import androidx.compose.foundation.layout.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.listenai.service.billing.RevenueCatManager
import com.revenuecat.purchases.ui.revenuecatui.Paywall
import com.revenuecat.purchases.ui.revenuecatui.PaywallOptions

/**
 * Subscription/Paywall screen - uses RevenueCat's dashboard-configured paywall.
 * Shown from Settings or any "Upgrade" entry point.
 */
@Composable
fun SubscriptionScreen(
    onNavigateBack: () -> Unit = {},
    onPurchaseComplete: (() -> Unit)? = null
) {
    val revenueCatManager = remember { RevenueCatManager.getInstance() }
    val isPremium by revenueCatManager.isPremium.collectAsState()
    val wasPremiumOnOpen = remember { isPremium }

    // If user becomes premium during this screen (new purchase), navigate away
    LaunchedEffect(isPremium) {
        if (isPremium && !wasPremiumOnOpen) {
            if (onPurchaseComplete != null) {
                onPurchaseComplete()
            } else {
                onNavigateBack()
            }
        }
    }

    // Use RevenueCat's dashboard-configured paywall
    Box(modifier = Modifier.fillMaxSize()) {
        Paywall(
            options = PaywallOptions.Builder(dismissRequest = { onNavigateBack() })
                .setShouldDisplayDismissButton(true)
                .build()
        )
    }
}
