package com.listenai.service.tts

import com.listenai.data.models.Article
import com.listenai.data.repository.ArticleRepository
import com.listenai.service.LanguageDetector

/**
 * Applies the user's choice of reading language to one document: remembers it, stores it as the document's language
 * and drops any audio already made, because that audio was spoken in the wrong language.
 */
object LanguageOverrideAction {

    /** [newCode] null means "automatic": detection runs again. Returns the document as it is now stored. */
    suspend fun apply(repository: ArticleRepository, prefs: LanguagePrefs, article: Article, newCode: String?): Article {
        prefs.setOverride(article.id, newCode)
        val language = LanguageChoice.resolve(
            override = newCode,
            detected = if (newCode == null) LanguageDetector.detectOrNull(article.rawText) else null,
            stored = null,
        )
        repository.updateLanguage(article.id, language)
        repository.updateSynthesisStatus(
            id = article.id,
            status = "pending",
            audioUrl = null,
            duration = 0L,
            voiceId = article.selectedVoiceId,
        )
        return article.copy(language = language, audioFileUrl = null)
    }
}
