package com.listenai.ui.import_content

import android.content.Context
import android.net.Uri
import androidx.core.net.toUri
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.listenai.data.models.Article
import com.listenai.data.models.SourceType
import com.listenai.data.repository.ArticleRepository
import com.listenai.service.import_content.PDFImportService
import com.listenai.service.import_content.WebImportService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import java.io.File
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
    private val pdfImportService: PDFImportService
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

    private fun getFileName(context: Context, uri: Uri): String? {
        return context.contentResolver.query(uri, null, null, null, null)?.use { cursor ->
            val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
            cursor.moveToFirst()
            if (nameIndex >= 0) cursor.getString(nameIndex) else null
        }
    }
}
