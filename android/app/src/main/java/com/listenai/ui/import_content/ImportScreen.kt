package com.listenai.ui.import_content

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import com.listenai.R
import com.listenai.ui.theme.*

enum class ImportMode {
    URL, DOCUMENT, TEXT, SCAN
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ImportScreen(
    initialMode: ImportMode = ImportMode.URL,
    onNavigateBack: () -> Unit = {},
    onImportComplete: (String) -> Unit = {}
) {
    var selectedMode by remember { mutableStateOf(initialMode) }
    var urlText by remember { mutableStateOf("") }
    var textContent by remember { mutableStateOf("") }
    var titleText by remember { mutableStateOf("") }
    var isLoading by remember { mutableStateOf(false) }

    val scrollState = rememberScrollState()

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
                onModeSelected = { selectedMode = it }
            )

            // Content area based on selected mode
            when (selectedMode) {
                ImportMode.URL -> UrlImportCard(
                    url = urlText,
                    onUrlChange = { urlText = it },
                    isLoading = isLoading,
                    onImport = {
                        isLoading = true
                        // Simulate import
                    }
                )

                ImportMode.DOCUMENT -> DocumentImportCard(
                    onSelectDocument = {
                        // Launch document picker
                    }
                )

                ImportMode.TEXT -> TextImportCard(
                    title = titleText,
                    onTitleChange = { titleText = it },
                    content = textContent,
                    onContentChange = { textContent = it },
                    onImport = {
                        // Handle text import
                    }
                )

                ImportMode.SCAN -> ScanImportCard(
                    onStartScan = {
                        // Launch camera for OCR
                    }
                )
            }
        }
    }
}

@Composable
private fun ImportModeSelector(
    selectedMode: ImportMode,
    onModeSelected: (ImportMode) -> Unit
) {
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

        ImportModeChip(
            icon = Icons.Default.DocumentScanner,
            label = stringResource(R.string.import_mode_scan),
            isSelected = selectedMode == ImportMode.SCAN,
            color = Purple,
            onClick = { onModeSelected(ImportMode.SCAN) },
            modifier = Modifier.weight(1f)
        )
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
                singleLine = true,
                shape = RoundedCornerShape(12.dp)
            )

            // Import button
            Button(
                onClick = onImport,
                modifier = Modifier.fillMaxWidth(),
                enabled = url.isNotBlank() && !isLoading,
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Orange)
            ) {
                if (isLoading) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = Color.White
                    )
                    Spacer(modifier = Modifier.width(8.dp))
                }
                Text(stringResource(R.string.import_button))
            }
        }
    }
}

@Composable
private fun DocumentImportCard(
    onSelectDocument: () -> Unit
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
                    .clickable(onClick = onSelectDocument),
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
    }
}

@Composable
private fun TextImportCard(
    title: String,
    onTitleChange: (String) -> Unit,
    content: String,
    onContentChange: (String) -> Unit,
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
                shape = RoundedCornerShape(12.dp)
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
                shape = RoundedCornerShape(12.dp)
            )

            // Import button
            Button(
                onClick = onImport,
                modifier = Modifier.fillMaxWidth(),
                enabled = title.isNotBlank() && content.isNotBlank(),
                shape = RoundedCornerShape(12.dp),
                colors = ButtonDefaults.buttonColors(containerColor = Green)
            ) {
                Text(stringResource(R.string.import_button))
            }
        }
    }
}

@Composable
private fun ScanImportCard(
    onStartScan: () -> Unit
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
                text = stringResource(R.string.import_scan_title),
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold
            )

            Text(
                text = stringResource(R.string.import_scan_description),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            // Scan button
            Box(
                modifier = Modifier
                    .fillMaxWidth()
                    .height(150.dp)
                    .clip(RoundedCornerShape(12.dp))
                    .background(Purple.copy(alpha = 0.1f))
                    .clickable(onClick = onStartScan),
                contentAlignment = Alignment.Center
            ) {
                Column(
                    horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(8.dp)
                ) {
                    Icon(
                        imageVector = Icons.Default.CameraAlt,
                        contentDescription = null,
                        tint = Purple,
                        modifier = Modifier.size(48.dp)
                    )
                    Text(
                        text = stringResource(R.string.import_scan_tap),
                        style = MaterialTheme.typography.bodyMedium,
                        color = Purple
                    )
                }
            }
        }
    }
}
