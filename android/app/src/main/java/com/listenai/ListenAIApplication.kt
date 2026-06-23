package com.listenai

import android.app.Application
import android.util.Log
import com.listenai.BuildConfig
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

        // Reader-flavor monetization + analytics. The standalone
        // ReadAloud Voice app (BuildConfig.FLAVOR == "voice") is a
        // paid-upfront product — Play's IAP handles entitlement, so
        // there's no PaywallKit/RevenueCat surface to wire up.
        // We also skip the marketing-attribution SDKs (Firebase
        // Analytics, TikTok Events, Meta SDK) in the voice flavor
        // because that app's entire UI is a single voice-picker
        // screen; there are no funnels to attribute. Skipping these
        // keeps the standalone's startup cost low and its data
        // footprint honest for the BVI audience the app targets.
        if (BuildConfig.FLAVOR != "voice") {
            AppOpenTracker.init(this)
            RevenueCatManager.getInstance().configure(this)
            com.kreativekoala.paywallkit.manager.ExperimentManager.init(this)
            com.kreativekoala.paywallkit.manager.PromoCodeManager.init(this)
            RatingKit.init(this, appId = "readaloud")
            FirebaseAnalyticsHelper.initialize(this)
            TikTokHelper.initialize(this)
            FacebookSDKHelper.initialize(this)
        }

        // Warm up the Kokoro ONNX session if the user opted into on-device
        // synthesis AND the model file is already on disk. Doing this at app
        // start (instead of lazily on first synth request) is what lets the
        // TTSServiceFactory's `isInferenceReady()` gate flip from false →
        // true without a synth call first — otherwise we'd silently fall back
        // to cloud for the user's first utterance even when on-device is
        // ready to serve it.
        warmUpKokoroIfReady()
        // Chatterbox = voice cloning, reader-only. Voice flavor's
        // picker doesn't expose it, so don't burn the 1.5 GB RAM
        // mapping the sessions take.
        if (BuildConfig.FLAVOR != "voice") {
            warmUpChatterboxIfReady()
        }
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

    /**
     * Eagerly load the 4 Chatterbox ONNX sessions if the model bundle is on
     * disk. This shifts the ~10-15s cold-load cost from "the moment the
     * user asks TalkBack to speak" to "app start" — which the user is
     * already waiting for. Memory cost is ~1.5 GB of weight files mapped
     * into process RAM, so we only fire if the user has actually downloaded
     * the bundle.
     */
    private fun warmUpChatterboxIfReady() {
        val onDisk = com.listenai.service.tts.ChatterboxModelDownloader
            .getInstance(this).isReady()
        Log.i(TAG, "warmUpChatterboxIfReady: onDisk=$onDisk")
        if (!onDisk) return

        CoroutineScope(SupervisorJob() + Dispatchers.IO).launch {
            try {
                Log.i(TAG, "warmUpChatterboxIfReady: loading 4 ONNX sessions in background")
                val t0 = System.currentTimeMillis()
                val ok = com.listenai.service.tts.ChatterboxOnDeviceService
                    .getInstance(this@ListenAIApplication).isAvailable()
                val elapsed = System.currentTimeMillis() - t0
                Log.i(TAG, "warmUpChatterboxIfReady: sessions ready=$ok in ${elapsed}ms")
            } catch (t: Throwable) {
                Log.e(TAG, "warmUpChatterboxIfReady: session warmup failed", t)
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
