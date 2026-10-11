package com.listenai.ui.import_content

import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.listenai.R
import com.listenai.service.import_content.IncomingContent
import com.listenai.ui.theme.ListenAmber
import com.listenai.ui.theme.ListenCardBorder
import com.listenai.ui.theme.ListenCreamTile
import com.listenai.ui.theme.ListenInk
import com.listenai.ui.theme.ListenInkSecondary
import org.koin.androidx.compose.koinViewModel

/**
 * Confirmation sheet for content handed to ReadAloud from another app (Share,
 * "Read aloud" in the text-selection menu, or Open with). Shows what was
 * received so the user can see it landed, then imports it and either opens the
 * player or just saves it to the library.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun IncomingContentSheet(
    content: IncomingContent,
    onDismiss: () -> Unit,
    onReadNow: (articleId: String) -> Unit,
    viewModel: ImportViewModel = koinViewModel()
) {
    val context = LocalContext.current
    val state by viewModel.importState.collectAsState()
    // Remembers which button was pressed so a finished import knows whether to open the player.
    var openAfterImport by remember(content) { mutableStateOf(true) }
    var readError by remember(content) { mutableStateOf<String?>(null) }
    val busy = state is ImportState.Loading

    LaunchedEffect(state) {
        val done = state as? ImportState.Success ?: return@LaunchedEffect
        viewModel.resetState()
        if (openAfterImport) onReadNow(done.articleId) else onDismiss()
    }

    fun start(open: Boolean) {
        openAfterImport = open
        readError = null
        when (content) {
            is IncomingContent.Text -> viewModel.importFromText(title = titleFor(content.text), content = content.text)
            is IncomingContent.Link -> viewModel.importFromUrl(content.url, context)
            is IncomingContent.Document -> when (content.kind) {
                IncomingContent.Kind.PDF -> viewModel.importFromPdf(context, content.uri)
                IncomingContent.Kind.EPUB -> viewModel.importFromEpub(context, content.uri)
                IncomingContent.Kind.TEXT -> {
                    val text = runCatching {
                        context.contentResolver.openInputStream(content.uri)?.bufferedReader()?.use { it.readText() }
                    }.getOrNull().orEmpty()
                    val name = content.displayName?.substringBeforeLast('.').orEmpty()
                    if (text.isBlank()) {
                        readError = context.getString(R.string.incoming_file_unreadable)
                        return
                    }
                    viewModel.importFromText(title = name.ifBlank { titleFor(text) }, content = text)
                }
            }
        }
    }

    ModalBottomSheet(
        onDismissRequest = { if (!busy) { viewModel.resetState(); onDismiss() } },
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = androidx.compose.ui.graphics.Color.White
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = 20.dp)
                .padding(bottom = 20.dp)
        ) {
            Text(
                text = stringResource(R.string.incoming_title),
                style = MaterialTheme.typography.displaySmall,
                color = ListenInk
            )
            Spacer(Modifier.height(14.dp))

            Column(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(ListenCreamTile, RoundedCornerShape(16.dp))
                    .padding(16.dp)
            ) {
                Text(
                    text = sourceLabel(content),
                    style = MaterialTheme.typography.labelLarge,
                    color = ListenAmber
                )
                Spacer(Modifier.height(6.dp))
                Text(
                    text = previewFor(content),
                    style = MaterialTheme.typography.bodyMedium,
                    color = ListenInk,
                    maxLines = 5,
                    overflow = TextOverflow.Ellipsis
                )
            }

            (readError ?: (state as? ImportState.Error)?.message)?.let { message ->
                Spacer(Modifier.height(12.dp))
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error
                )
            }

            Spacer(Modifier.height(20.dp))

            Button(
                onClick = { start(open = true) },
                enabled = !busy,
                modifier = Modifier.fillMaxWidth().height(52.dp),
                shape = RoundedCornerShape(26.dp),
                colors = ButtonDefaults.buttonColors(containerColor = ListenInk, contentColor = androidx.compose.ui.graphics.Color.White)
            ) {
                if (busy) {
                    CircularProgressIndicator(
                        modifier = Modifier.size(20.dp),
                        strokeWidth = 2.dp,
                        color = androidx.compose.ui.graphics.Color.White
                    )
                    Spacer(Modifier.size(10.dp))
                    Text(stringResource(R.string.incoming_preparing))
                } else {
                    Text(
                        text = stringResource(
                            if (readError != null || state is ImportState.Error) R.string.incoming_try_again else R.string.incoming_read_now
                        )
                    )
                }
            }

            Spacer(Modifier.height(8.dp))

            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(8.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                OutlinedButton(
                    onClick = { start(open = false) },
                    enabled = !busy,
                    modifier = Modifier.weight(1f).height(48.dp),
                    shape = RoundedCornerShape(24.dp),
                    border = BorderStroke(1.dp, ListenCardBorder),
                    colors = ButtonDefaults.outlinedButtonColors(contentColor = ListenInk)
                ) { Text(stringResource(R.string.incoming_save_to_library)) }

                TextButton(
                    onClick = { viewModel.resetState(); onDismiss() },
                    enabled = !busy,
                    modifier = Modifier.height(48.dp),
                    colors = ButtonDefaults.textButtonColors(contentColor = ListenInkSecondary)
                ) { Text(stringResource(R.string.incoming_cancel)) }
            }
        }
    }
}

@Composable
private fun sourceLabel(content: IncomingContent): String = when (content) {
    is IncomingContent.Text -> stringResource(R.string.incoming_source_text, content.text.trim().split(Regex("\\s+")).size)
    is IncomingContent.Link -> stringResource(R.string.incoming_source_link)
    is IncomingContent.Document -> when (content.kind) {
        IncomingContent.Kind.PDF -> stringResource(R.string.incoming_source_pdf)
        IncomingContent.Kind.EPUB -> stringResource(R.string.incoming_source_epub)
        IncomingContent.Kind.TEXT -> stringResource(R.string.incoming_source_txt)
    }
}

private fun previewFor(content: IncomingContent): String = when (content) {
    is IncomingContent.Text -> content.text.trim()
    is IncomingContent.Link -> content.url
    is IncomingContent.Document -> content.displayName ?: content.uri.lastPathSegment.orEmpty()
}

/** First sentence-ish chunk, so a shared selection gets a readable library title. */
private fun titleFor(text: String): String {
    val firstLine = text.trim().lineSequence().firstOrNull().orEmpty().trim()
    return if (firstLine.length <= 60) firstLine else firstLine.take(57).trimEnd() + "…"
}
