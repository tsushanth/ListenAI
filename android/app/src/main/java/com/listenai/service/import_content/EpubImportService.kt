package com.listenai.service.import_content

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import nl.siegmann.epublib.epub.EpubReader
import org.jsoup.Jsoup

data class ExtractedEpubChapter(
    val title: String,
    val content: String,
    val chapterIndex: Int
)

data class ExtractedEpubContent(
    val bookTitle: String,
    val author: String?,
    val chapters: List<ExtractedEpubChapter>
)

class EpubImportService(
    private val context: Context
) {

    suspend fun extractContent(uri: Uri): ExtractedEpubContent? = withContext(Dispatchers.IO) {
        try {
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                val book = EpubReader().readEpub(inputStream)

                val bookTitle = book.title?.takeIf { it.isNotBlank() }
                    ?: extractTitleFromFilename(uri)

                val author = book.metadata?.authors?.firstOrNull()?.let { a ->
                    listOfNotNull(a.firstname, a.lastname)
                        .joinToString(" ")
                        .takeIf { it.isNotBlank() }
                }

                val toc = book.tableOfContents?.tocReferences ?: emptyList()
                val tocHrefToTitle = mutableMapOf<String, String>()
                for (ref in toc) {
                    ref.resource?.href?.let { href ->
                        ref.title?.takeIf { it.isNotBlank() }?.let { title ->
                            tocHrefToTitle[href] = title
                        }
                    }
                    // Also grab child references (nested TOC)
                    for (child in ref.children ?: emptyList()) {
                        child.resource?.href?.let { href ->
                            child.title?.takeIf { it.isNotBlank() }?.let { title ->
                                tocHrefToTitle[href] = title
                            }
                        }
                    }
                }

                val spine = book.spine
                val chapters = mutableListOf<ExtractedEpubChapter>()
                var chapterIndex = 0

                for (i in 0 until spine.size()) {
                    val resource = spine.getResource(i) ?: continue
                    val html = String(resource.data, Charsets.UTF_8)
                    val doc = Jsoup.parse(html)
                    val text = cleanEpubText(doc.body().text())

                    if (text.isBlank() || text.length < 50) continue

                    // Try to get chapter title from TOC, then from first heading, then fallback
                    val chapterTitle = tocHrefToTitle[resource.href]
                        ?: doc.select("h1, h2, h3").firstOrNull()?.text()?.takeIf { it.isNotBlank() && it.length < 200 }
                        ?: "Chapter ${chapterIndex + 1}"

                    chapterIndex++
                    chapters.add(
                        ExtractedEpubChapter(
                            title = chapterTitle,
                            content = text,
                            chapterIndex = chapterIndex
                        )
                    )
                }

                if (chapters.isEmpty()) null
                else ExtractedEpubContent(
                    bookTitle = bookTitle,
                    author = author,
                    chapters = chapters
                )
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun extractTitleFromFilename(uri: Uri): String {
        val filename = uri.lastPathSegment ?: "Book"
        return filename
            .substringBeforeLast(".")
            .substringAfterLast("/")
            .replace("_", " ")
            .replace("-", " ")
            .trim()
    }

    private fun cleanEpubText(text: String): String {
        return text
            .replace(Regex("\\s+"), " ")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
    }
}
