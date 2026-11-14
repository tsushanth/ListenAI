package com.listenai.service.tts

import android.content.Intent
import android.provider.Settings
import android.speech.tts.TextToSpeech
import com.listenai.R
import com.listenai.service.tts.chain.LanguageVoiceState
import com.listenai.service.tts.chain.NoSourceAvailableException
import com.listenai.service.tts.chain.SourceId
import com.listenai.service.tts.chain.FallbackReason
import com.listenai.service.tts.chain.UserAction
import com.listenai.service.tts.chain.VoiceSelection
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SpeechUnavailableTest {
    private fun failure(action: UserAction) =
        ChainSynthesizer.speechUnavailable(NoSourceAvailableException(mapOf(SourceId.SYSTEM to FallbackReason.LANGUAGE_MISSING), action))

    @Test fun `missing voice data carries the language and its own kind`() {
        val e = failure(UserAction.InstallVoiceData("ar"))
        assertEquals(TTSError.SpeechUnavailable.Kind.NO_VOICE_DATA, e.kind)
        assertEquals("ar", e.installVoiceLanguage)
        assertFalse(e.installEngine)
    }

    @Test fun `each action maps to a kind and an install button`() {
        assertEquals(TTSError.SpeechUnavailable.Kind.NO_ENGINE, failure(UserAction.InstallEngine).kind)
        assertTrue(failure(UserAction.InstallEngine).installEngine)
        assertEquals(TTSError.SpeechUnavailable.Kind.OFFLINE, failure(UserAction.CheckConnection).kind)
        assertEquals(TTSError.SpeechUnavailable.Kind.BUSY, failure(UserAction.TryLater).kind)
        assertNull(failure(UserAction.TryLater).installVoiceLanguage)
    }

    @Test fun `every kind except OTHER has a translated message resource`() {
        assertEquals(R.string.lang_no_voice_message, SpeechUnavailableText.messageRes(TTSError.SpeechUnavailable.Kind.NO_VOICE_DATA))
        assertEquals(R.string.speech_no_engine_message, SpeechUnavailableText.messageRes(TTSError.SpeechUnavailable.Kind.NO_ENGINE))
        assertEquals(R.string.speech_offline_message, SpeechUnavailableText.messageRes(TTSError.SpeechUnavailable.Kind.OFFLINE))
        assertEquals(R.string.speech_busy_message, SpeechUnavailableText.messageRes(TTSError.SpeechUnavailable.Kind.BUSY))
        assertNull(SpeechUnavailableText.messageRes(TTSError.SpeechUnavailable.Kind.OTHER))
    }

    @Test fun `voice data installer is tried first, then TTS settings, then Settings`() {
        val specs = TtsInstall.voiceDataSpecs("com.google.android.tts")
        assertEquals(
            listOf(
                IntentSpec(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA, packageName = "com.google.android.tts"),
                IntentSpec(TtsInstall.ACTION_TTS_SETTINGS),
                IntentSpec(Settings.ACTION_SETTINGS),
            ),
            specs,
        )
    }

    @Test fun `without an engine package the installer is skipped`() {
        assertEquals(listOf(IntentSpec(TtsInstall.ACTION_TTS_SETTINGS), IntentSpec(Settings.ACTION_SETTINGS)), TtsInstall.voiceDataSpecs(null))
    }

    @Test fun `engine install goes to the store, then the web page, then settings`() {
        val specs = TtsInstall.engineSpecs()
        assertEquals(Intent.ACTION_VIEW, specs[0].action)
        assertTrue(specs[0].data!!.startsWith("market://"))
        assertTrue(specs[1].data!!.startsWith("https://play.google.com/"))
        assertEquals(Settings.ACTION_SETTINGS, specs.last().action)
    }

    @Test fun `the first screen that can open wins and later ones are not tried`() {
        val specs = TtsInstall.voiceDataSpecs("e")
        val tried = ArrayList<IntentSpec>()
        val chosen = TtsInstall.firstLaunchable(specs) { tried += it; it.action == TtsInstall.ACTION_TTS_SETTINGS }
        assertEquals(specs[1], chosen)
        assertEquals(2, tried.size)
    }

    @Test fun `when nothing opens the result is null`() {
        assertNull(TtsInstall.firstLaunchable(TtsInstall.voiceDataSpecs("e")) { false })
    }

    @Test fun `voice state combines engine, language and voice listing`() {
        assertEquals(LanguageVoiceState.NO_ENGINE, LanguageVoiceState.from(false, true, VoiceSelection.Status.USABLE))
        assertEquals(LanguageVoiceState.MISSING, LanguageVoiceState.from(true, false, VoiceSelection.Status.NONE_LISTED))
        assertEquals(LanguageVoiceState.LISTED_UNUSABLE, LanguageVoiceState.from(true, true, VoiceSelection.Status.NOT_USABLE))
        assertEquals(LanguageVoiceState.LISTED_UNUSABLE, LanguageVoiceState.from(true, false, VoiceSelection.Status.NOT_USABLE))
        assertEquals(LanguageVoiceState.USABLE, LanguageVoiceState.from(true, true, VoiceSelection.Status.USABLE))
        // language reported available with no voices listed: trusted
        assertEquals(LanguageVoiceState.USABLE, LanguageVoiceState.from(true, true, VoiceSelection.Status.NONE_LISTED))
    }

    @Test fun `import notice only for non-English languages that cannot be spoken`() {
        assertFalse(LanguageVoiceCheck.needsCheck(null))
        assertFalse(LanguageVoiceCheck.needsCheck(""))
        assertFalse(LanguageVoiceCheck.needsCheck("en"))
        assertFalse(LanguageVoiceCheck.needsCheck("EN-us"))
        assertTrue(LanguageVoiceCheck.needsCheck("es"))
        assertTrue(LanguageVoiceCheck.needsCheck("ar"))
        assertFalse(LanguageVoiceCheck.shouldWarn(LanguageVoiceState.USABLE))
        assertTrue(LanguageVoiceCheck.shouldWarn(LanguageVoiceState.MISSING))
        assertTrue(LanguageVoiceCheck.shouldWarn(LanguageVoiceState.LISTED_UNUSABLE))
        assertTrue(LanguageVoiceCheck.shouldWarn(LanguageVoiceState.NO_ENGINE))
    }
}
