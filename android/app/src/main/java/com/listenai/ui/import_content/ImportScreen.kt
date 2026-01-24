package com.listenai.ui.import_content

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.listenai.R
import com.listenai.ui.theme.*
import org.koin.androidx.compose.koinViewModel

enum class ImportMode {
    URL, DOCUMENT, TEXT, CLIPBOARD, EMAIL
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportScreen(
    viewModel: ImportViewModel = koinViewModel(),
    initialMode: ImportMode = ImportMode.URL,
    onNavigateBack: () -> Unit = {},
    onImportComplete: (String) -> Unit = {},
    onNavigateToEmail: () -> Unit = {}
) {
    val context = LocalContext.current
    var selectedMode by remember { mutableStateOf(initialMode) }
    var urlText by remember { mutableStateOf("") }
    var textContent by remember { mutableStateOf("") }
    var titleText by remember { mutableStateOf("") }
    var selectedPdfUri by remember { mutableStateOf<Uri?>(null) }
    var selectedPdfName by remember { mutableStateOf<String?>(null) }

    val importState by viewModel.importState.collectAsState()
    val progress by viewModel.progress.collectAsState()

    val scrollState = rememberScrollState()

    // PDF file picker launcher
    val pdfPickerLauncher = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        uri?.let {
            selectedPdfUri = it
            // Get file name
            context.contentResolver.query(it, null, null, null, null)?.use { cursor ->
                val nameIndex = cursor.getColumnIndex(android.provider.OpenableColumns.DISPLAY_NAME)
                cursor.moveToFirst()
                if (nameIndex >= 0) {
                    selectedPdfName = cursor.getString(nameIndex)
                }
            }
        }
    }

    // Get clipboard content
    val clipboardManager = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    val clipboardText = remember(selectedMode) {
        if (selectedMode == ImportMode.CLIPBOARD) {
            clipboardManager.primaryClip?.getItemAt(0)?.text?.toString() ?: ""
        } else ""
    }

    // Handle import state changes
    LaunchedEffect(importState) {
        when (val state = importState) {
            is ImportState.Success -> {
                onImportComplete(state.articleId)
                viewModel.resetState()
            }
            is ImportState.Error -> {
                // Error shown in UI
            }
            else -> {}
        }
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = {
                    Text(
                        text = stringResource(R.string.import_title),
                        fontWeight = FontWeight.Bold
                    )
                },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = stringResource(R.string.close)
                        )
                    }
                }
            )
        }
    ) { paddingValues ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(paddingValues)
                .verticalScroll(scrollState)
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(24.dp)
        ) {
            // Import mode selector
            ImportModeSelector(
                selectedMode = selectedMode,
                onModeSelected = { selectedMode = it },
                onEmailClick = onNavigateToEmail
            )

            // Error message
            if (importState is ImportState.Error) {
                Card(
                    modifier = Modifier.fillMaxWidth(),
                    colors = CardDefaults.cardColors(containerColor = Red.copy(alpha = 0.1f))
                ) {
                    Row(
                        modifier = Modifier.padding(16.dp),
                        horizontalArrangement = Arrangement.spacedBy(12.dp),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Icon(
                            imageVector = Icons.Default.Error,
                            contentDescription = null,
                            tint = Red
                        )
                        Text(
                            text = (importState as ImportState.Error).message,
                            color = Red
                        )
                    }
                }
            }

            // Progress indicator
            if (importState is ImportState.Loading) {
                LinearProgressIndicator(
                    progress = progress,
                    modifier = Modifier.fillMaxWidth(),
                    color = Blue
                )
            }

            // Content area based on selected mode
            when (selectedMode) {
                ImportMode.URL -> UrlImportCard(
                    url = urlText,
                    onUrlChange = { urlText = it },
                    isLoading = importState is ImportState.Loading,
                    onImport = { viewModel.importFromUrl(urlText, context) }
                )

                ImportMode.DOCUMENT -> DocumentImportCard(
                    selectedFileName = selectedPdfName,
                    isLoading = importState is ImportState.Loading,
                    onSelectDocument = {
                        pdfPickerLauncher.launch(arrayOf("application/pdf"))
                    },
                    onClearSelection = {
                        selectedPdfUri = null
                        selectedPdfName = null
                    },
                    onImport = {
                        selectedPdfUri?.let { uri ->
                            viewModel.importFromPdf(context, uri)
                        }
                    }
                )

                ImportMode.TEXT -> TextImportCard(
                    title = titleText,
                    onTitleChange = { titleText = it },
                    content = textContent,
                    onContentChange = { textContent = it },
                    isLoading = importState is ImportState.Loading,
                    onImport = { viewModel.importFromText(titleText, textContent) }
                )

                ImportMode.CLIPBOARD -> ClipboardImportCard(
                    clipboardContent = clipboardText,
                    isLoading = importState is ImportState.Loading,
                    onRefresh = {
                        // Force recomposition by changing mode back and forth
                        selectedMode = ImportMode.URL
                        selectedMode = ImportMode.CLIPBOARD
                    },
                    onImport = { viewModel.importFromClipboard(clipboardText) }
                )

                ImportMode.EMAIL -> {
                    // Email mode navigates to separate screen
                    // This case shouldn't be reached since clicking Email triggers navigation
                }
            }
        }
    }
}

