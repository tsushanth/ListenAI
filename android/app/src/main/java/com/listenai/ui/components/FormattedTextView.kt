package com.listenai.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.listenai.ui.theme.Blue
import com.listenai.ui.theme.Yellow

/**
 * Content block types for markdown parsing
 */
enum class ContentBlockType {
    HEADER1,
    HEADER2,
    HEADER3,
    BULLET_POINT,
    NUMBERED_ITEM,
    DEFINITION,
    BLOCKQUOTE,
    CODE_BLOCK,
    TABLE,
    PARAGRAPH,
    DIVIDER,
    EMPTY
}

/**
 * Represents a parsed content block from markdown
 */
data class ContentBlock(
    val type: ContentBlockType,
    val text: String,
    val prefix: String = "",
    val emoji: String? = null,
    val indentLevel: Int = 0,
    val tableHeaders: List<String> = emptyList(),
    val tableRows: List<List<String>> = emptyList()
)

/**
 * Renders formatted markdown text with rich styling.
 * Supports headers, bullet points, bold, italics, blockquotes, tables, etc.
 *
 * This is the Android equivalent of iOS FormattedTextView.
 */
@Composable
fun FormattedTextView(
    content: String,
    modifier: Modifier = Modifier,
    fontSize: TextUnit = 18.sp,
    lineSpacing: Dp = 8.dp,
    highlightIndex: Int? = null,
    highlightColor: Color = Yellow,
    highlightWordOnly: Boolean = false
) {
    val contentBlocks = remember(content) { parseMarkdown(content) }

    Column(
        modifier = modifier,
        verticalArrangement = Arrangement.spacedBy(lineSpacing * 1.5f)
    ) {
        contentBlocks.forEachIndexed { index, block ->
            RenderBlock(
                block = block,
                index = index,
                fontSize = fontSize,
                isHighlighted = highlightIndex == index,
                highlightColor = highlightColor,
                highlightWordOnly = highlightWordOnly
            )
        }
    }
}

@Composable
private fun RenderBlock(
    block: ContentBlock,
    index: Int,
    fontSize: TextUnit,
    isHighlighted: Boolean,
    highlightColor: Color,
    highlightWordOnly: Boolean
) {
    val content: @Composable () -> Unit = {
        when (block.type) {
            ContentBlockType.HEADER1 -> HeaderView(
                text = block.text,
                size = (fontSize.value + 8).sp,
                emoji = block.emoji,
                modifier = Modifier.padding(top = 16.dp, bottom = 4.dp)
            )

            ContentBlockType.HEADER2 -> HeaderView(
                text = block.text,
                size = (fontSize.value + 4).sp,
                emoji = block.emoji,
                modifier = Modifier.padding(top = 12.dp, bottom = 2.dp)
            )

            ContentBlockType.HEADER3 -> HeaderView(
                text = block.text,
                size = (fontSize.value + 2).sp,
                emoji = block.emoji,
                modifier = Modifier.padding(top = 8.dp)
            )

            ContentBlockType.BULLET_POINT -> BulletPointView(
                text = block.text,
                fontSize = fontSize,
                indentLevel = block.indentLevel
            )

            ContentBlockType.NUMBERED_ITEM -> NumberedItemView(
                text = block.text,
                number = block.prefix,
                fontSize = fontSize,
                indentLevel = block.indentLevel
            )

            ContentBlockType.BLOCKQUOTE -> BlockquoteView(
                text = block.text,
                fontSize = fontSize
            )

            ContentBlockType.CODE_BLOCK -> CodeBlockView(
                text = block.text,
                fontSize = fontSize
            )

            ContentBlockType.PARAGRAPH -> ParagraphView(
                text = block.text,
                fontSize = fontSize
            )

            ContentBlockType.DIVIDER -> HorizontalDivider(
                modifier = Modifier.padding(vertical = 8.dp)
            )

            ContentBlockType.EMPTY -> Spacer(modifier = Modifier.height(4.dp))

            ContentBlockType.DEFINITION -> DefinitionView(
                term = block.prefix,
                definition = block.text,
                fontSize = fontSize
            )

            ContentBlockType.TABLE -> TableView(
                headers = block.tableHeaders,
                rows = block.tableRows,
                fontSize = fontSize
            )
        }
    }

    if (isHighlighted) {
        HighlightWrapper(
            highlightColor = highlightColor,
            highlightWordOnly = highlightWordOnly
        ) {
            content()
        }
    } else {
        content()
    }
}

