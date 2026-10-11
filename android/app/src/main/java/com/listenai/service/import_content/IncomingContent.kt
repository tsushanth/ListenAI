package com.listenai.service.import_content

import android.content.ClipData
import android.content.ContentResolver
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Content another app handed to ReadAloud: shared text or a link, a selection
 * from the text-selection menu ("Read aloud"), or a PDF/EPUB/TXT opened from a
 * file manager, browser download or mail attachment.
 */
sealed class IncomingContent {
    data class Text(val text: String) : IncomingContent()
    data class Link(val url: String) : IncomingContent()
    data class Document(val uri: Uri, val kind: Kind, val displayName: String?) : IncomingContent()

    enum class Kind { PDF, EPUB, TEXT }
}

/** Pure parsing of launch intents into [IncomingContent]; no Android services needed beyond [ContentResolver]. */
object IncomingContentParser {

    private val URL_REGEX = Regex("""https?://[^\s<>"']+""", RegexOption.IGNORE_CASE)

    // A browser "Share" sends "Page title\nhttps://..." — treat it as a link when the
    // surrounding text is only a short caption, otherwise it is an article to read.
    private const val MAX_CAPTION_CHARS = 120

    fun parse(intent: Intent?, resolver: ContentResolver): IncomingContent? {
        intent ?: return null
        return when (intent.action) {
            Intent.ACTION_SEND -> parseSend(intent, resolver)
            Intent.ACTION_PROCESS_TEXT -> {
                val selected = intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()
                classifyText(selected)
            }
            Intent.ACTION_VIEW -> intent.data?.let { documentFrom(it, intent.type, resolver) }
            else -> null
        }
    }

    internal fun classifyText(raw: String?): IncomingContent? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        val match = URL_REGEX.find(text) ?: return IncomingContent.Text(text)
        val caption = text.removeRange(match.range).trim()
        return if (caption.length <= MAX_CAPTION_CHARS) {
            IncomingContent.Link(match.value.trimEnd('.', ',', ')', ';'))
        } else {
            IncomingContent.Text(text)
        }
    }

    private fun parseSend(intent: Intent, resolver: ContentResolver): IncomingContent? {
        val stream = streamUri(intent)
        if (stream != null) {
            documentFrom(stream, intent.type, resolver)?.let { return it }
        }
        return classifyText(intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString())
    }

    @Suppress("DEPRECATION")
    private fun streamUri(intent: Intent): Uri? =
        intent.getParcelableExtra(Intent.EXTRA_STREAM) as? Uri
            ?: intent.clipData?.takeIf { it.itemCount > 0 }?.let(::firstUri)

    private fun firstUri(clip: ClipData): Uri? = clip.getItemAt(0).uri

    private fun documentFrom(uri: Uri, mime: String?, resolver: ContentResolver): IncomingContent.Document? {
        val name = displayName(uri, resolver)
        val type = (mime ?: resolver.getType(uri))?.lowercase()
        val kind = when {
            type == "application/pdf" || name.endsWithIgnoreCase(".pdf") -> IncomingContent.Kind.PDF
            type == "application/epub+zip" || name.endsWithIgnoreCase(".epub") -> IncomingContent.Kind.EPUB
            type?.startsWith("text/") == true || name.endsWithIgnoreCase(".txt") -> IncomingContent.Kind.TEXT
            else -> return null
        }
        return IncomingContent.Document(uri, kind, name)
    }

    private fun String?.endsWithIgnoreCase(suffix: String) = this?.endsWith(suffix, ignoreCase = true) == true

    private fun displayName(uri: Uri, resolver: ContentResolver): String? {
        if (uri.scheme == ContentResolver.SCHEME_CONTENT) {
            runCatching {
                resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { c ->
                    if (c.moveToFirst()) return c.getString(0)
                }
            }
        }
        return uri.lastPathSegment?.substringAfterLast('/')
    }
}

/**
 * Process-wide hand-off between [com.listenai.MainActivity] (which receives the
 * intent, possibly before onboarding finishes) and the Compose UI that confirms
 * and imports it.
 */
object IncomingContentHolder {
    private val _pending = MutableStateFlow<IncomingContent?>(null)
    val pending: StateFlow<IncomingContent?> = _pending.asStateFlow()

    fun offer(content: IncomingContent?) {
        if (content != null) _pending.value = content
    }

    fun clear() {
        _pending.value = null
    }

    private val _openArticleId = MutableStateFlow<String?>(null)
    /** Article the widget asked us to open in the player. */
    val openArticleId: StateFlow<String?> = _openArticleId.asStateFlow()

    fun requestOpenArticle(id: String?) { _openArticleId.value = id }
    fun consumeOpenArticle() { _openArticleId.value = null }
}
