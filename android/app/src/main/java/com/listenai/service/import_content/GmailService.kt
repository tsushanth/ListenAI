package com.listenai.service.import_content

import android.util.Base64
import android.util.Log
import com.listenai.service.auth.GoogleAuthService
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.withContext
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import org.jsoup.Jsoup
import org.jsoup.safety.Safelist
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.TimeUnit

/**
 * Email body content - stores both HTML and plain text versions
 */
data class EmailBodyContent(
    val html: String? = null,
    val text: String? = null
) {
    /** Get the best display content (HTML preferred, fallback to text) */
    val displayContent: String get() = html ?: text ?: ""

    /** Get clean text for TTS (always plain text without HTML) */
    val ttsContent: String get() = text ?: ""

    /** Check if HTML content is available */
    val hasHtml: Boolean get() = !html.isNullOrBlank()
}

/**
 * Gmail message data class
 */
data class GmailMessage(
    val id: String,
    val threadId: String,
    val subject: String,
    val senderName: String,
    val senderEmail: String,
    val snippet: String,
    val body: String,  // Plain text body for TTS (kept for backward compatibility)
    val bodyContent: EmailBodyContent? = null,  // Rich body with HTML and text
    val date: Date,
    val isRead: Boolean,
    val hasAttachment: Boolean
) {
    /** Get HTML body if available */
    val htmlBody: String? get() = bodyContent?.html

    /** Check if rich HTML content is available */
    val hasHtmlBody: Boolean get() = bodyContent?.hasHtml == true
}

/**
 * Gmail service error types
 */
sealed class GmailError(val message: String) {
    object NotAuthenticated : GmailError("Not signed in with Google")
    object Unauthorized : GmailError("Gmail access not authorized")
    object FetchFailed : GmailError("Failed to fetch emails")
    object InvalidResponse : GmailError("Invalid response from Gmail API")
    data class ApiError(val code: Int, val detail: String) : GmailError("Gmail API error: $detail")
}

/**
 * Service for fetching and managing Gmail messages.
 */