@Composable
private fun ImportModeSelector(
    selectedMode: ImportMode,
    onModeSelected: (ImportMode) -> Unit,
    onEmailClick: () -> Unit
) {
    Column(
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        // First row - URL, Document, Text
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            ImportModeChip(
                icon = Icons.Default.Link,
                label = stringResource(R.string.import_mode_url),
                isSelected = selectedMode == ImportMode.URL,
                color = Orange,
                onClick = { onModeSelected(ImportMode.URL) },
                modifier = Modifier.weight(1f)
            )

            ImportModeChip(
                icon = Icons.Default.Description,
                label = stringResource(R.string.import_mode_document),
                isSelected = selectedMode == ImportMode.DOCUMENT,
                color = Blue,
                onClick = { onModeSelected(ImportMode.DOCUMENT) },
                modifier = Modifier.weight(1f)
            )

            ImportModeChip(
                icon = Icons.Default.EditNote,
                label = stringResource(R.string.import_mode_text),
                isSelected = selectedMode == ImportMode.TEXT,
                color = Green,
                onClick = { onModeSelected(ImportMode.TEXT) },
                modifier = Modifier.weight(1f)
            )
        }

        // Second row - Clipboard and Email
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            ImportModeChip(
                icon = Icons.Default.ContentPaste,
                label = "Clipboard",
                isSelected = selectedMode == ImportMode.CLIPBOARD,
                color = Purple,
                onClick = { onModeSelected(ImportMode.CLIPBOARD) },
                modifier = Modifier.weight(1f)
            )

            ImportModeChip(
                icon = Icons.Default.Email,
                label = "Email",
                isSelected = false,
                color = Red,
                onClick = onEmailClick,
                modifier = Modifier.weight(1f)
            )

            // Spacer to balance the row
            Spacer(modifier = Modifier.weight(1f))
        }
    }
}

@Composable
private fun ImportModeChip(
    icon: ImageVector,
    label: String,
    isSelected: Boolean,
    color: Color,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Surface(
        onClick = onClick,
        modifier = modifier,
        shape = RoundedCornerShape(12.dp),
        color = if (isSelected) color.copy(alpha = 0.15f) else MaterialTheme.colorScheme.surfaceVariant
    ) {
        Column(
            modifier = Modifier.padding(12.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = if (isSelected) color else MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(24.dp)
            )
            Text(
                text = label,
                style = MaterialTheme.typography.labelSmall,
                color = if (isSelected) color else MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun UrlImportCard(
    url: String,
    onUrlChange: (String) -> Unit,
    isLoading: Boolean,
    onImport: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = stringResource(R.string.import_url_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )

            Text(
                text = stringResource(R.string.import_url_description),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // URL input field
            OutlinedTextField(
                value = url,
                onValueChange = onUrlChange,
                modifier = Modifier.fillMaxWidth(),
                placeholder = {
                    Text(stringResource(R.string.import_url_placeholder))
                },
                leadingIcon = {
                    Icon(
                        imageVector = Icons.Default.Link,
                        contentDescription = null,
                        tint = Orange
                    )
                },
                trailingIcon = {
                    if (url.isNotEmpty()) {
                        IconButton(onClick = { onUrlChange("") }) {
                            Icon(
                                imageVector = Icons.Default.Clear,
                                contentDescription = "Clear"
                            )
                        }
                    }
                },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                enabled = !isLoading
            )

            // Import button
            Button(
                onClick = onImport,
                modifier = Modifier.fillMaxWidth(),
                enabled = url.isNotBlank() && !isLoading,
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Orange)
            ) {
                Text(if (isLoading) "Importing..." else stringResource(R.string.import_button))
            }
        }
    }
}

@Composable
private fun DocumentImportCard(
    selectedFileName: String?,
    isLoading: Boolean,
    onSelectDocument: () -> Unit,
    onClearSelection: () -> Unit,
    onImport: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = stringResource(R.string.import_document_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )

            Text(
                text = stringResource(R.string.import_document_description),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // Selected file display or drop zone
            if (selectedFileName != null) {
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clip(RoundedCornerShape(12.dp))
                        .background(Blue.copy(alpha = 0.1f))
                        .padding(16.dp),
                    horizontalArrangement = Arrangement.spacedBy(12.dp),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Icon(
                        imageVector = Icons.Default.PictureAsPdf,
                        contentDescription = null,
                        tint = Red,
                        modifier = Modifier.size(32.dp)
                    )
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = selectedFileName,
                            style = MaterialTheme.typography.bodyMedium,
                            fontWeight = FontWeight.Medium
                        )
                        Text(
                            text = "PDF selected",
                            style = MaterialTheme.typography.bodySmall,
                            color = Green
                        )
                    }
                    IconButton(onClick = onClearSelection) {
                        Icon(
                            imageVector = Icons.Default.Close,
                            contentDescription = "Remove"
                        )
                    }
                }
            } else {
                // Drop zone
                Box(
                    modifier = Modifier
                        .fillMaxWidth()
                        .height(150.dp)
                        .clip(RoundedCornerShape(12.dp))
                        .border(
                            width = 2.dp,
                            color = Blue.copy(alpha = 0.3f),
                            shape = RoundedCornerShape(12.dp)
                        )
                        .clickable(onClick = onSelectDocument, enabled = !isLoading),
                    contentAlignment = Alignment.Center
                ) {
                    Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.spacedBy(8.dp)
                    ) {
                        Icon(
                            imageVector = Icons.Default.CloudUpload,
                            contentDescription = null,
                            tint = Blue,
                            modifier = Modifier.size(48.dp)
                        )
                        Text(
                            text = stringResource(R.string.import_document_tap),
                            style = MaterialTheme.typography.bodyMedium,
                            color = Blue
                        )
                        Text(
                            text = stringResource(R.string.import_document_formats),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // Import button
            if (selectedFileName != null) {
                Button(
                    onClick = onImport,
                    modifier = Modifier.fillMaxWidth(),
                    enabled = !isLoading,
                    shape = RoundedCornerShape(12.dp),
                    colors = ButtonDefaults.buttonColors(containerColor = Blue)
                ) {
                    Text(if (isLoading) "Importing..." else stringResource(R.string.import_button))
                }
            }
        }
    }
}

@Composable
private fun TextImportCard(
    title: String,
    onTitleChange: (String) -> Unit,
    content: String,
    onContentChange: (String) -> Unit,
    isLoading: Boolean,
    onImport: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Text(
                text = stringResource(R.string.import_text_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )

            // Title field
            OutlinedTextField(
                value = title,
                onValueChange = onTitleChange,
                modifier = Modifier.fillMaxWidth(),
                placeholder = {
                    Text(stringResource(R.string.import_text_title_placeholder))
                },
                singleLine = true,
                shape = RoundedCornerShape(12.dp),
                enabled = !isLoading
            )

            // Content field
            OutlinedTextField(
                value = content,
                onValueChange = onContentChange,
                modifier = Modifier
                    .fillMaxWidth()
                    .height(200.dp),
                placeholder = {
                    Text(stringResource(R.string.import_text_content_placeholder))
                },
                shape = RoundedCornerShape(12.dp),
                enabled = !isLoading
            )

            // Word count
            if (content.isNotBlank()) {
                val wordCount = content.split(Regex("\\s+")).size
                Text(
                    text = "$wordCount words",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }

            // Import button
            Button(
                onClick = onImport,
                modifier = Modifier.fillMaxWidth(),
                enabled = content.isNotBlank() && !isLoading,
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Green)
            ) {
                Text(if (isLoading) "Importing..." else stringResource(R.string.import_button))
            }
        }
    }
}