@Composable
private fun HighlightWrapper(
    highlightColor: Color,
    highlightWordOnly: Boolean,
    content: @Composable () -> Unit
) {
    if (highlightWordOnly) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(8.dp)
                .border(
                    width = 2.dp,
                    color = highlightColor.copy(alpha = 0.5f),
                    shape = RoundedCornerShape(4.dp)
                )
        ) {
            Box(
                modifier = Modifier
                    .width(3.dp)
                    .fillMaxHeight()
                    .padding(vertical = 4.dp)
                    .background(highlightColor, RoundedCornerShape(2.dp))
            )
            Box(modifier = Modifier.padding(8.dp)) {
                content()
            }
        }
    } else {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .clip(RoundedCornerShape(4.dp))
                .background(highlightColor.copy(alpha = 0.3f))
                .padding(8.dp)
        ) {
            content()
        }
    }
}

@Composable
private fun HeaderView(
    text: String,
    size: TextUnit,
    emoji: String?,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier,
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        if (!emoji.isNullOrEmpty()) {
            Text(
                text = emoji,
                fontSize = size
            )
        }
        RichText(
            text = text,
            fontSize = size,
            fontWeight = FontWeight.Bold
        )
    }
}

@Composable
private fun BulletPointView(
    text: String,
    fontSize: TextUnit,
    indentLevel: Int
) {
    Row(
        modifier = Modifier.padding(start = (indentLevel * 16).dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top
    ) {
        Text(
            text = "•",
            fontSize = fontSize,
            fontWeight = FontWeight.Bold,
            color = Blue
        )
        RichText(
            text = text,
            fontSize = fontSize
        )
    }
}

@Composable
private fun NumberedItemView(
    text: String,
    number: String,
    fontSize: TextUnit,
    indentLevel: Int
) {
    Row(
        modifier = Modifier.padding(start = (indentLevel * 16).dp),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
        verticalAlignment = Alignment.Top
    ) {
        Text(
            text = number,
            fontSize = fontSize,
            fontWeight = FontWeight.Bold,
            color = Blue,
            modifier = Modifier.widthIn(min = 20.dp)
        )
        RichText(
            text = text,
            fontSize = fontSize
        )
    }
}

@Composable
private fun DefinitionView(
    term: String,
    definition: String,
    fontSize: TextUnit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .background(Blue.copy(alpha = 0.08f))
    ) {
        Box(
            modifier = Modifier
                .width(3.dp)
                .height(IntrinsicSize.Max)
                .background(Blue)
        )

        Column(
            modifier = Modifier
                .padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 8.dp),
            verticalArrangement = Arrangement.spacedBy(4.dp)
        ) {
            if (term.isNotEmpty()) {
                Text(
                    text = term,
                    fontSize = fontSize,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface
                )
            }
            Text(
                text = definition,
                fontSize = fontSize,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun BlockquoteView(
    text: String,
    fontSize: TextUnit
) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(4.dp))
            .background(Blue.copy(alpha = 0.06f))
    ) {
        Box(
            modifier = Modifier
                .width(3.dp)
                .height(IntrinsicSize.Max)
                .background(Blue)
        )

        RichText(
            text = text,
            fontSize = fontSize,
            fontStyle = FontStyle.Italic,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(start = 12.dp, top = 8.dp, bottom = 8.dp, end = 8.dp)
        )
    }
}

