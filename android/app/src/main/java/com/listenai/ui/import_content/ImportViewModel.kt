package com.listenai.ui.import_content

import android.content.Context
import android.net.Uri
import androidx.core.net.toUri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.listenai.data.models.Article
import com.listenai.data.models.SourceType
import com.listenai.data.repository.ArticleRepository
import com.listenai.service.import_content.EpubImportService
import com.listenai.service.import_content.PDFImportService
import com.listenai.service.import_content.WebImportService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.yield
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
import java.util.Date
import java.util.UUID
import java.util.concurrent.TimeUnit

sealed class ImportState {
    object Idle : ImportState()
    object Loading : ImportState()
    data class Success(val articleId: String) : ImportState()
    data class Error(val message: String) : ImportState()
}

class ImportViewModel(
    private val articleRepository: ArticleRepository,
    private val webImportService: WebImportService,
    private val pdfImportService: PDFImportService,
    private val epubImportService: EpubImportService
) : ViewModel() {

    private val _importState = MutableStateFlow<ImportState>(ImportState.Idle)
    val importState: StateFlow<ImportState> = _importState.asStateFlow()

    private val _progress = MutableStateFlow(0f)
    val progress: StateFlow<Float> = _progress.asStateFlow()

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    // Maximum text length for TTS backend (~5 min of audio per chunk)
    private val MAX_CHUNK_LENGTH = 10_000

    // Maximum text length to store (SQLite cursor window limit is ~2MB)
    // Limiting to ~500K characters to be safe with UTF-8 encoding
    private val MAX_TEXT_LENGTH = 500_000

    /**
     * Truncate text if too long to prevent SQLite cursor window overflow
     */
    private fun truncateIfNeeded(text: String): String {
        return if (text.length > MAX_TEXT_LENGTH) {
            val truncated = text.take(MAX_TEXT_LENGTH)
            // Try to truncate at a sentence boundary
            val lastPeriod = truncated.lastIndexOf(". ")
            if (lastPeriod > MAX_TEXT_LENGTH - 1000) {
                truncated.substring(0, lastPeriod + 1)
            } else {
                truncated + "... [Content truncated due to length]"
            }
        } else {
            text
        }
    }

    /**
     * Check if URL points to a PDF file
     */
    private fun isPdfUrl(url: String): Boolean {
        val lowerUrl = url.lowercase()
        return lowerUrl.endsWith(".pdf") ||
               lowerUrl.contains("/pdf/") ||
               lowerUrl.contains("arxiv.org/pdf")
    }

    /**
     * Import content from a URL (detects and handles PDF URLs)
     */
    fun importFromUrl(url: String, context: Context? = null) {
        if (url.isBlank()) {
            _importState.value = ImportState.Error("Please enter a valid URL")
            return
        }

        // Check if this is a PDF URL
        if (isPdfUrl(url)) {
            if (context != null) {
                importFromPdfUrl(context, url)
            } else {
                _importState.value = ImportState.Error("Cannot import PDF URL without context")
            }
            return
        }

        viewModelScope.launch {
            _importState.value = ImportState.Loading
            _progress.value = 0.1f

            try {
                _progress.value = 0.3f
                val extractedContent = webImportService.extractContent(url)

                if (extractedContent == null) {
                    _importState.value = ImportState.Error("Failed to extract content from URL")
                    return@launch
                }

                _progress.value = 0.7f

                val truncatedContent = truncateIfNeeded(extractedContent.content)
                val article = Article(
                    id = UUID.randomUUID().toString(),
                    title = extractedContent.title,
                    author = extractedContent.author,
                    siteName = extractedContent.siteName,
                    publishDate = null,
                    rawText = truncatedContent,
                    wordCount = truncatedContent.split(Regex("\\s+")).size,
                    language = extractedContent.language,
                    heroImageUrl = extractedContent.imageUrl,
                    sourceType = SourceType.WEB,
                    sourceUrl = url,
                    sourceFileName = null,
                    audioFileUrl = null,
                    selectedVoiceId = null
                )

                articleRepository.saveArticle(article)
                _progress.value = 1f

                _importState.value = ImportState.Success(article.id)
            } catch (e: Exception) {
                _importState.value = ImportState.Error(e.message ?: "Failed to import from URL")
            }
        }
    }

    /**
     * Import content from a PDF URL by downloading and extracting
     */
    fun importFromPdfUrl(context: Context, url: String) {
        viewModelScope.launch {
            _importState.value = ImportState.Loading
            _progress.value = 0.1f

            try {
                // Download PDF to cache
                _progress.value = 0.2f
                val pdfFile = downloadPdfToCache(context, url)

                if (pdfFile == null) {
                    _importState.value = ImportState.Error("Failed to download PDF")
                    return@launch
                }

                _progress.value = 0.5f

                // Extract content from downloaded PDF
                val uri = Uri.fromFile(pdfFile)
                val extractedContent = pdfImportService.extractContent(uri)

                if (extractedContent == null || extractedContent.content.isBlank()) {
                    pdfFile.delete()
                    _importState.value = ImportState.Error("Failed to extract text from PDF")
                    return@launch
                }

                _progress.value = 0.8f

                // Extract filename from URL
                val fileName = url.substringAfterLast("/").ifBlank { "document.pdf" }
                val truncatedContent = truncateIfNeeded(extractedContent.content)

                val article = Article(
                    id = UUID.randomUUID().toString(),
                    title = extractedContent.title.ifBlank { fileName.removeSuffix(".pdf") },
                    author = extractedContent.author,
                    siteName = try { java.net.URL(url).host } catch (e: Exception) { null },
                    publishDate = null,
                    rawText = truncatedContent,
                    wordCount = truncatedContent.split(Regex("\\s+")).size,
                    language = "en",
                    heroImageUrl = null,
                    sourceType = SourceType.PDF,
                    sourceUrl = url,
                    sourceFileName = fileName,
                    audioFileUrl = null,
                    selectedVoiceId = null
                )

                articleRepository.saveArticle(article)

                // Clean up temp file
                pdfFile.delete()

                _progress.value = 1f
                _importState.value = ImportState.Success(article.id)

            } catch (e: Exception) {
                android.util.Log.e("ImportViewModel", "Failed to import PDF from URL", e)
                _importState.value = ImportState.Error(e.message ?: "Failed to import PDF from URL")
            }
        }
    }

    /**
     * Download PDF from URL to cache directory
     */
    private suspend fun downloadPdfToCache(context: Context, url: String): File? = withContext(Dispatchers.IO) {
        try {
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36")
                .build()

            val response = httpClient.newCall(request).execute()

            if (!response.isSuccessful) {
                android.util.Log.e("ImportViewModel", "Failed to download PDF: ${response.code}")
                return@withContext null
            }

            val body = response.body ?: return@withContext null

            // Create temp file in cache
            val fileName = "temp_${System.currentTimeMillis()}.pdf"
            val tempFile = File(context.cacheDir, fileName)

            tempFile.outputStream().use { output ->
                body.byteStream().use { input ->
                    input.copyTo(output)
                }
            }

            android.util.Log.d("ImportViewModel", "Downloaded PDF: ${tempFile.length()} bytes")
            tempFile
        } catch (e: Exception) {
            android.util.Log.e("ImportViewModel", "Error downloading PDF", e)
            null
        }
    }

    /**
     * Import content from a PDF file
     */
    fun importFromPdf(context: Context, uri: Uri) {
        viewModelScope.launch {
            _importState.value = ImportState.Loading
            _progress.value = 0.1f

            try {
                _progress.value = 0.3f
                val extractedContent = pdfImportService.extractContent(uri)

                if (extractedContent == null || extractedContent.content.isBlank()) {
                    _importState.value = ImportState.Error("Failed to extract text from PDF")
                    return@launch
                }

                _progress.value = 0.7f

                val fileName = getFileName(context, uri) ?: "document.pdf"
                val truncatedContent = truncateIfNeeded(extractedContent.content)

                val article = Article(
                    id = UUID.randomUUID().toString(),
                    title = extractedContent.title.ifBlank { fileName.removeSuffix(".pdf") },
                    author = extractedContent.author,
                    siteName = null,
                    publishDate = null,
                    rawText = truncatedContent,
                    wordCount = truncatedContent.split(Regex("\\s+")).size,
                    language = "en",
                    heroImageUrl = null,
                    sourceType = SourceType.PDF,
                    sourceUrl = null,
                    sourceFileName = fileName,
                    audioFileUrl = null,
                    selectedVoiceId = null
                )

                articleRepository.saveArticle(article)
                _progress.value = 1f

                _importState.value = ImportState.Success(article.id)
            } catch (e: Exception) {
                _importState.value = ImportState.Error(e.message ?: "Failed to import PDF")
            }
        }
    }

    /**
     * Import content from an EPUB file — creates one article per chapter
     */
    fun importFromEpub(context: Context, uri: Uri) {
        viewModelScope.launch {
            _importState.value = ImportState.Loading
            _progress.value = 0.1f

            try {
                _progress.value = 0.3f
                val extractedContent = epubImportService.extractContent(uri)

                if (extractedContent == null || extractedContent.chapters.isEmpty()) {
                    _importState.value = ImportState.Error("Failed to extract text from EPUB")
                    return@launch
                }

                val fileName = getFileName(context, uri) ?: "book.epub"
                val bookTitle = extractedContent.bookTitle.ifBlank { fileName.removeSuffix(".epub") }
                val chapters = extractedContent.chapters

                // Split oversized chapters into parts
                val parts = mutableListOf<Pair<String, String>>() // title to content
                for (chapter in chapters) {
                    android.util.Log.d("EpubImport", "Chapter '${chapter.title}': ${chapter.content.length} chars")
                    if (chapter.content.length <= MAX_CHUNK_LENGTH) {
                        parts.add(chapter.title to chapter.content)
                    } else {
                        val chunks = splitTextAtSentences(chapter.content, MAX_CHUNK_LENGTH)
                        android.util.Log.d("EpubImport", "  Split into ${chunks.size} parts: ${chunks.map { it.length }}")
                        if (chunks.size == 1) {
                            parts.add(chapter.title to chunks[0])
                        } else {
                            chunks.forEachIndexed { i, chunk ->
                                parts.add("${chapter.title} (Part ${i + 1})" to chunk)
                            }
                        }
                    }
                }
                android.util.Log.d("EpubImport", "Total parts: ${parts.size}, sizes: ${parts.map { it.second.length }}")

                var firstArticleId: String? = null
                // Stamp each chapter with a unique sequential createdAt so the
                // library can sort chapters back into reading order. Without
                // the +index offset, the tight save loop gives all chapters
                // the same millisecond timestamp and the DAO's createdAt-based
                // ordering ends up reversed (see issue reported by Warren on
                // beta build 2.13.1).
                val baseImportTime = System.currentTimeMillis()
                for ((index, part) in parts.withIndex()) {
                    _progress.value = 0.3f + 0.7f * (index.toFloat() / parts.size)
                    yield() // let UI update

                    val (partTitle, partContent) = part
                    val articleId = UUID.randomUUID().toString()
                    if (firstArticleId == null) firstArticleId = articleId

                    val article = Article(
                        id = articleId,
                        title = "$bookTitle — $partTitle",
                        author = extractedContent.author,
                        siteName = null,
                        publishDate = null,
                        rawText = partContent,
                        wordCount = partContent.split(Regex("\\s+")).size,
                        language = "en",
                        heroImageUrl = null,
                        sourceType = SourceType.EPUB,
                        sourceUrl = null,
                        sourceFileName = fileName,
                        audioFileUrl = null,
                        selectedVoiceId = null,
                        createdAt = Date(baseImportTime + index)
                    )

                    articleRepository.saveArticle(article)
                }

                _progress.value = 1f
                _importState.value = ImportState.Success(firstArticleId!!)
            } catch (e: Exception) {
                _importState.value = ImportState.Error(e.message ?: "Failed to import EPUB")
            }
        }
    }

    /**
     * Import content from manually entered text
     */
    fun importFromText(title: String, content: String) {
        if (content.isBlank()) {
            _importState.value = ImportState.Error("Please enter some content")
            return
        }

        viewModelScope.launch {
            _importState.value = ImportState.Loading
            _progress.value = 0.5f

            try {
                val truncatedContent = truncateIfNeeded(content)
                val article = Article(
                    id = UUID.randomUUID().toString(),
                    title = title.ifBlank { "Untitled" },
                    author = null,
                    siteName = null,
                    publishDate = null,
                    rawText = truncatedContent,
                    wordCount = truncatedContent.split(Regex("\\s+")).size,
                    language = "en",
                    heroImageUrl = null,
                    sourceType = SourceType.MANUAL,
                    sourceUrl = null,
                    sourceFileName = null,
                    audioFileUrl = null,
                    selectedVoiceId = null
                )

                articleRepository.saveArticle(article)
                _progress.value = 1f

                _importState.value = ImportState.Success(article.id)
            } catch (e: Exception) {
                _importState.value = ImportState.Error(e.message ?: "Failed to save article")
            }
        }
    }

    /**
     * Import content from clipboard text
     */
    fun importFromClipboard(clipboardText: String) {
        if (clipboardText.isBlank()) {
            _importState.value = ImportState.Error("Clipboard is empty")
            return
        }

        // Check if it's a URL
        if (clipboardText.startsWith("http://") || clipboardText.startsWith("https://")) {
            importFromUrl(clipboardText)
            return
        }

        viewModelScope.launch {
            _importState.value = ImportState.Loading
            _progress.value = 0.5f

            try {
                // Extract first line as potential title
                val lines = clipboardText.trim().lines()
                val title = if (lines.isNotEmpty() && lines[0].length < 100) {
                    lines[0]
                } else {
                    "Clipboard Content"
                }

                val truncatedContent = truncateIfNeeded(clipboardText)
                val article = Article(
                    id = UUID.randomUUID().toString(),
                    title = title,
                    author = null,
                    siteName = null,
                    publishDate = null,
                    rawText = truncatedContent,
                    wordCount = truncatedContent.split(Regex("\\s+")).size,
                    language = "en",
                    heroImageUrl = null,
                    sourceType = SourceType.CLIPBOARD,
                    sourceUrl = null,
                    sourceFileName = null,
                    audioFileUrl = null,
                    selectedVoiceId = null
                )

                articleRepository.saveArticle(article)
                _progress.value = 1f

                _importState.value = ImportState.Success(article.id)
            } catch (e: Exception) {
                _importState.value = ImportState.Error(e.message ?: "Failed to import from clipboard")
            }
        }
    }

    /**
     * Reset state
     */
    fun resetState() {
        _importState.value = ImportState.Idle
        _progress.value = 0f
    }

    private fun splitTextAtSentences(text: String, maxLen: Int): List<String> {
        if (text.length <= maxLen) return listOf(text)
        val chunks = mutableListOf<String>()
        var remaining = text
        while (remaining.length > maxLen) {
            val cut = remaining.substring(0, maxLen)
            // Find last sentence boundary
            val lastPeriod = cut.lastIndexOf(". ")
            val splitAt = if (lastPeriod > maxLen / 2) lastPeriod + 2 else maxLen
            chunks.add(remaining.substring(0, splitAt).trim())
            remaining = remaining.substring(splitAt).trim()
        }
        if (remaining.isNotBlank()) chunks.add(remaining)
        return chunks
    }

    private fun getFileName(context: Context, uri: Uri): String? {
        return context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            cursor.moveToFirst()
            if (nameIndex >= 0) cursor.getString(nameIndex) else null
        }
    }
}
