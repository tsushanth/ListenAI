package com.listenai.systemtts

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.speech.tts.TextToSpeech

/**
 * The standard activities an Android TTS engine exposes next to its service.
 *
 * Settings > Text-to-speech output calls [GetSampleTextActivity] to pick the "Listen to an example" sentence
 * for a language, and apps and Settings call [CheckVoiceDataActivity] to learn which voices are installed.
 * Without them Settings falls back to generic text or reports missing data.
 */
object SampleTexts {
    private const val DEFAULT = "This is an example of speech synthesis in your language."

    private val BY_LANGUAGE = mapOf(
        "en" to "This is an example of speech synthesis in English.",
        "es" to "Este es un ejemplo de síntesis de voz en español.",
        "fr" to "Ceci est un exemple de synthèse vocale en français.",
        "de" to "Dies ist ein Beispiel für Sprachsynthese auf Deutsch.",
        "it" to "Questo è un esempio di sintesi vocale in italiano.",
        "pt" to "Este é um exemplo de síntese de fala em português.",
        "nl" to "Dit is een voorbeeld van spraaksynthese in het Nederlands.",
        "pl" to "To jest przykład syntezy mowy w języku polskim.",
        "tr" to "Bu, Türkçe konuşma sentezinin bir örneğidir.",
        "sv" to "Detta är ett exempel på talsyntes på svenska.",
        "da" to "Dette er et eksempel på talesyntese på dansk.",
        "fi" to "Tämä on esimerkki puhesynteesistä suomeksi.",
        "cs" to "Toto je ukázka syntézy řeči v češtině.",
        "el" to "Αυτό είναι ένα παράδειγμα σύνθεσης ομιλίας στα ελληνικά.",
        "hi" to "यह हिंदी में वाक् संश्लेषण का एक उदाहरण है।",
        "ar" to "هذا مثال على تحويل النص إلى كلام باللغة العربية.",
        "he" to "זוהי דוגמה לסינתזת דיבור בעברית.",
        "ja" to "これは日本語の音声合成の例です。",
        "ko" to "이것은 한국어 음성 합성의 예입니다.",
        "zh" to "这是中文语音合成的示例。",
        "vi" to "Đây là một ví dụ về tổng hợp giọng nói bằng tiếng Việt.",
        "th" to "นี่คือตัวอย่างการสังเคราะห์เสียงพูดภาษาไทย",
        "id" to "Ini adalah contoh sintesis ucapan dalam bahasa Indonesia.",
        "uk" to "Це приклад синтезу мовлення українською мовою.",
        "ta" to "இது தமிழில் பேச்சு தொகுப்பின் ஒரு எடுத்துக்காட்டு.",
        "sw" to "Huu ni mfano wa usanisi wa usemi kwa Kiswahili.",
    )

    fun forLanguage(lang2: String?): String = BY_LANGUAGE[lang2?.lowercase()] ?: DEFAULT
}

/** Returns the example sentence Settings speaks for the requested language. */
class GetSampleTextActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Settings passes ISO-3 codes ("spa"); the example texts are keyed by ISO-2.
        val lang2 = LanguageCodes.toIso2(intent?.getStringExtra("language"))
        val result = Intent().putExtra(TextToSpeech.Engine.EXTRA_SAMPLE_TEXT, SampleTexts.forLanguage(lang2))
        setResult(TextToSpeech.LANG_AVAILABLE, result)
        finish()
    }
}

/** Reports the voices that are ready to use, in the "eng-USA" form the framework expects. */
class CheckVoiceDataActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val available = ArrayList<String>()
        for (voice in VoiceCatalog.systemVoices()) {
            val l = voice.locale
            val code = if (l.country.isNullOrEmpty()) l.isO3Language else "${l.isO3Language}-${l.isO3Country}"
            if (code !in available) available += code
        }
        val result = Intent()
            .putStringArrayListExtra(TextToSpeech.Engine.EXTRA_AVAILABLE_VOICES, available)
            .putStringArrayListExtra(TextToSpeech.Engine.EXTRA_UNAVAILABLE_VOICES, ArrayList())
        setResult(TextToSpeech.Engine.CHECK_VOICE_DATA_PASS, result)
        finish()
    }
}