@Composable
private fun CodeBlockView(
    text: String,
    fontSize: TextUnit
) {
    Box(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceVariant)
            .border(
                width = 1.dp,
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                shape = RoundedCornerShape(8.dp)
            )
            .horizontalScroll(rememberScrollState())
            .padding(12.dp)
    ) {
        Text(
            text = text,
            fontSize = (fontSize.value - 2).sp,
            fontFamily = FontFamily.Monospace,
            color = MaterialTheme.colorScheme.onSurface
        )
    }
}

@Composable
private fun TableView(
    headers: List<String>,
    rows: List<List<String>>,
    fontSize: TextUnit
) {
    Column(
        modifier = Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(8.dp))
            .border(
                width = 1.dp,
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f),
                shape = RoundedCornerShape(8.dp)
            )
    ) {
        // Headers
        if (headers.isNotEmpty()) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(Blue.copy(alpha = 0.1f))
            ) {
                headers.forEachIndexed { index, header ->
                    Text(
                        text = header,
                        fontSize = (fontSize.value - 2).sp,
                        fontWeight = FontWeight.SemiBold,
                        color = Blue,
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 8.dp, vertical = 6.dp)
                    )
                    if (index < headers.size - 1) {
                        Box(
                            modifier = Modifier
                                .width(1.dp)
                                .height(IntrinsicSize.Max)
                                .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))
                        )
                    }
                }
            }

            HorizontalDivider(
                color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)
            )
        }

        // Rows
        rows.forEachIndexed { rowIndex, row ->
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .background(
                        if (rowIndex % 2 == 0) Color.Transparent
                        else MaterialTheme.colorScheme.surfaceVariant.copy(alpha = 0.5f)
                    )
            ) {
                row.forEachIndexed { colIndex, cell ->
                    Text(
                        text = cell,
                        fontSize = (fontSize.value - 2).sp,
                        color = MaterialTheme.colorScheme.onSurface,
                        modifier = Modifier
                            .weight(1f)
                            .padding(horizontal = 8.dp, vertical = 6.dp)
                    )
                    if (colIndex < row.size - 1) {
                        Box(
                            modifier = Modifier
                                .width(1.dp)
                                .height(IntrinsicSize.Max)
                                .background(MaterialTheme.colorScheme.outline.copy(alpha = 0.3f))
                        )
                    }
                }
            }

            if (rowIndex < rows.size - 1) {
                HorizontalDivider(
                    color = MaterialTheme.colorScheme.outline.copy(alpha = 0.3f)
                )
            }
        }
    }
}

@Composable
private fun ParagraphView(
    text: String,
    fontSize: TextUnit
) {
    RichText(
        text = text,
        fontSize = fontSize,
        lineHeight = fontSize * 1.5f
    )
}

/**
 * Rich text composable that handles inline formatting (bold, italic)
 */
@Composable
private fun RichText(
    text: String,
    fontSize: TextUnit,
    fontWeight: FontWeight = FontWeight.Normal,
    fontStyle: FontStyle = FontStyle.Normal,
    color: Color = MaterialTheme.colorScheme.onSurface,
    lineHeight: TextUnit = TextUnit.Unspecified,
    modifier: Modifier = Modifier
) {
    val annotatedString = remember(text) {
        parseInlineFormatting(text, fontSize, fontWeight)
    }

    Text(
        text = annotatedString,
        fontSize = fontSize,
        fontWeight = fontWeight,
        fontStyle = fontStyle,
        color = color,
        lineHeight = lineHeight,
        modifier = modifier
    )
}

/**
 * Parse inline formatting markers (** for bold, * for italic)
 */
