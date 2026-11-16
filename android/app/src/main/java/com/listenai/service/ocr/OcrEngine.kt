package com.listenai.service.ocr

import android.content.Context
import android.net.Uri
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizerOptionsInterface
import com.google.mlkit.vision.text.chinese.ChineseTextRecognizerOptions
import com.google.mlkit.vision.text.devanagari.DevanagariTextRecognizerOptions
import com.google.mlkit.vision.text.japanese.JapaneseTextRecognizerOptions
import com.google.mlkit.vision.text.korean.KoreanTextRecognizerOptions
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume

/**
 * On-device text recognition for the Read Text tab. All five script models are the Google Play services variants: the
 * model is downloaded by Play services the first time a script is used (a few MB, not part of the APK), and the first
 * request for a script that is not downloaded yet fails; [OcrScripts.recognize] then moves on and, if nothing else
 * reads the photo, the user sees the error and can try again a moment later.
 */
object OcrEngine {

    /** Throws when the image cannot be read; recognition failures are handled per script by [OcrScripts]. */
    suspend fun recognize(context: Context, uri: Uri, uiLanguage: String?): String {
        val image = InputImage.fromFilePath(context, uri)
        return OcrScripts.recognize(uiLanguage) { script -> runCatching { run(script, image) } }
    }

    private fun options(script: OcrScript): TextRecognizerOptionsInterface = when (script) {
        OcrScript.LATIN -> TextRecognizerOptions.DEFAULT_OPTIONS
        OcrScript.CHINESE -> ChineseTextRecognizerOptions.Builder().build()
        OcrScript.JAPANESE -> JapaneseTextRecognizerOptions.Builder().build()
        OcrScript.KOREAN -> KoreanTextRecognizerOptions.Builder().build()
        OcrScript.DEVANAGARI -> DevanagariTextRecognizerOptions.Builder().build()
    }

    private suspend fun run(script: OcrScript, image: InputImage): String = suspendCancellableCoroutine { cont ->
        val recognizer = TextRecognition.getClient(options(script))
        recognizer.process(image)
            .addOnSuccessListener { if (cont.isActive) cont.resume(it.text) ; recognizer.close() }
            .addOnFailureListener { e -> recognizer.close(); if (cont.isActive) cont.resumeWith(Result.failure(e)) }
        cont.invokeOnCancellation { recognizer.close() }
    }
}
