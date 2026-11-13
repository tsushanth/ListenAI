package com.listenai.service.tts

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.speech.tts.TextToSpeech
import com.listenai.service.tts.chain.TtsChainProvider

/** One screen to try, as plain data so the order is unit tested. */
data class IntentSpec(val action: String, val packageName: String? = null, val data: String? = null)

/**
 * Opens the place where the user can get speech voice data (or a speech engine). Phones differ: the engine's own
 * installer is tried first, then the system text-to-speech settings, then the main Settings app, so the button always
 * lands somewhere useful instead of doing nothing.
 */
object TtsInstall {
    const val GOOGLE_TTS_PACKAGE = "com.google.android.tts"
    /** The system "Text-to-speech output" screen (AOSP and most OEMs). */
    const val ACTION_TTS_SETTINGS = "com.android.settings.TTS_SETTINGS"

    /** Voice data for the chosen engine: its installer, then TTS settings, then Settings. */
    fun voiceDataSpecs(enginePackage: String?): List<IntentSpec> = buildList {
        if (enginePackage != null) add(IntentSpec(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA, packageName = enginePackage))
        add(IntentSpec(ACTION_TTS_SETTINGS))
        add(IntentSpec(Settings.ACTION_SETTINGS))
    }

    /** No engine at all: Speech Services by Google in the store app, then in the browser, then TTS settings, then Settings. */
    fun engineSpecs(): List<IntentSpec> = listOf(
        IntentSpec(Intent.ACTION_VIEW, data = "market://details?id=$GOOGLE_TTS_PACKAGE"),
        IntentSpec(Intent.ACTION_VIEW, data = "https://play.google.com/store/apps/details?id=$GOOGLE_TTS_PACKAGE"),
        IntentSpec(ACTION_TTS_SETTINGS),
        IntentSpec(Settings.ACTION_SETTINGS),
    )

    /** The first spec that [launch] accepts (it returns false when nothing can handle it). Null if none did. */
    fun firstLaunchable(specs: List<IntentSpec>, launch: (IntentSpec) -> Boolean): IntentSpec? = specs.firstOrNull { launch(it) }

    /** Opens the installer for voice data ([installEngine] false) or for an engine ([installEngine] true). True if a screen opened. */
    fun open(context: Context, installEngine: Boolean): Boolean {
        val specs = if (installEngine) engineSpecs() else voiceDataSpecs(TtsChainProvider.get(context).system.chosenEngine())
        return firstLaunchable(specs) { spec ->
            val intent = Intent(spec.action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            spec.packageName?.let { intent.setPackage(it) }
            spec.data?.let { intent.data = Uri.parse(it) }
            try { context.startActivity(intent); true } catch (e: Exception) { false }
        } != null
    }
}
