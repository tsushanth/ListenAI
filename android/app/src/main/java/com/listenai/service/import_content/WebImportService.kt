package com.listenai.service.import_content

import com.google.gson.Gson
import com.google.gson.annotations.SerializedName
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.jsoup.Jsoup
import org.jsoup.nodes.Document
import java.util.concurrent.TimeUnit

/**
 * Extracted content from a web page
 */
data class ExtractedWebContent(
    val title: String,
    val author: String?,
    val siteName: String?,
    val content: String,
    val imageUrl: String?,
    val publishDate: String?,
    val wordCount: Int,
    val language: String
)

/**
 * Server extraction response
 */
private data class ServerExtractionResponse(
    val title: String?,
    val author: String?,
    val siteName: String?,
    val publishDate: String?,
    val content: String,
    val excerpt: String?,
    val heroImage: String?,
    val wordCount: Int,
    val language: String,
    val sourceUrl: String
)

/**
 * Service for importing content from web URLs
 */
class WebImportService {

    private val client = OkHttpClient.Builder()
        .connectTimeout(15, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .followRedirects(true)
        .build()

    private val gson = Gson()

    private var backendUrl: String? = null
    private var authTokenProvider: (suspend () -> String)? = null

    /**
     * Configure server-side extraction (preferred method)
     */
    fun configure(backendUrl: String, authTokenProvider: suspend () -> String) {
        this.backendUrl = backendUrl
        this.authTokenProvider = authTokenProvider
    }

    /**
     * Extract content from a URL
     */
    suspend fun extractContent(url: String): ExtractedWebContent? = withContext(Dispatchers.IO) {
        // Try server-side extraction first
        backendUrl?.let { backend ->
            authTokenProvider?.let { tokenProvider ->
                try {
                    val result = extractFromServer(url, backend, tokenProvider)
                    if (result != null) return@withContext result
                } catch (e: Exception) {
                    // Fall back to local extraction
                    println("Server extraction failed, falling back to local: ${e.message}")
                }
            }
        }

        // Fall back to local extraction
        extractLocally(url)
    }

    /**
     * Extract using server-side API
     */
    private suspend fun extractFromServer(
        url: String,
        backendUrl: String,
        tokenProvider: suspend () -> String
    ): ExtractedWebContent? {
        val token = tokenProvider()
        val requestBody = gson.toJson(mapOf("url" to url))
            .toRequestBody("application/json".toMediaType())

        val request = Request.Builder()
            .url("$backendUrl/api/extract")
            .header("Authorization", "Bearer $token")
            .header("Content-Type", "application/json")
            .post(requestBody)
            .build()

        val response = client.newCall(request).execute()

        if (!response.isSuccessful) {
            return null
        }

        val responseBody = response.body?.string() ?: return null
        val serverResponse = gson.fromJson(responseBody, ServerExtractionResponse::class.java)

        return ExtractedWebContent(
            title = serverResponse.title ?: "Untitled",
            author = serverResponse.author,
            siteName = serverResponse.siteName,
            content = serverResponse.content,
            imageUrl = serverResponse.heroImage,
            publishDate = serverResponse.publishDate,
            wordCount = serverResponse.wordCount,
            language = serverResponse.language
        )
    }

    /**
     * Extract content locally using Jsoup
     */
    private fun extractLocally(url: String): ExtractedWebContent? {
        try {
            val request = Request.Builder()
                .url(url)
                .header("User-Agent", "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36")
                .build()

            val response = client.newCall(request).execute()

            if (!response.isSuccessful) {
                return null
            }

            val html = response.body?.string() ?: return null
            val document = Jsoup.parse(html, url)

            val title = extractTitle(document)
            val author = extractAuthor(document)
            val siteName = extractSiteName(document, url)
            val content = extractMainContent(document)
            val imageUrl = extractMainImage(document)
            val publishDate = extractPublishDate(document)

            if (content.isBlank()) {
                return null
            }

            val wordCount = content.split(Regex("\\s+")).size

            return ExtractedWebContent(
                title = title,
                author = author,
                siteName = siteName,
                content = content,
                imageUrl = imageUrl,
                publishDate = publishDate,
                wordCount = wordCount,
                language = "en" // Default
            )
        } catch (e: Exception) {
            return null
        }
    }

    private fun extractSiteName(document: Document, url: String): String? {
        // Try og:site_name
        val ogSiteName = document.selectFirst("meta[property=og:site_name]")?.attr("content")
        if (!ogSiteName.isNullOrBlank()) return ogSiteName

        // Extract from URL
        return try {
            java.net.URL(url).host.removePrefix("www.")
        } catch (e: Exception) {
            null
        }
    }

    private fun extractTitle(document: Document): String {
        // Try Open Graph title first
        val ogTitle = document.selectFirst("meta[property=og:title]")?.attr("content")
        if (!ogTitle.isNullOrBlank()) return ogTitle

        // Try Twitter title
        val twitterTitle = document.selectFirst("meta[name=twitter:title]")?.attr("content")
        if (!twitterTitle.isNullOrBlank()) return twitterTitle

        // Fall back to page title
        val pageTitle = document.title()
        if (pageTitle.isNotBlank()) return pageTitle

        // Try h1
        return document.selectFirst("h1")?.text() ?: "Untitled"
    }

    private fun extractAuthor(document: Document): String? {
        // Try meta author
        val metaAuthor = document.selectFirst("meta[name=author]")?.attr("content")
        if (!metaAuthor.isNullOrBlank()) return metaAuthor

        // Try article:author
        val articleAuthor = document.selectFirst("meta[property=article:author]")?.attr("content")
        if (!articleAuthor.isNullOrBlank()) return articleAuthor

        // Try common author selectors
        val authorSelectors = listOf(
            ".author-name",
            ".author",
            "[rel=author]",
            ".byline",
            ".post-author",
            "[itemprop=author]"
        )

        for (selector in authorSelectors) {
            val author = document.selectFirst(selector)?.text()
            if (!author.isNullOrBlank()) return author
        }

        return null
    }

    private fun extractMainContent(document: Document): String {
        // Remove unwanted elements
        document.select("script, style, nav, header, footer, aside, .ads, .advertisement, .comments, .related").remove()

        // Try to find article content using common selectors
        val contentSelectors = listOf(
            "article",
            "[role=main]",
            ".post-content",
            ".article-content",
            ".entry-content",
            ".content",
            "main",
            "#content"
        )

        for (selector in contentSelectors) {
            val element = document.selectFirst(selector)
            if (element != null) {
                val text = element.text()
                if (text.length > 200) {
                    return cleanExtractedText(text)
                }
            }
        }

        // Fall back to body text
        val body = document.body()
        return cleanExtractedText(body?.text() ?: "")
    }

    private fun extractMainImage(document: Document): String? {
        // Try Open Graph image
        val ogImage = document.selectFirst("meta[property=og:image]")?.attr("content")
        if (!ogImage.isNullOrBlank()) return resolveUrl(ogImage, document.baseUri())

        // Try Twitter image
        val twitterImage = document.selectFirst("meta[name=twitter:image]")?.attr("content")
        if (!twitterImage.isNullOrBlank()) return resolveUrl(twitterImage, document.baseUri())

        // Try first large image in article
        val articleImage = document.selectFirst("article img[src]")?.attr("src")
        if (!articleImage.isNullOrBlank()) return resolveUrl(articleImage, document.baseUri())

        return null
    }

    private fun extractPublishDate(document: Document): String? {
        // Try article:published_time
        val publishedTime = document.selectFirst("meta[property=article:published_time]")?.attr("content")
        if (!publishedTime.isNullOrBlank()) return publishedTime

        // Try datePublished schema
        val datePublished = document.selectFirst("[itemprop=datePublished]")?.attr("content")
        if (!datePublished.isNullOrBlank()) return datePublished

        // Try time element
        val timeElement = document.selectFirst("time[datetime]")?.attr("datetime")
        if (!timeElement.isNullOrBlank()) return timeElement

        return null
    }

    private fun cleanExtractedText(text: String): String {
        return text
            .replace(Regex("\\s+"), " ")
            .replace(Regex("\\n{3,}"), "\n\n")
            .trim()
    }

    private fun resolveUrl(url: String, baseUrl: String): String {
        return try {
            if (url.startsWith("http://") || url.startsWith("https://")) {
                url
            } else if (url.startsWith("//")) {
                "https:$url"
            } else {
                java.net.URL(java.net.URL(baseUrl), url).toString()
            }
        } catch (e: Exception) {
            url
        }
    }
}