@Composable
private fun ClipboardImportCard(
    clipboardContent: String,
    isLoading: Boolean,
    onRefresh: () -> Unit,
    onImport: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth(),
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surfaceVariant
        )
    ) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Text(
                    text = "Import from Clipboard",
                    style = MaterialTheme.typography.titleMedium,
                    fontWeight = FontWeight.SemiBold
                )
                IconButton(onClick = onRefresh) {
                    Icon(
                        imageVector = Icons.Default.Refresh,
                        contentDescription = "Refresh"
                    )
                }
            }

            Text(
                text = "Import text or URLs you've copied",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // Clipboard preview
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .heightIn(min = 100.dp, max = 200.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(MaterialTheme.colorScheme.surface)
                    .padding(16.dp)
            ) {
                if (clipboardContent.isNotBlank()) {
                    Column {
                        Row(
                            horizontalArrangement = Arrangement.spacedBy(8.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            Icon(
                                imageVector = if (clipboardContent.startsWith("http"))
                                    Icons.Default.Link else Icons.Default.TextFields,
                                contentDescription = null,
                                tint = Purple,
                                modifier = Modifier.size(20.dp)
                            )
                            Text(
                                text = if (clipboardContent.startsWith("http")) "URL detected" else "Text content",
                                style = MaterialTheme.typography.labelMedium,
                                color = Purple
                            )
                        }
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = clipboardContent.take(500) + if (clipboardContent.length > 500) "..." else "",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurface
                        )
                    }
                } else {
                    Column(
                        modifier = Modifier.fillMaxSize(),
                        horizontalAlignment = Alignment.CenterHorizontally,
                        verticalArrangement = Arrangement.Center
                    ) {
                        Icon(
                            imageVector = Icons.Default.ContentPaste,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.5f),
                            modifier = Modifier.size(32.dp)
                        )
                        Spacer(modifier = Modifier.height(8.dp))
                        Text(
                            text = "Clipboard is empty",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
            }

            // Import button
            Button(
                onClick = onImport,
                modifier = Modifier.fillMaxWidth(),
                enabled = clipboardContent.isNotBlank() && !isLoading,
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Purple)
            ) {
                Text(if (isLoading) "Importing..." else stringResource(R.string.import_button))
            }
        }
    }
}
