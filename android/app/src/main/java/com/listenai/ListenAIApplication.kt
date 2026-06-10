package com.listenai

import android.app.Application
import android.util.Log
import com.listenai.di.allModules
import com.listenai.service.AppOpenTracker
import com.listenai.service.FacebookSDKHelper
import com.listenai.service.FirebaseAnalyticsHelper
import com.listenai.service.TikTokHelper
import com.listenai.service.billing.RevenueCatManager
import com.listenai.service.import_content.WebImportService
import com.listenai.service.settings.SettingsManager
import com.listenai.service.tts.KokoroModelDownloader
import com.listenai.service.tts.TTSServiceFactory
import com.kreativekoala.ratingkit.RatingKit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.koin.android.ext.android.inject
import org.koin.android.ext.koin.androidContext
import org.koin.android.ext.koin.androidLogger
import org.koin.core.context.startKoin
import org.koin.core.logger.Level

class ListenAIApplication : Application() {

    override fun onCreate() {
        super.onCreate()

        // Initialize Koin dependency injection
        startKoin {
            androidLogger(Level.DEBUG)
            androidContext(this@ListenAIApplication)
            modules(allModules)
        }

        // Configure services with backend URL
        configureServices()

        // Initialize app open tracker
        AppOpenTracker.init(this)

        // Initialize RevenueCat for subscriptions
        RevenueCatManager.getInstance().configure(this)

        // Initialize PaywallKit experiment manager
        com.kreativekoala.paywallkit.manager.ExperimentManager.init(this)
        com.kreativekoala.paywallkit.manager.PromoCodeManager.init(this)

        // Initialize RatingKit
        RatingKit.init(this, appId = "readaloud")

        // Initialize Firebase Analytics for Google Ads conversion tracking
        FirebaseAnalyticsHelper.initialize(this)

        // Initialize TikTok Events SDK for install attribution
        TikTokHelper.initialize(this)

        // Initialize Facebook SDK for Meta Ads attribution
        FacebookSDKHelper.initialize(this)

        // Warm up the Kokoro ONNX session if the user opted into on-device
        // synthesis AND the model file is already on disk. Doing this at app
        // start (instead of lazily on first synth request) is what lets the
        // TTSServiceFactory's `isInferenceReady()` gate flip from false →
        // true without a synth call first — otherwise we'd silently fall back
        // to cloud for the user's first utterance even when on-device is
        // ready to serve it.
        warmUpKokoroIfReady()
    }

    private fun warmUpKokoroIfReady() {
        val settings = SettingsManager.getInstance(this)
        val optedIn = settings.useOfflineKokoro.value
        val onDisk = KokoroModelDownloader.getInstance(this).isModelOnDisk()
        Log.i(TAG, "warmUpKokoroIfReady: optedIn=$optedIn onDisk=$onDisk")
        if (!optedIn || !onDisk) return

        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                Log.i(TAG, "warmUpKokoroIfReady: calling isAvailable() to force session load")
                val ok = TTSServiceFactory.getKokoroOnDeviceService(this@ListenAIApplication).isAvailable()
                Log.i(TAG, "warmUpKokoroIfReady: session ready = $ok")
            } catch (t: Throwable) {
                Log.e(TAG, "warmUpKokoroIfReady: session warmup failed", t)
            }
        }
    }

    companion object {
        private const val TAG = "ListenAIApplication"
        const val BACKEND_URL = "https://listenai-backend.fly.dev"
    }

    private fun configureServices() {
        // Configure WebImportService for server-side extraction
        val webImportService: WebImportService by inject()
        webImportService.configure(
            backendUrl = BACKEND_URL,
            authTokenProvider = {
                // TODO: Replace with actual Supabase auth token provider
                // In production: return supabaseClient.auth.currentSession?.accessToken ?: ""
                ""
            }
        )
    }
}
