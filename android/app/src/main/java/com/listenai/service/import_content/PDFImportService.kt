package com.listenai.service.import_content

import android.content.Context
import android.net.Uri
import com.tom_roush.pdfbox.android.PDFBoxResourceLoader
import com.tom_roush.pdfbox.pdmodel.PDDocument
import com.tom_roush.pdfbox.text.PDFTextStripper
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * Extracted content from a PDF
 */
data class ExtractedPDFContent(
    val title: String,
    val author: String?,
    val content: String,
    val pageCount: Int
)

/**
 * Service for importing content from PDF files
 */
class PDFImportService(
    private val context: Context
) {

    init {
        // Initialize PDFBox for Android
        PDFBoxResourceLoader.init(context)
    }

    /**
     * Extract content from a PDF URI
     */
    suspend fun extractContent(uri: Uri): ExtractedPDFContent? = withContext(Dispatchers.IO) {
        try {
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                val document = PDDocument.load(inputStream)

                try {
                    val info = document.documentInformation
                    val title = info?.title?.takeIf { it.isNotBlank() }
                        ?: extractTitleFromFilename(uri)

                    val author = info?.author

                    val stripper = PDFTextStripper().apply {
                        sortByPosition = true
                    }

                    val content = stripper.getText(document)
                    val pageCount = document.numberOfPages

                    ExtractedPDFContent(
                        title = title,
                        author = author,
                        content = cleanPdfText(content),
                        pageCount = pageCount
                    )
                } finally {
                    document.close()
                }
            }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Extract content from a specific page range
     */
    suspend fun extractContentFromPages(
        uri: Uri,
        startPage: Int,
        endPage: Int
    ): String? = withContext(Dispatchers.IO) {
        try {
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                val document = PDDocument.load(inputStream)

                try {
                    val stripper = PDFTextStripper().apply {
                        this.startPage = startPage
                        this.endPage = endPage.coerceAtMost(document.numberOfPages)
                        sortByPosition = true
                    }

                    cleanPdfText(stripper.getText(document))
                } finally {
                    document.close()
                }
            }
        } catch (e: Exception) {
            null
        }
    }

    /**
     * Get PDF metadata without extracting full content
     */
    suspend fun getMetadata(uri: Uri): Map<String, String>? = withContext(Dispatchers.IO) {
        try {
            context.contentResolver.openInputStream(uri)?.use { inputStream ->
                val document = PDDocument.load(inputStream)

                try {
                    val info = document.documentInformation
                    val metadata = mutableMapOf<String, String>()

                    info?.title?.let { metadata["title"] = it }
                    info?.author?.let { metadata["author"] = it }
                    info?.subject?.let { metadata["subject"] = it }
                    info?.keywords?.let { metadata["keywords"] = it }
                    info?.creator?.let { metadata["creator"] = it }
                    info?.producer?.let { metadata["producer"] = it }
                    info?.creationDate?.let { metadata["creationDate"] = it.time.toString() }

                    metadata["pageCount"] = document.numberOfPages.toString()

                    metadata
                } finally {
                    document.close()
                }
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun extractTitleFromFilename(uri: Uri): String {
        val filename = uri.lastPathSegment ?: "Document"
        return filename
            .substringBeforeLast(".")
            .replace("_", " ")
            .replace("-", " ")
            .trim()
    }

    private fun cleanPdfText(text: String): String {
        return text
            // Remove excessive whitespace
            .replace(Regex("\\s+"), " ")
            // Fix common PDF extraction issues
            .replace(Regex("([a-z])- ([a-z])"), "$1$2") // Hyphenated words across lines
            // Remove page numbers (common patterns)
            .replace(Regex("(?m)^\\d+\\s*$"), "")
            // Normalize line breaks
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
    }
}
