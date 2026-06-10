package com.listenai

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import com.kreativekoala.paywallkit.manager.PromoCodeManager
import android.util.Log
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.lifecycle.lifecycleScope
import com.listenai.service.AppOpenTracker
import com.listenai.service.auth.GoogleAuthService
import com.listenai.service.billing.RevenueCatManager
import com.listenai.ui.MainScreen
import com.listenai.ui.onboarding.OnboardingManager
import com.listenai.ui.onboarding.OnboardingScreen
import com.listenai.ui.theme.ListenAITheme
import com.kreativekoala.paywallkit.models.PaywallFeature
import com.kreativekoala.paywallkit.models.PaywallProduct
import com.kreativekoala.paywallkit.models.PaywallTheme
import com.kreativekoala.paywallkit.view.PaywallView
import com.kreativekoala.ratingkit.RatingKit
import com.revenuecat.purchases.PackageType
import kotlinx.coroutines.launch
import org.koin.android.ext.android.inject

class MainActivity : AppCompatActivity() {

    private lateinit var onboardingManager: OnboardingManager
    private val authService: GoogleAuthService by inject()

    /** Tracks whether the soft paywall should be shown */
    private var showPaywall by mutableStateOf(false)

    /** Tracks whether the user dismissed the paywall this session */
    private var paywallDismissed by mutableStateOf(false)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        PromoCodeManager.handleIntent(intent)
        enableEdgeToEdge()

        // Track app open for RatingKit
        RatingKit.trackAppOpen(this)

        // Fire RatingKit's purchase peak whenever isPremium flips true during
        // this session — catches every paywall path (onboarding, soft, hard,
        // settings). Skip the initial emission so already-subscribed users
        // don't get re-prompted on every cold start.
        lifecycleScope.launch {
            var first = true
            RevenueCatManager.getInstance().isPremium.collect { premium ->
                if (premium && !first) {
                    RatingKit.trackPurchase(this@MainActivity)
                }
                first = false
            }
        }

        // Initialize onboarding manager
        onboardingManager = OnboardingManager.getInstance(this)

        // Increment app open count (once per session/cold start)
        val openCount = AppOpenTracker.incrementOpenCount()
        Log.d("MainActivity", "App open count: $openCount / ${AppOpenTracker.FREE_OPEN_LIMIT}")

        // Check if we need to show the paywall
        val revenueCatManager = RevenueCatManager.getInstance()
        if (AppOpenTracker.hasExceededFreeLimit() && !revenueCatManager.isPremium.value) {
            showPaywall = true
        }

        // Handle OAuth redirect if launched from browser
        handleOAuthRedirect(intent)

        setContent {
            ListenAITheme {
                val hasCompletedOnboarding by onboardingManager.hasCompletedOnboarding.collectAsState()
                val isPremium by revenueCatManager.isPremium.collectAsState()
                val packages by revenueCatManager.packages.collectAsState()

                // Dismiss paywall if user becomes premium
                if (isPremium && showPaywall) {
                    showPaywall = false
                }

                Surface(
                    modifier = Modifier.fillMaxSize(),
                    color = MaterialTheme.colorScheme.background
                ) {
                    when {
                        // Soft paywall after free limit exceeded
                        showPaywall && !paywallDismissed -> {
                            // Wait for products to load
                            if (packages.isEmpty()) {
                                Box(
                                    modifier = Modifier
                                        .fillMaxSize()
                                        .background(Color(0xFF0A0A0F)),
                                    contentAlignment = Alignment.Center
                                ) {
                                    CircularProgressIndicator(color = Color(0xFF6C63FF))
                                }
                            } else {
                                // Map RevenueCat packages to PaywallKit products
                                val paywallProducts = packages.map { pkg ->
                                    PaywallProduct(
                                        id = pkg.product.id,
                                        localizedPrice = pkg.product.price.formatted,
                                        price = pkg.product.price.amountMicros / 1_000_000.0,
                                        currencyCode = pkg.product.price.currencyCode,
                                        trialDays = 3,
                                        period = when (pkg.packageType) {
                                            PackageType.WEEKLY -> PaywallProduct.Period.WEEKLY
                                            PackageType.MONTHLY -> PaywallProduct.Period.MONTHLY
                                            PackageType.ANNUAL -> PaywallProduct.Period.YEARLY
                                            else -> PaywallProduct.Period.MONTHLY
                                        }
                                    )
                                }

                                val features = listOf(
                                    PaywallFeature("\uD83D\uDD0A", "Unlimited Listening", "Listen without limits"),
                                    PaywallFeature("\uD83C\uDF99\uFE0F", "Premium Voices", "Natural AI voices"),
                                    PaywallFeature("\uD83D\uDCC4", "Any Document", "PDF, ePub, web pages"),
                                    PaywallFeature("\u26A1", "Speed Controls", "Adjust playback speed"),
                                    PaywallFeature("\uD83D\uDCE5", "Offline Mode", "Download for offline")
                                )

                                val activity = this@MainActivity as Activity

                                PaywallView(
                                    appId = "readaloudai",
                                    placement = if (com.kreativekoala.paywallkit.manager.PromoCodeManager.activeCode != null) "promo_code_onboarding" else "onboarding",
                                    appName = "ReadAloud AI",
                                    features = features,
                                    products = paywallProducts,
                                    theme = PaywallTheme(
                                        accent = Color(0xFF6C63FF),
                                        accent2 = Color(0xFF9C27B0)
                                    ),
                                    showWinback = true,
                                    isDismissible = true,
                                    onPurchase = { productId ->
                                        val pkg = packages.firstOrNull { it.product.id == productId }
                                        if (pkg != null) {
                                            lifecycleScope.launch {
                                                revenueCatManager.purchase(activity, pkg)
                                                // trackPurchase fires from the isPremium observer above —
                                                // catches all paywall paths, not just this one.
                                            }
                                        }
                                    },
                                    onRestore = {
                                        lifecycleScope.launch {
                                            revenueCatManager.restorePurchases()
                                        }
                                    },
                                    onRedeemCode = {
                                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse("https://play.google.com/redeem?code=promo-1month-free"))
                                        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                                        try { startActivity(intent) } catch (_: Exception) {}
                                    },
                                    onDismiss = {
                                        paywallDismissed = true
                                    }
                                )
                            }
                        }
                        hasCompletedOnboarding -> {
                            MainScreen()
                        }
                        else -> {
                            OnboardingScreen(
                                onboardingManager = onboardingManager,
                                onComplete = {
                                    // State is already updated by OnboardingManager
                                }
                            )
                        }
                    }
                }
            }
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleOAuthRedirect(intent)
    }

    private fun handleOAuthRedirect(intent: Intent?) {
        val uri = intent?.data ?: return
        if (uri.scheme?.startsWith("com.googleusercontent.apps") == true) {
            Log.d("MainActivity", "Handling OAuth redirect: $uri")
            lifecycleScope.launch {
                authService.handleOAuthRedirect(uri)
            }
        }
    }
}