class GmailService(
    private val authService: GoogleAuthService
) {
    companion object {
        private const val TAG = "GmailService"
        private const val BASE_URL = "https://gmail.googleapis.com/gmail/v1"
    }

    // State
    private val _emails = MutableStateFlow<List<GmailMessage>>(emptyList())
    val emails: StateFlow<List<GmailMessage>> = _emails.asStateFlow()

    private val _isLoading = MutableStateFlow(false)
    val isLoading: StateFlow<Boolean> = _isLoading.asStateFlow()

    private val _error = MutableStateFlow<GmailError?>(null)
    val error: StateFlow<GmailError?> = _error.asStateFlow()

    private val _hasMorePages = MutableStateFlow(true)
    val hasMorePages: StateFlow<Boolean> = _hasMorePages.asStateFlow()

    private var nextPageToken: String? = null

    private val httpClient = OkHttpClient.Builder()
        .connectTimeout(30, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .build()

    /**
     * Fetch emails from Gmail inbox
     */
    suspend fun fetchEmails(
        maxResults: Int = 20,
        query: String? = null,
        refresh: Boolean = false
    ) = withContext(Dispatchers.IO) {
        Log.d(TAG, "fetchEmails called - refresh: $refresh, isAuthenticated: ${authService.isAuthenticated.value}")

        if (!authService.isAuthenticated.value) {
            Log.e(TAG, "Not authenticated, returning")
            _error.value = GmailError.NotAuthenticated
            return@withContext
        }

        if (refresh) {
            _emails.value = emptyList()
            nextPageToken = null
            _hasMorePages.value = true
        }

        if (!_hasMorePages.value) {
            Log.d(TAG, "No more pages, returning")
            return@withContext
        }

        _isLoading.value = true
        _error.value = null

        try {
            var token = authService.getAccessToken()
            Log.d(TAG, "Access token: ${token?.take(20)}...")
            if (token == null) {
                // Try refreshing the token
                Log.d(TAG, "No token stored, attempting refresh...")
                token = authService.refreshGmailToken()
                if (token == null) {
                    throw IllegalStateException("No Gmail access token. Please sign in with Gmail permissions.")
                }
                Log.d(TAG, "Token refreshed successfully")
            }

            // Build URL for listing messages
            val urlBuilder = StringBuilder("$BASE_URL/users/me/messages?maxResults=$maxResults&labelIds=INBOX")

            query?.takeIf { it.isNotEmpty() }?.let {
                urlBuilder.append("&q=$it")
            }

            nextPageToken?.let {
                urlBuilder.append("&pageToken=$it")
            }

            Log.d(TAG, "Fetching: ${urlBuilder.toString()}")

            val request = Request.Builder()
                .url(urlBuilder.toString())
                .addHeader("Authorization", "Bearer $token")
                .get()
                .build()

            val response = httpClient.newCall(request).execute()
            Log.d(TAG, "Response code: ${response.code}")

            when (response.code) {
                401 -> {
                    Log.e(TAG, "Unauthorized - token may be expired, attempting refresh")
                    // Try to refresh the token and retry once
                    val newToken = authService.refreshGmailToken()
                    if (newToken != null) {
                        Log.d(TAG, "Token refreshed, retrying fetch")
                        // Retry the request with the new token
                        val retryRequest = Request.Builder()
                            .url(urlBuilder.toString())
                            .addHeader("Authorization", "Bearer $newToken")
                            .get()
                            .build()
                        val retryResponse = httpClient.newCall(retryRequest).execute()
                        if (retryResponse.code == 200) {
                            val retryBody = retryResponse.body?.string() ?: throw IllegalStateException("Empty response")
                            val retryJson = JSONObject(retryBody)
                            processEmailsResponse(retryJson, newToken)
                            return@withContext
                        }
                    }
                    _error.value = GmailError.Unauthorized
                    return@withContext
                }
                200 -> {
                    val body = response.body?.string() ?: throw IllegalStateException("Empty response")
                    val json = JSONObject(body)
                    processEmailsResponse(json, token)
                }
                else -> {
                    val errorBody = response.body?.string() ?: "Unknown error"
                    Log.e(TAG, "List failed (${response.code}): $errorBody")
                    _error.value = GmailError.ApiError(response.code, errorBody)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Error fetching emails: ${e.message}", e)
            _error.value = GmailError.FetchFailed
        } finally {
            _isLoading.value = false
        }
    }

    /**
     * Process email list response and fetch message details
     */
    private suspend fun processEmailsResponse(json: JSONObject, token: String) {
        nextPageToken = if (json.has("nextPageToken")) json.getString("nextPageToken") else null
        _hasMorePages.value = nextPageToken != null

        val messagesArray = json.optJSONArray("messages")
        if (messagesArray == null) {
            Log.d(TAG, "No messages in response")
            return
        }

        Log.d(TAG, "Found ${messagesArray.length()} messages")

        // Get existing email IDs to avoid duplicates
        val existingIds = _emails.value.map { it.id }.toSet()

        // Fetch message details for each ID (skip already loaded ones)
        val newEmails = mutableListOf<GmailMessage>()
        for (i in 0 until messagesArray.length()) {
            val msgObj = messagesArray.getJSONObject(i)
            val messageId = msgObj.getString("id")

            // Skip if we already have this email
            if (messageId in existingIds) {
                Log.d(TAG, "Skipping already loaded email: $messageId")
                continue
            }

            try {
                val fullMessage = fetchMessageDetails(messageId, token, "metadata")
                newEmails.add(fullMessage)
            } catch (e: Exception) {
                Log.e(TAG, "Failed to fetch message $messageId", e)
            }
        }

        Log.d(TAG, "Successfully fetched ${newEmails.size} new emails (${existingIds.size} already cached)")
        _emails.value = _emails.value + newEmails
    }

    /**
     * Fetch full email content
     */
    suspend fun fetchFullEmail(messageId: String): GmailMessage = withContext(Dispatchers.IO) {
        if (!authService.isAuthenticated.value) {
            throw IllegalStateException("Not authenticated")
        }

        val token = authService.getAccessToken()
            ?: throw IllegalStateException("No Gmail access token")

        fetchMessageDetails(messageId, token, "full")
    }

    /**
     * Search emails
     */
    suspend fun searchEmails(query: String) {
        fetchEmails(query = query, refresh = true)
    }

    /**
     * Load more emails (pagination)
     */
    suspend fun loadMore() {
        fetchEmails()
    }

    /**
     * Clear cached emails
     */
    fun clearCache() {
        _emails.value = emptyList()
        nextPageToken = null
        _hasMorePages.value = true
        _error.value = null
    }

    private suspend fun fetchMessageDetails(
        messageId: String,
        token: String,
        format: String
    ): GmailMessage = withContext(Dispatchers.IO) {
        val metadataHeaders = if (format == "metadata") {
            "&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date"
        } else ""

        val request = Request.Builder()
            .url("$BASE_URL/users/me/messages/$messageId?format=$format$metadataHeaders")
            .addHeader("Authorization", "Bearer $token")
            .get()
            .build()

        val response = httpClient.newCall(request).execute()

        if (!response.isSuccessful) {
            throw IllegalStateException("Failed to fetch message: ${response.code}")
        }

        val body = response.body?.string() ?: throw IllegalStateException("Empty response")
        val json = JSONObject(body)

        parseMessage(json, format == "full")
    }

    private fun parseMessage(json: JSONObject, includeBody: Boolean): GmailMessage {
        val id = json.getString("id")
        val threadId = json.getString("threadId")
        val snippet = json.optString("snippet", "")

        // Parse labels to check if read
        val labelIds = json.optJSONArray("labelIds")
        val isRead = labelIds?.let { labels ->
            (0 until labels.length()).none { labels.getString(it) == "UNREAD" }
        } ?: true

        // Parse headers
        val payload = json.optJSONObject("payload")
        val headers = payload?.optJSONArray("headers")

        var subject = ""
        var from = ""
        var dateStr = ""

        headers?.let { h ->
            for (i in 0 until h.length()) {
                val header = h.getJSONObject(i)
                when (header.getString("name").lowercase()) {
                    "subject" -> subject = header.getString("value")
                    "from" -> from = header.getString("value")
                    "date" -> dateStr = header.getString("value")
                }
            }
        }

        // Parse sender
        val (senderName, senderEmail) = parseFromHeader(from)

        // Parse date
        val date = parseDate(dateStr)

        // Check for attachments
        val hasAttachment = checkForAttachments(payload)

        // Parse body if requested
        val bodyContent = if (includeBody) {
            extractBodyContent(payload)
        } else null

        return GmailMessage(
            id = id,
            threadId = threadId,
            subject = subject,
            senderName = senderName,
            senderEmail = senderEmail,
            snippet = snippet,
            body = bodyContent?.ttsContent ?: "",  // Plain text for backward compatibility
            bodyContent = bodyContent,
            date = date,
            isRead = isRead,
            hasAttachment = hasAttachment
        )
    }

    private fun parseFromHeader(from: String): Pair<String, String> {
        // Format: "Name <email@example.com>" or just "email@example.com"
        val regex = """(.+?)\s*<(.+?)>""".toRegex()
        val match = regex.find(from)

        return if (match != null) {
            val name = match.groupValues[1].trim().removeSurrounding("\"")
            val email = match.groupValues[2].trim()
            Pair(name, email)
        } else {
            Pair(from, from)
        }
    }

    private fun parseDate(dateStr: String): Date {
        val formats = listOf(
            "EEE, d MMM yyyy HH:mm:ss Z",
            "d MMM yyyy HH:mm:ss Z",
            "EEE, d MMM yyyy HH:mm:ss z",
            "yyyy-MM-dd'T'HH:mm:ss'Z'"
        )

        for (format in formats) {
            try {
                return SimpleDateFormat(format, Locale.US).parse(dateStr) ?: Date()
            } catch (e: Exception) {
                // Try next format
            }
        }

        return Date()
    }

    private fun checkForAttachments(payload: JSONObject?): Boolean {
        payload ?: return false

        // Check main part
        if (payload.optString("filename", "").isNotEmpty()) {
            return true
        }

        // Check nested parts
        val parts = payload.optJSONArray("parts")
        if (parts != null) {
            for (i in 0 until parts.length()) {
                val part = parts.getJSONObject(i)
                if (part.optString("filename", "").isNotEmpty()) {
                    return true
                }
                // Recursively check nested parts
                if (checkForAttachments(part)) {
                    return true
                }
            }
        }

        return false
    }

    /**
     * Extract both HTML and plain text body from email payload.
     * Returns EmailBodyContent with both formats when available.
     */
    private fun extractBodyContent(payload: JSONObject?): EmailBodyContent {
        payload ?: return EmailBodyContent()

        val mimeType = payload.optString("mimeType", "")
        var plainText: String? = null
        var htmlContent: String? = null

        // Check parts for multipart messages
        val parts = payload.optJSONArray("parts")
        if (parts != null) {
            // Extract text/plain
            for (i in 0 until parts.length()) {
                val part = parts.getJSONObject(i)
                val partMime = part.optString("mimeType")
                if (partMime == "text/plain" && plainText == null) {
                    val data = part.optJSONObject("body")?.optString("data")
                    if (!data.isNullOrEmpty()) {
                        plainText = decodeBase64(data)
                    }
                }
            }

            // Extract text/html
            for (i in 0 until parts.length()) {
                val part = parts.getJSONObject(i)
                val partMime = part.optString("mimeType")
                if (partMime == "text/html" && htmlContent == null) {
                    val data = part.optJSONObject("body")?.optString("data")
                    if (!data.isNullOrEmpty()) {
                        htmlContent = decodeBase64(data)
                    }
                }
            }

            // Check nested multipart structures
            for (i in 0 until parts.length()) {
                val part = parts.getJSONObject(i)
                val partMime = part.optString("mimeType")
                if (partMime.startsWith("multipart/")) {
                    val nestedContent = extractBodyContent(part)
                    if (plainText == null && nestedContent.text != null) {
                        plainText = nestedContent.text
                    }
                    if (htmlContent == null && nestedContent.html != null) {
                        htmlContent = nestedContent.html
                    }
                }
            }
        }

        // Direct body (for non-multipart emails)
        if (plainText == null && htmlContent == null) {
            val bodyData = payload.optJSONObject("body")?.optString("data")
            if (!bodyData.isNullOrEmpty()) {
                val decoded = decodeBase64(bodyData)
                if (mimeType == "text/html") {
                    htmlContent = decoded
                } else {
                    plainText = decoded
                }
            }
        }

        // If we only have HTML, generate plain text from it
        if (plainText == null && htmlContent != null) {
            plainText = stripHtml(htmlContent)
        }

        return EmailBodyContent(
            html = htmlContent,
            text = plainText?.let { cleanEmailText(it) }
        )
    }

    /**
     * Legacy method - returns plain text only for backward compatibility
     */
    private fun extractBody(payload: JSONObject?): String {
        return extractBodyContent(payload).ttsContent
    }

    private fun decodeBase64(data: String): String {
        return try {
            // Gmail uses URL-safe base64
            val decoded = Base64.decode(data, Base64.URL_SAFE)
            String(decoded, Charsets.UTF_8)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to decode base64", e)
            ""
        }
    }

    private fun stripHtml(html: String): String {
        return try {
            // Use Jsoup for proper HTML parsing
            val doc = Jsoup.parse(html)

            // Remove unwanted elements entirely
            doc.select("script, style, nav, header, footer, aside, noscript, iframe, form, input, button").remove()

            // Remove hidden elements
            doc.select("[style*=display:none], [style*=display: none], [hidden]").remove()

            // Remove email-specific clutter elements
            doc.select(".gmail_signature, .gmail_quote, .gmail_attr").remove()
            doc.select(".moz-signature, .moz-cite-prefix").remove()
            doc.select("[class*=signature], [class*=footer]").remove()

            // Convert links to just their text
            doc.select("a").forEach { it.unwrap() }

            // Add newlines before block elements for proper spacing
            doc.select("p, div, h1, h2, h3, h4, h5, h6, li, tr, br").forEach { element ->
                element.before("\\n")
            }
            doc.select("p, div, h1, h2, h3, h4, h5, h6").forEach { element ->
                element.after("\\n")
            }

            // Add bullet points for list items
            doc.select("li").forEach { it.prepend("• ") }

            // Get text (Jsoup handles entity decoding automatically)
            var text = doc.text()

            // Convert the literal \n back to real newlines
            text = text.replace("\\n", "\n")

            // Post-process the text
            text = cleanEmailText(text)

            text.trim()
        } catch (e: Exception) {
            Log.e(TAG, "Jsoup parsing failed, falling back to regex", e)
            stripHtmlFallback(html)
        }
    }

    private fun cleanEmailText(text: String): String {
        var result = text

        // Remove email-specific clutter
        // Remove quoted reply markers
        result = result.replace(Regex("^>+\\s*", RegexOption.MULTILINE), "")

        // Remove common email signatures patterns
        result = result.replace(Regex("--\\s*\n[\\s\\S]*$"), "")
        result = result.replace(Regex("Sent from my (iPhone|iPad|Android|mobile device)[\\s\\S]*$", RegexOption.IGNORE_CASE), "")
        result = result.replace(Regex("Get Outlook for (iOS|Android)[\\s\\S]*$", RegexOption.IGNORE_CASE), "")

        // Remove forwarded message headers
        result = result.replace(Regex("-+\\s*(Forwarded message|Original Message)\\s*-+", RegexOption.IGNORE_CASE), "\n")

        // Remove URLs (they don't help with audio)
        result = result.replace(Regex("https?://[^\\s]+"), "")
        result = result.replace(Regex("www\\.[^\\s]+"), "")

        // Normalize whitespace
        result = result.replace("\r\n", "\n")
        result = result.replace("\r", "\n")
        result = result.replace(Regex("[ \\t]+"), " ")
        result = result.replace(Regex(" *\\n *"), "\n")
        result = result.replace(Regex("\\n{3,}"), "\n\n")

        // Trim each line
        result = result.lines().joinToString("\n") { it.trim() }

        return result
    }

    private fun stripHtmlFallback(html: String): String {
        var text = html

        // Remove script and style content entirely
        text = text.replace(Regex("<script[^>]*>[\\s\\S]*?</script>", RegexOption.IGNORE_CASE), "")
        text = text.replace(Regex("<style[^>]*>[\\s\\S]*?</style>", RegexOption.IGNORE_CASE), "")

        // Replace block elements with newlines
        text = text.replace(Regex("</p>", RegexOption.IGNORE_CASE), "\n\n")
        text = text.replace(Regex("</div>", RegexOption.IGNORE_CASE), "\n")
        text = text.replace(Regex("</h[1-6]>", RegexOption.IGNORE_CASE), "\n\n")
        text = text.replace(Regex("<br\\s*/?>", RegexOption.IGNORE_CASE), "\n")
        text = text.replace(Regex("<li[^>]*>", RegexOption.IGNORE_CASE), "• ")
        text = text.replace(Regex("</li>", RegexOption.IGNORE_CASE), "\n")

        // Remove all remaining HTML tags
        text = text.replace(Regex("<[^>]+>"), "")

        // Decode common HTML entities
        text = text.replace("&nbsp;", " ")
        text = text.replace("&amp;", "&")
        text = text.replace("&lt;", "<")
        text = text.replace("&gt;", ">")
        text = text.replace("&quot;", "\"")
        text = text.replace("&#39;", "'")
        text = text.replace("&apos;", "'")

        return cleanEmailText(text)
    }
}
