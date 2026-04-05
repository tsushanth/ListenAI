package com.listenai.ui.subscription

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import com.listenai.service.billing.RevenueCatManager
import com.revenuecat.purchases.ui.revenuecatui.Paywall
import com.revenuecat.purchases.ui.revenuecatui.PaywallOptions

/**
 * A hard paywall screen that cannot be dismissed.
 * - No close/dismiss button
 * - Back button is intercepted and does nothing
 * - Only dismisses when the user successfully subscribes (becomes premium)
 */
@Composable
fun HardPaywallScreen(
    onSubscribed: () -> Unit
) {
    val revenueCatManager = remember { RevenueCatManager.getInstance() }
    val isPremium by revenueCatManager.isPremium.collectAsState()

    // Dismiss paywall when user becomes premium
    LaunchedEffect(isPremium) {
        if (isPremium) {
            onSubscribed()
        }
    }

    // Intercept back button - do nothing (cannot dismiss)
    BackHandler(enabled = true) {
        // Intentionally empty - hard paywall cannot be dismissed
    }

    Box(modifier = Modifier.fillMaxSize()) {
        Paywall(
            options = PaywallOptions.Builder(dismissRequest = {
                // Do nothing - hard paywall cannot be dismissed
            })
                .setShouldDisplayDismissButton(false)
                .build()
        )
    }
}
