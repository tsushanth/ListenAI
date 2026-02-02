package com.listenai.ui.import_content

import android.content.Intent
import android.graphics.Color as AndroidColor
import android.net.Uri
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.foundation.layout.heightIn
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import com.listenai.data.models.Article
import com.listenai.data.models.SourceType
import com.listenai.data.repository.ArticleRepository
import com.listenai.service.auth.GoogleAuthService
import com.listenai.service.import_content.GmailMessage
import com.listenai.service.import_content.GmailService
import com.listenai.ui.theme.*
import kotlinx.coroutines.launch
import org.koin.compose.koinInject
import java.text.SimpleDateFormat
import java.util.*
import kotlin.math.abs

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MailImportScreen(
    authService: GoogleAuthService = koinInject(),
    gmailService: GmailService = koinInject(),
    articleRepository: ArticleRepository = koinInject(),
    onNavigateBack: () -> Unit = {},
    onImportComplete: (String) -> Unit = {}
) {
    val context = LocalContext.current
    val activity = context as? ComponentActivity
    val scope = rememberCoroutineScope()

    val isAuthenticated by authService.isAuthenticated.collectAsState()
    val emails by gmailService.emails.collectAsState()
    val isLoading by gmailService.isLoading.collectAsState()
    val hasMorePages by gmailService.hasMorePages.collectAsState()
    val gmailError by gmailService.error.collectAsState()

    var searchText by remember { mutableStateOf("") }
    var isConnecting by remember { mutableStateOf(false) }
    var importError by remember { mutableStateOf<String?>(null) }
    var isImporting by remember { mutableStateOf(false) }
    var hasGmailAccess by remember { mutableStateOf(authService.hasGmailAccess()) }

    // Gmail sign-in launcher using deprecated GoogleSignIn API
    val gmailSignInLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.StartActivityForResult()
    ) { result ->
        scope.launch {
            val authResult = authService.handleGmailSignInResult(result.data)
            if (authResult.isSuccess) {
                hasGmailAccess = true
                isConnecting = false
                gmailService.fetchEmails(refresh = true)
            } else {
                isConnecting = false
                importError = authResult.exceptionOrNull()?.message ?: "Failed to connect to Gmail"
            }
        }
    }

    // Log state for debugging
    LaunchedEffect(Unit) {
        android.util.Log.i("MailImportScreen", "Initial state - isAuthenticated: $isAuthenticated, hasGmailAccess: $hasGmailAccess, accessToken: ${authService.getAccessToken()?.take(20)}...")
    }

    // Preview state for email content
    var previewEmail by remember { mutableStateOf<GmailMessage?>(null) }

    // Listen for auth state changes to update hasGmailAccess
    LaunchedEffect(isAuthenticated) {
        hasGmailAccess = authService.hasGmailAccess()
        if (isAuthenticated && hasGmailAccess) {
            isConnecting = false
            gmailService.fetchEmails(refresh = true)
        }
    }

    // Load emails when authenticated with Gmail access
    // Only fetch if we don't already have emails cached
    LaunchedEffect(isAuthenticated, hasGmailAccess) {
        android.util.Log.i("MailImportScreen", "LaunchedEffect triggered - isAuthenticated: $isAuthenticated, hasGmailAccess: $hasGmailAccess, emails.size: ${emails.size}")
        if (isAuthenticated && hasGmailAccess && emails.isEmpty()) {
            android.util.Log.i("MailImportScreen", "No cached emails, fetching fresh...")
            gmailService.fetchEmails(refresh = false)  // Don't force refresh, use cache if available
        } else {
            android.util.Log.i("MailImportScreen", "Using cached emails: ${emails.size} emails")
        }
    }

    // Show Gmail API errors
    LaunchedEffect(gmailError) {
        gmailError?.let { error ->
            android.util.Log.e("MailImportScreen", "Gmail error: ${error.message}")
            importError = error.message
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text("Gmail", fontWeight = FontWeight.Bold) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.Default.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (isAuthenticated) {
                        IconButton(onClick = {
                            scope.launch { gmailService.fetchEmails(refresh = true) }
                        }) {
                            Icon(Icons.Default.Refresh, contentDescription = "Refresh")
                        }
                    }
                }
            )
        }
    ) { padding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
        ) {
            // Error banner
            importError?.let { error ->
                Card(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(16.dp),
                    colors = CardDefaults.cardColors(containerColor = Red.copy(alpha = 0.1f))
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(Icons.Default.Error, contentDescription = null, tint = Red)
                        Text(error, color = Red, modifier = Modifier.weight(1f))
                        IconButton(onClick = { importError = null }) {
                            Icon(Icons.Default.Close, contentDescription = "Dismiss")
                        }
                    }
                }
            }

            if (!isAuthenticated || !hasGmailAccess) {
                // Not connected view - use deprecated GoogleSignIn API
                NotConnectedView(
                    isConnecting = isConnecting,
                    onConnect = {
                        isConnecting = true
                        gmailSignInLauncher.launch(authService.getGmailSignInIntent())
                    }
                )
            } else {
                // Search bar
                SearchBar(
                    searchText = searchText,
                    onSearchChange = { searchText = it },
                    onSearch = {
                        scope.launch { gmailService.searchEmails(searchText) }
                    },
                    onClear = {
                        searchText = ""
                        scope.launch { gmailService.fetchEmails(refresh = true) }
                    },
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                )

                when {
                    isLoading && emails.isEmpty() -> {
                        // Initial loading
                        Box(
                            modifier = Modifier.fillMaxSize(),
                            contentAlignment = Alignment.Center
                        ) {
                            Column(
                                horizontalAlignment = Alignment.CenterHorizontally,
                                verticalArrangement = Arrangement.spacedBy(16.dp)
                            ) {
                                CircularProgressIndicator()
                                Text(
                                    "Loading emails...",
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }

                    emails.isEmpty() -> {
                        // Empty state
                        EmptyEmailsView(
                            hasSearchQuery = searchText.isNotEmpty(),
                            onClearSearch = {
                                searchText = ""
                                scope.launch { gmailService.fetchEmails(refresh = true) }
                            }
                        )
                    }

                    else -> {
                        // Email list
                        LazyColumn(
                            modifier = Modifier.fillMaxSize()
                        ) {
                            items(emails) { email ->
                                EmailRow(
                                    email = email,
                                    onClick = {
                                        if (!isImporting) {
                                            isImporting = true
                                            scope.launch {
                                                try {
                                                    val fullEmail = if (email.body.isEmpty()) {
                                                        gmailService.fetchFullEmail(email.id)
                                                    } else {
                                                        email
                                                    }
                                                    isImporting = false
                                                    // Show preview instead of immediately importing
                                                    previewEmail = fullEmail
                                                } catch (e: Exception) {
                                                    isImporting = false
                                                    importError = e.message ?: "Failed to fetch email"
                                                }
                                            }
                                        }
                                    }
                                )
                                HorizontalDivider(modifier = Modifier.padding(start = 72.dp))
                            }

                            // Load more button
                            if (hasMorePages) {
                                item {
                                    Box(
                                        modifier = Modifier
                                            .fillMaxWidth()
                                            .padding(16.dp),
                                        contentAlignment = Alignment.Center
                                    ) {
                                        if (isLoading) {
                                            CircularProgressIndicator(modifier = Modifier.size(24.dp))
                                        } else {
                                            TextButton(onClick = {
                                                scope.launch { gmailService.loadMore() }
                                            }) {
                                                Text("Load More")
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        // Loading overlay during import
        if (isImporting) {
            Box(
                modifier = Modifier
                    .fillMaxSize()
                    .background(Color.Black.copy(alpha = 0.3f)),
                contentAlignment = Alignment.Center
            ) {
                Card(
                    shape = RoundedCornerShape(16.dp)
                ) {
                    Column(
                        modifier = Modifier.padding(24.dp),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(16.dp)
                    ) {
                        CircularProgressIndicator()
                        Text("Loading email...")
                    }
                }
            }
        }

        // Email preview dialog
        previewEmail?.let { email ->
            EmailPreviewDialog(
                email = email,
                onDismiss = { previewEmail = null },
                onImport = {
                    scope.launch {
                        val article = Article(
                            id = UUID.randomUUID().toString(),
                            title = email.subject.ifEmpty { "(No Subject)" },
                            author = email.senderName,
                            siteName = null,
                            publishDate = null,
                            rawText = email.body,
                            wordCount = email.body.split(Regex("\\s+")).size,
                            language = "en",
                            heroImageUrl = null,
                            // Email-specific metadata
                            senderEmail = email.senderEmail,
                            emailDate = email.date,
                            // Source tracking
                            sourceType = SourceType.EMAIL,
                            sourceUrl = null,
                            sourceFileName = null,
                            audioFileUrl = null,
                            selectedVoiceId = null
                        )
                        articleRepository.saveArticle(article)
                        previewEmail = null
                        onImportComplete(article.id)
                    }
                }
            )
        }
    }
}

/**
 * Full-screen email preview with HTML rendering support.
 * Uses WebView to display rich HTML content with images and clickable links.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun EmailPreviewDialog(
    email: GmailMessage,
    onDismiss: () -> Unit,
    onImport: () -> Unit
) {
    val context = LocalContext.current
    val density = LocalDensity.current.density

    // Track WebView height dynamically
    var webViewHeight by remember { mutableStateOf(400.dp) }

    // Get theme colors for styling
    val isDarkTheme = MaterialTheme.colorScheme.background.luminance() < 0.5f
    val textColor = if (isDarkTheme) "#E0E0E0" else "#212121"
    val backgroundColor = if (isDarkTheme) "transparent" else "transparent"
    val linkColor = "#64B5F6"

    // Build styled HTML wrapper
    val styledHtml = remember(email.htmlBody, email.body) {
        val content = email.htmlBody ?: email.body.replace("\n", "<br>")
        """
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
            <style>
                * { margin: 0; padding: 0; box-sizing: border-box; }
                html, body {
                    background-color: $backgroundColor;
                    color: $textColor;
                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                    font-size: 15px;
                    line-height: 1.6;
                    word-wrap: break-word;
                    overflow-wrap: break-word;
                }
                a { color: $linkColor; text-decoration: underline; }
                img {
                    max-width: 100%;
                    height: auto;
                    display: block;
                    margin: 8px 0;
                    border-radius: 8px;
                }
                table { max-width: 100%; border-collapse: collapse; }
                td, th { max-width: 100%; padding: 4px; }
                pre, code {
                    white-space: pre-wrap;
                    word-wrap: break-word;
                    background: rgba(128, 128, 128, 0.1);
                    padding: 2px 4px;
                    border-radius: 4px;
                    font-size: 13px;
                }
                blockquote {
                    border-left: 3px solid #666;
                    margin: 8px 0;
                    padding-left: 12px;
                    color: #888;
                }
                .email-content { padding: 0; }
                p { margin-bottom: 12px; }
                h1, h2, h3, h4, h5, h6 { margin: 16px 0 8px 0; }
                ul, ol { margin: 8px 0; padding-left: 24px; }
                li { margin: 4px 0; }
                hr {
                    border: none;
                    border-top: 1px solid #444;
                    margin: 16px 0;
                }
            </style>
        </head>
        <body>
            <div class="email-content">$content</div>
        </body>
        </html>
        """.trimIndent()
    }

    // Full screen dialog as a modal bottom sheet style
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier
            .fillMaxWidth()
            .fillMaxHeight(0.9f),
        title = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(4.dp)
            ) {
                // Subject
                Text(
                    text = email.subject.ifEmpty { "(No Subject)" },
                    fontWeight = FontWeight.Bold,
                    style = MaterialTheme.typography.titleMedium,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )
                // From
                Text(
                    text = "From: ${email.senderName} <${email.senderEmail}>",
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        },
        text = {
            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight()
            ) {
                HorizontalDivider(modifier = Modifier.padding(bottom = 8.dp))

                // WebView for HTML content with clickable links and images
                if (email.hasHtmlBody) {
                    AndroidView(
                        factory = { ctx ->
                            WebView(ctx).apply {
                                settings.apply {
                                    loadWithOverviewMode = true
                                    useWideViewPort = true
                                    setSupportZoom(false)
                                    builtInZoomControls = false
                                    displayZoomControls = false
                                    javaScriptEnabled = false  // Disabled for security
                                    allowFileAccess = false
                                    allowContentAccess = false
                                }
                                setBackgroundColor(AndroidColor.TRANSPARENT)
                                isVerticalScrollBarEnabled = true
                                isHorizontalScrollBarEnabled = false

                                // Handle link clicks - open in browser
                                webViewClient = object : WebViewClient() {
                                    override fun shouldOverrideUrlLoading(
                                        view: WebView?,
                                        request: WebResourceRequest?
                                    ): Boolean {
                                        request?.url?.let { uri ->
                                            try {
                                                val intent = Intent(Intent.ACTION_VIEW, uri)
                                                ctx.startActivity(intent)
                                            } catch (e: Exception) {
                                                android.util.Log.e("EmailPreview", "Failed to open URL: $uri", e)
                                            }
                                        }
                                        return true
                                    }

                                    override fun onPageFinished(view: WebView?, url: String?) {
                                        super.onPageFinished(view, url)
                                        // Measure content height after page loads
                                        view?.evaluateJavascript("document.body.scrollHeight") { heightStr ->
                                            try {
                                                val heightPx = heightStr.toFloatOrNull() ?: 400f
                                                val heightDp = (heightPx / density).toInt()
                                                webViewHeight = (heightDp + 16).dp.coerceIn(200.dp, 600.dp)
                                            } catch (e: Exception) {
                                                // Keep default height
                                            }
                                        }
                                    }
                                }
                            }
                        },
                        update = { webView ->
                            webView.loadDataWithBaseURL(null, styledHtml, "text/html", "UTF-8", null)
                        },
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f)
                    )
                } else {
                    // Plain text fallback with scroll
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .weight(1f)
                            .verticalScroll(rememberScrollState())
                    ) {
                        Text(
                            text = email.body.ifEmpty { "(No content)" },
                            style = MaterialTheme.typography.bodyMedium,
                            lineHeight = MaterialTheme.typography.bodyMedium.lineHeight * 1.4f
                        )
                    }
                }
            }
        },
        confirmButton = {
            Button(
                onClick = onImport,
                colors = ButtonDefaults.buttonColors(containerColor = Blue)
            ) {
                Icon(
                    imageVector = Icons.Default.PlayArrow,
                    contentDescription = null,
                    modifier = Modifier.size(18.dp)
                )
                Spacer(modifier = Modifier.width(8.dp))
                Text("Import & Listen")
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}

/**
 * Helper extension to check color luminance for theme detection
 */
private fun Color.luminance(): Float {
    val r = red
    val g = green
    val b = blue
    return 0.299f * r + 0.587f * g + 0.114f * b
}

@Composable
private fun NotConnectedView(
    isConnecting: Boolean,
    onConnect: () -> Unit
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier.padding(32.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(20.dp)
        ) {
            Icon(
                imageVector = Icons.Default.Email,
                contentDescription = null,
                modifier = Modifier.size(64.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Text(
                text = "Connect Gmail",
                style = MaterialTheme.typography.titleLarge,
                fontWeight = FontWeight.Bold
            )

            Text(
                text = "Sign in with Google to import and listen to your emails",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp)
            )

            Spacer(modifier = Modifier.height(8.dp))

            if (isConnecting) {
                CircularProgressIndicator()
            } else {
                Button(
                    onClick = onConnect,
                    colors = ButtonDefaults.buttonColors(containerColor = Blue),
                    shape = RoundedCornerShape(12.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.Email,
                        contentDescription = null,
                        modifier = Modifier.size(20.dp)
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                    Text("Sign in with Google", fontWeight = FontWeight.SemiBold)
                }
            }

            Spacer(modifier = Modifier.height(32.dp))

            Text(
                text = "We only request read access to your emails. Your data stays private.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                modifier = Modifier.padding(horizontal = 24.dp)
            )
        }
    }
}

@Composable
private fun SearchBar(
    searchText: String,
    onSearchChange: (String) -> Unit,
    onSearch: () -> Unit,
    onClear: () -> Unit,
    modifier: Modifier = Modifier
) {
    OutlinedTextField(
        value = searchText,
        onValueChange = onSearchChange,
        modifier = modifier.fillMaxWidth(),
        placeholder = { Text("Search in mail") },
        leadingIcon = {
            Icon(Icons.Default.Search, contentDescription = null)
        },
        trailingIcon = {
            if (searchText.isNotEmpty()) {
                IconButton(onClick = onClear) {
                    Icon(Icons.Default.Clear, contentDescription = "Clear")
                }
            }
        },
        singleLine = true,
        shape = RoundedCornerShape(12.dp),
        keyboardActions = androidx.compose.foundation.text.KeyboardActions(
            onSearch = { onSearch() }
        )
    )
}

@Composable
private fun EmptyEmailsView(
    hasSearchQuery: Boolean,
    onClearSearch: () -> Unit
) {
    Box(
        modifier = Modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Icon(
                imageVector = Icons.Default.Inbox,
                contentDescription = null,
                modifier = Modifier.size(48.dp),
                tint = MaterialTheme.colorScheme.onSurfaceVariant
            )

            Text(
                text = "No emails found",
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Medium
            )

            if (hasSearchQuery) {
                Text(
                    text = "Try a different search term",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                TextButton(onClick = onClearSearch) {
                    Text("Clear Search")
                }
            } else {
                Text(
                    text = "Your inbox appears to be empty",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
    }
}

@Composable
private fun EmailRow(
    email: GmailMessage,
    onClick: () -> Unit
) {
    val avatarColors = listOf(Blue, Green, Orange, Purple, Pink, Teal)
    val avatarColor = avatarColors[abs(email.senderName.hashCode()) % avatarColors.size]

    val dateFormat = remember { SimpleDateFormat("MMM d", Locale.getDefault()) }
    val timeFormat = remember { SimpleDateFormat("h:mm a", Locale.getDefault()) }

    val dateText = remember(email.date) {
        val now = Calendar.getInstance()
        val emailCal = Calendar.getInstance().apply { time = email.date }

        if (now.get(Calendar.DAY_OF_YEAR) == emailCal.get(Calendar.DAY_OF_YEAR) &&
            now.get(Calendar.YEAR) == emailCal.get(Calendar.YEAR)
        ) {
            timeFormat.format(email.date)
        } else {
            dateFormat.format(email.date)
        }
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .background(if (email.isRead) Color.Transparent else Blue.copy(alpha = 0.05f))
            .padding(horizontal = 16.dp, vertical = 12.dp),
        horizontalArrangement = Arrangement.spacedBy(12.dp),
        verticalAlignment = Alignment.Top
    ) {
        // Avatar
        Box(
            modifier = Modifier
                .size(44.dp)
                .clip(CircleShape)
                .background(avatarColor),
            contentAlignment = Alignment.Center
        ) {
            Text(
                text = email.senderName.take(1).uppercase(),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.Bold,
                color = Color.White
            )
        }

        // Content
        Column(modifier = Modifier.weight(1f)) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = email.senderName,
                    style = MaterialTheme.typography.bodyMedium,
                    fontWeight = if (email.isRead) FontWeight.Normal else FontWeight.SemiBold,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f)
                )

                Row(
                    horizontalArrangement = Arrangement.spacedBy(4.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    if (email.hasAttachment) {
                        Icon(
                            imageVector = Icons.Default.AttachFile,
                            contentDescription = null,
                            modifier = Modifier.size(14.dp),
                            tint = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Text(
                        text = dateText,
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            Spacer(modifier = Modifier.height(2.dp))

            Text(
                text = email.subject.ifEmpty { "(No Subject)" },
                style = MaterialTheme.typography.bodyMedium,
                fontWeight = if (email.isRead) FontWeight.Normal else FontWeight.Medium,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis
            )

            Spacer(modifier = Modifier.height(2.dp))

            Text(
                text = email.snippet,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )
        }
    }
}