private fun parseInlineFormatting(
    text: String,
    fontSize: TextUnit,
    baseFontWeight: FontWeight
) = buildAnnotatedString {
    var i = 0
    var isBold = false
    var isItalic = false
    var currentText = StringBuilder()

    fun appendCurrentText() {
        if (currentText.isNotEmpty()) {
            val style = SpanStyle(
                fontWeight = if (isBold) FontWeight.Bold else baseFontWeight,
                fontStyle = if (isItalic) FontStyle.Italic else FontStyle.Normal,
                color = if (isBold) Blue else Color.Unspecified
            )
            withStyle(style) {
                append(currentText.toString())
            }
            currentText.clear()
        }
    }

    while (i < text.length) {
        // Check for bold markers (**)
        if (i + 1 < text.length && text[i] == '*' && text[i + 1] == '*') {
            appendCurrentText()
            isBold = !isBold
            i += 2
            continue
        }

        // Check for italic markers (single *)
        if (text[i] == '*' && (i + 1 >= text.length || text[i + 1] != '*')) {
            appendCurrentText()
            isItalic = !isItalic
            i += 1
            continue
        }

        currentText.append(text[i])
        i++
    }

    appendCurrentText()
}

// MARK: - Markdown Parser

/**
 * Parse markdown content into content blocks
 */
private fun parseMarkdown(content: String): List<ContentBlock> {
    val lines = content.split("\n")
    val blocks = mutableListOf<ContentBlock>()
    val codeBlockContent = mutableListOf<String>()
    var inCodeBlock = false
    val tableHeaders = mutableListOf<String>()
    val tableRows = mutableListOf<List<String>>()
    var inTable = false

    for ((index, line) in lines.withIndex()) {
        val trimmedLine = line.trim()

        // Handle code blocks
        if (trimmedLine.startsWith("```")) {
            if (inCodeBlock) {
                blocks.add(ContentBlock(
                    type = ContentBlockType.CODE_BLOCK,
                    text = codeBlockContent.joinToString("\n")
                ))
                codeBlockContent.clear()
                inCodeBlock = false
            } else {
                inCodeBlock = true
            }
            continue
        }

        if (inCodeBlock) {
            codeBlockContent.add(line)
            continue
        }

        // Handle tables
        if (trimmedLine.contains("|") && !trimmedLine.startsWith(">")) {
            val cells = trimmedLine.split("|")
                .map { it.trim() }
                .filter { it.isNotEmpty() }

            // Skip separator rows (e.g., |---|---|)
            if (cells.all { it.all { c -> c == '-' || c == ':' } }) {
                continue
            }

            if (!inTable) {
                tableHeaders.addAll(cells)
                inTable = true
            } else {
                tableRows.add(cells)
            }

            val nextIndex = index + 1
            if (nextIndex >= lines.size || !lines[nextIndex].contains("|")) {
                blocks.add(ContentBlock(
                    type = ContentBlockType.TABLE,
                    text = "",
                    tableHeaders = tableHeaders.toList(),
                    tableRows = tableRows.toList()
                ))
                tableHeaders.clear()
                tableRows.clear()
                inTable = false
            }
            continue
        }

        if (inTable) {
            blocks.add(ContentBlock(
                type = ContentBlockType.TABLE,
                text = "",
                tableHeaders = tableHeaders.toList(),
                tableRows = tableRows.toList()
            ))
            tableHeaders.clear()
            tableRows.clear()
            inTable = false
        }

        // Empty line
        if (trimmedLine.isEmpty()) {
            blocks.add(ContentBlock(type = ContentBlockType.EMPTY, text = ""))
            continue
        }

        // Headers with emoji detection
        when {
            trimmedLine.startsWith("### ") -> {
                val headerText = trimmedLine.drop(4)
                val (emoji, text) = extractEmoji(headerText)
                blocks.add(ContentBlock(type = ContentBlockType.HEADER3, text = text, emoji = emoji))
                continue
            }
            trimmedLine.startsWith("## ") -> {
                val headerText = trimmedLine.drop(3)
                val (emoji, text) = extractEmoji(headerText)
                blocks.add(ContentBlock(type = ContentBlockType.HEADER2, text = text, emoji = emoji))
                continue
            }
            trimmedLine.startsWith("# ") -> {
                val headerText = trimmedLine.drop(2)
                val (emoji, text) = extractEmoji(headerText)
                blocks.add(ContentBlock(type = ContentBlockType.HEADER1, text = text, emoji = emoji))
                continue
            }
        }

        // Bullet points with indent detection
        if (trimmedLine.startsWith("- ") || trimmedLine.startsWith("* ") || trimmedLine.startsWith("• ")) {
            val indentLevel = countLeadingSpaces(line) / 2
            val bulletText = trimmedLine.drop(2)
            blocks.add(ContentBlock(
                type = ContentBlockType.BULLET_POINT,
                text = bulletText,
                indentLevel = indentLevel
            ))
            continue
        }

        // Numbered lists
        val numberedMatch = Regex("^(\\d+\\.\\s+)(.*)").find(trimmedLine)
        if (numberedMatch != null) {
            val number = numberedMatch.groupValues[1].trim()
            val text = numberedMatch.groupValues[2]
            val indentLevel = countLeadingSpaces(line) / 2
            blocks.add(ContentBlock(
                type = ContentBlockType.NUMBERED_ITEM,
                text = text,
                prefix = number,
                indentLevel = indentLevel
            ))
            continue
        }

        // Blockquotes
        if (trimmedLine.startsWith("> ")) {
            blocks.add(ContentBlock(
                type = ContentBlockType.BLOCKQUOTE,
                text = trimmedLine.drop(2)
            ))
            continue
        }

        // Dividers
        if (trimmedLine == "---" || trimmedLine == "***" || trimmedLine == "___") {
            blocks.add(ContentBlock(type = ContentBlockType.DIVIDER, text = ""))
            continue
        }

        // Regular paragraph
        blocks.add(ContentBlock(type = ContentBlockType.PARAGRAPH, text = trimmedLine))
    }

    // Handle unclosed code block
    if (inCodeBlock && codeBlockContent.isNotEmpty()) {
        blocks.add(ContentBlock(
            type = ContentBlockType.CODE_BLOCK,
            text = codeBlockContent.joinToString("\n")
        ))
    }

    // Handle unclosed table
    if (inTable && (tableHeaders.isNotEmpty() || tableRows.isNotEmpty())) {
        blocks.add(ContentBlock(
            type = ContentBlockType.TABLE,
            text = "",
            tableHeaders = tableHeaders,
            tableRows = tableRows
        ))
    }

    return blocks
}

/**
 * Extract leading emoji from text
 */
private fun extractEmoji(text: String): Pair<String?, String> {
    val trimmed = text.trim()
    if (trimmed.isEmpty()) return null to trimmed

    val firstCodePoint = trimmed.codePointAt(0)

    // Check if it's an emoji (codepoint > 127 and is in emoji ranges)
    if (firstCodePoint > 127 && Character.isValidCodePoint(firstCodePoint)) {
        val charCount = Character.charCount(firstCodePoint)
        var endIndex = charCount

        // Handle emoji modifiers and ZWJ sequences
        while (endIndex < trimmed.length) {
            val nextCodePoint = trimmed.codePointAt(endIndex)
            // Check for ZWJ, variation selectors, or skin tone modifiers
            if (nextCodePoint == 0x200D || // ZWJ
                (nextCodePoint in 0xFE00..0xFE0F) || // Variation selectors
                (nextCodePoint in 0x1F3FB..0x1F3FF) // Skin tone modifiers
            ) {
                endIndex += Character.charCount(nextCodePoint)
                if (endIndex < trimmed.length) {
                    endIndex += Character.charCount(trimmed.codePointAt(endIndex))
                }
            } else {
                break
            }
        }

        val emoji = trimmed.substring(0, endIndex)
        val cleanText = trimmed.substring(endIndex).trim()
        return emoji to cleanText
    }

    return null to trimmed
}

/**
 * Count leading spaces in a line
 */
private fun countLeadingSpaces(line: String): Int {
    var count = 0
    for (char in line) {
        when (char) {
            ' ' -> count++
            '\t' -> count += 2
            else -> break
        }
    }
    return count
}
