//
//  FormattedTextView.swift
//  ListenAI
//
//  Renders formatted markdown text with rich styling
//  Supports headers, bullet points, bold, italics, blockquotes, etc.
//

import SwiftUI

// MARK: - Formatted Text View

struct FormattedTextView: View {
    let content: String
    let fontSize: CGFloat
    let lineSpacing: CGFloat
    let highlightIndex: Int?
    let highlightColor: Color
    let highlightWordOnly: Bool

    init(
        content: String,
        fontSize: CGFloat = 18,
        lineSpacing: CGFloat = 8,
        highlightIndex: Int? = nil,
        highlightColor: Color = .yellow,
        highlightWordOnly: Bool = false
    ) {
        self.content = content
        self.fontSize = fontSize
        self.lineSpacing = lineSpacing
        self.highlightIndex = highlightIndex
        self.highlightColor = highlightColor
        self.highlightWordOnly = highlightWordOnly
    }

    private var contentBlocks: [ContentBlock] {
        parseMarkdown(content)
    }

    var body: some View {
        LazyVStack(alignment: .leading, spacing: lineSpacing * 1.5) {
            ForEach(Array(contentBlocks.enumerated()), id: \.offset) { index, block in
                renderBlock(block, index: index)
                    .id("block-\(index)")
            }
        }
    }

    @ViewBuilder
    private func renderBlock(_ block: ContentBlock, index: Int) -> some View {
        let isHighlighted = highlightIndex == index

        Group {
            switch block.type {
            case .header1:
                headerView(text: block.text, size: fontSize + 8, emoji: block.emoji)
                    .padding(.top, 16)
                    .padding(.bottom, 4)

            case .header2:
                headerView(text: block.text, size: fontSize + 4, emoji: block.emoji)
                    .padding(.top, 12)
                    .padding(.bottom, 2)

            case .header3:
                headerView(text: block.text, size: fontSize + 2, emoji: block.emoji)
                    .padding(.top, 8)

            case .bulletPoint:
                bulletPointView(text: block.text, indentLevel: block.indentLevel)

            case .numberedItem:
                numberedItemView(text: block.text, number: block.prefix, indentLevel: block.indentLevel)

            case .blockquote:
                blockquoteView(text: block.text)

            case .codeBlock:
                codeBlockView(text: block.text)

            case .paragraph:
                paragraphView(text: block.text)

            case .divider:
                Divider()
                    .padding(.vertical, 8)

            case .empty:
                Spacer()
                    .frame(height: 4)

            case .definition:
                definitionView(term: block.prefix, definition: block.text)

            case .table:
                tableView(rows: block.tableRows, headers: block.tableHeaders)
            }
        }
        .modifier(HighlightModifier(
            isHighlighted: isHighlighted,
            highlightColor: highlightColor,
            highlightWordOnly: highlightWordOnly
        ))
    }

    // MARK: - Header View

    @ViewBuilder
    private func headerView(text: String, size: CGFloat, emoji: String?) -> some View {
        HStack(spacing: 8) {
            if let emoji = emoji, !emoji.isEmpty {
                Text(emoji)
                    .font(.system(size: size))
            }
            RichTextView(text: text, fontSize: size, fontWeight: .bold)
        }
    }

    // MARK: - Bullet Point View

    @ViewBuilder
    private func bulletPointView(text: String, indentLevel: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text("•")
                .font(.system(size: fontSize, weight: .bold))
                .foregroundColor(.accentColor)

            RichTextView(text: text, fontSize: fontSize)
        }
        .padding(.leading, CGFloat(indentLevel * 16))
    }

    // MARK: - Numbered Item View

    @ViewBuilder
    private func numberedItemView(text: String, number: String, indentLevel: Int) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Text(number)
                .font(.system(size: fontSize, weight: .bold))
                .foregroundColor(.accentColor)
                .frame(minWidth: 20, alignment: .trailing)

            RichTextView(text: text, fontSize: fontSize)
        }
        .padding(.leading, CGFloat(indentLevel * 16))
    }

    // MARK: - Definition View

    @ViewBuilder
    private func definitionView(term: String, definition: String) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(Color.accentColor)
                .frame(width: 3)

            VStack(alignment: .leading, spacing: 4) {
                if !term.isEmpty {
                    Text(term)
                        .font(.system(size: fontSize, weight: .semibold))
                        .foregroundColor(.primary)
                }
                Text(definition)
                    .font(.system(size: fontSize))
                    .foregroundColor(.secondary)
            }
            .padding(.leading, 12)
            .padding(.vertical, 8)
        }
        .background(Color.accentColor.opacity(0.08))
        .cornerRadius(4)
    }

    // MARK: - Blockquote View

    @ViewBuilder
    private func blockquoteView(text: String) -> some View {
        HStack(alignment: .top, spacing: 0) {
            Rectangle()
                .fill(Color.accentColor)
                .frame(width: 3)

            RichTextView(text: text, fontSize: fontSize, isItalic: true, color: .secondary)
                .padding(.leading, 12)
                .padding(.vertical, 8)
        }
        .background(Color.accentColor.opacity(0.06))
        .cornerRadius(4)
    }

    // MARK: - Code Block View

    @ViewBuilder
    private func codeBlockView(text: String) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Text(text)
                .font(.system(size: fontSize - 2, design: .monospaced))
                .foregroundColor(.primary)
                .padding(12)
        }
        .background(Color(.systemGray6))
        .cornerRadius(8)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.systemGray4), lineWidth: 1)
        )
    }

    // MARK: - Table View

    @ViewBuilder
    private func tableView(rows: [[String]], headers: [String]) -> some View {
        VStack(spacing: 0) {
            if !headers.isEmpty {
                HStack(spacing: 0) {
                    ForEach(Array(headers.enumerated()), id: \.offset) { index, header in
                        Text(header)
                            .font(.system(size: fontSize - 2, weight: .semibold))
                            .foregroundColor(.accentColor)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)
                            .background(Color.accentColor.opacity(0.1))

                        if index < headers.count - 1 {
                            Rectangle()
                                .fill(Color(.systemGray4))
                                .frame(width: 1)
                        }
                    }
                }

                Rectangle()
                    .fill(Color(.systemGray4))
                    .frame(height: 1)
            }

            ForEach(Array(rows.enumerated()), id: \.offset) { rowIndex, row in
                HStack(spacing: 0) {
                    ForEach(Array(row.enumerated()), id: \.offset) { colIndex, cell in
                        Text(cell)
                            .font(.system(size: fontSize - 2))
                            .foregroundColor(.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 8)
                            .padding(.vertical, 6)

                        if colIndex < row.count - 1 {
                            Rectangle()
                                .fill(Color(.systemGray4))
                                .frame(width: 1)
                        }
                    }
                }
                .background(rowIndex % 2 == 0 ? Color.clear : Color(.systemGray6).opacity(0.5))

                if rowIndex < rows.count - 1 {
                    Rectangle()
                        .fill(Color(.systemGray4))
                        .frame(height: 1)
                }
            }
        }
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color(.systemGray4), lineWidth: 1)
        )
        .cornerRadius(8)
    }

    // MARK: - Paragraph View

    @ViewBuilder
    private func paragraphView(text: String) -> some View {
        RichTextView(text: text, fontSize: fontSize)
            .lineSpacing(lineSpacing)
    }
}

// MARK: - Highlight Modifier

struct HighlightModifier: ViewModifier {
    let isHighlighted: Bool
    let highlightColor: Color
    let highlightWordOnly: Bool

    func body(content: Content) -> some View {
        if isHighlighted {
            if highlightWordOnly {
                content
                    .padding(8)
                    .background(
                        RoundedRectangle(cornerRadius: 4)
                            .stroke(highlightColor.opacity(0.5), lineWidth: 2)
                    )
                    .overlay(alignment: .leading) {
                        RoundedRectangle(cornerRadius: 2)
                            .fill(highlightColor)
                            .frame(width: 3)
                            .padding(.vertical, 4)
                    }
            } else {
                content
                    .padding(8)
                    .background(highlightColor.opacity(0.3))
                    .clipShape(RoundedRectangle(cornerRadius: 4))
            }
        } else {
            content
        }
    }
}

// MARK: - Rich Text View (handles inline formatting)

struct RichTextView: View {
    let text: String
    let fontSize: CGFloat
    var fontWeight: Font.Weight = .regular
    var isItalic: Bool = false
    var color: Color = .primary

    var body: some View {
        Text(parseInlineFormatting(text))
            .font(.system(size: fontSize, weight: fontWeight))
            .foregroundColor(color)
            .italic(isItalic)
    }

    private func parseInlineFormatting(_ text: String) -> AttributedString {
        var result = text
        var attributedString = AttributedString()

        var i = result.startIndex
        var currentText = ""
        var isBold = false
        var isItalicLocal = false

        while i < result.endIndex {
            // Check for bold markers (**)
            if result[i...].hasPrefix("**") {
                if !currentText.isEmpty {
                    var attr = AttributedString(currentText)
                    applyFormatting(&attr, bold: isBold, italic: isItalicLocal)
                    attributedString.append(attr)
                    currentText = ""
                }
                isBold.toggle()
                result.formIndex(&i, offsetBy: 2)
                continue
            }

            // Check for italic markers (single *)
            if result[i] == "*" && !result[i...].hasPrefix("**") {
                if !currentText.isEmpty {
                    var attr = AttributedString(currentText)
                    applyFormatting(&attr, bold: isBold, italic: isItalicLocal)
                    attributedString.append(attr)
                    currentText = ""
                }
                isItalicLocal.toggle()
                result.formIndex(after: &i)
                continue
            }

            currentText.append(result[i])
            result.formIndex(after: &i)
        }

        if !currentText.isEmpty {
            var attr = AttributedString(currentText)
            applyFormatting(&attr, bold: isBold, italic: isItalicLocal)
            attributedString.append(attr)
        }

        return attributedString
    }

    private func applyFormatting(_ attr: inout AttributedString, bold: Bool, italic: Bool) {
        if bold && italic {
            attr.font = .system(size: fontSize, weight: .bold).italic()
            attr.foregroundColor = .accentColor
        } else if bold {
            attr.font = .system(size: fontSize, weight: .bold)
            attr.foregroundColor = .accentColor
        } else if italic {
            attr.font = .system(size: fontSize).italic()
        } else {
            attr.font = .system(size: fontSize, weight: fontWeight)
        }
    }
}

// MARK: - Content Block Types

enum ContentBlockType {
    case header1
    case header2
    case header3
    case bulletPoint
    case numberedItem
    case definition
    case blockquote
    case codeBlock
    case table
    case paragraph
    case divider
    case empty
}

struct ContentBlock {
    let type: ContentBlockType
    let text: String
    var prefix: String = ""
    var emoji: String? = nil
    var indentLevel: Int = 0
    var tableHeaders: [String] = []
    var tableRows: [[String]] = []
}

// MARK: - Markdown Parser

private func parseMarkdown(_ content: String) -> [ContentBlock] {
    let lines = content.components(separatedBy: "\n")
    var blocks: [ContentBlock] = []
    var codeBlockContent: [String] = []
    var inCodeBlock = false
    var tableHeaders: [String] = []
    var tableRows: [[String]] = []
    var inTable = false

    for (index, line) in lines.enumerated() {
        let trimmedLine = line.trimmingCharacters(in: .whitespaces)

        // Handle code blocks
        if trimmedLine.hasPrefix("```") {
            if inCodeBlock {
                blocks.append(ContentBlock(type: .codeBlock, text: codeBlockContent.joined(separator: "\n")))
                codeBlockContent = []
                inCodeBlock = false
            } else {
                inCodeBlock = true
            }
            continue
        }

        if inCodeBlock {
            codeBlockContent.append(line)
            continue
        }

        // Handle tables
        if trimmedLine.contains("|") && !trimmedLine.hasPrefix(">") {
            let cells = trimmedLine.split(separator: "|").map { String($0).trimmingCharacters(in: .whitespaces) }

            if cells.allSatisfy({ $0.allSatisfy({ $0 == "-" || $0 == ":" }) }) {
                continue
            }

            if !inTable {
                tableHeaders = cells.filter { !$0.isEmpty }
                inTable = true
            } else {
                tableRows.append(cells.filter { !$0.isEmpty })
            }

            let nextIndex = index + 1
            if nextIndex >= lines.count || !lines[nextIndex].contains("|") {
                blocks.append(ContentBlock(
                    type: .table,
                    text: "",
                    tableHeaders: tableHeaders,
                    tableRows: tableRows
                ))
                tableHeaders = []
                tableRows = []
                inTable = false
            }
            continue
        }

        if inTable {
            blocks.append(ContentBlock(
                type: .table,
                text: "",
                tableHeaders: tableHeaders,
                tableRows: tableRows
            ))
            tableHeaders = []
            tableRows = []
            inTable = false
        }

        // Empty line
        if trimmedLine.isEmpty {
            blocks.append(ContentBlock(type: .empty, text: ""))
            continue
        }

        // Headers with emoji detection
        if trimmedLine.hasPrefix("### ") {
            let headerText = String(trimmedLine.dropFirst(4))
            let (emoji, text) = extractEmoji(from: headerText)
            blocks.append(ContentBlock(type: .header3, text: text, emoji: emoji))
            continue
        }
        if trimmedLine.hasPrefix("## ") {
            let headerText = String(trimmedLine.dropFirst(3))
            let (emoji, text) = extractEmoji(from: headerText)
            blocks.append(ContentBlock(type: .header2, text: text, emoji: emoji))
            continue
        }
        if trimmedLine.hasPrefix("# ") {
            let headerText = String(trimmedLine.dropFirst(2))
            let (emoji, text) = extractEmoji(from: headerText)
            blocks.append(ContentBlock(type: .header1, text: text, emoji: emoji))
            continue
        }

        // Bullet points with indent detection
        if trimmedLine.hasPrefix("- ") || trimmedLine.hasPrefix("* ") || trimmedLine.hasPrefix("• ") {
            let indentLevel = countLeadingSpaces(line) / 2
            let bulletText = String(trimmedLine.dropFirst(2))
            blocks.append(ContentBlock(type: .bulletPoint, text: bulletText, indentLevel: indentLevel))
            continue
        }

        // Numbered lists
        if let match = trimmedLine.range(of: "^\\d+\\.\\s+", options: .regularExpression) {
            let number = String(trimmedLine[match]).trimmingCharacters(in: .whitespaces)
            let text = String(trimmedLine[match.upperBound...])
            let indentLevel = countLeadingSpaces(line) / 2
            blocks.append(ContentBlock(type: .numberedItem, text: text, prefix: number, indentLevel: indentLevel))
            continue
        }

        // Blockquotes
        if trimmedLine.hasPrefix("> ") {
            blocks.append(ContentBlock(type: .blockquote, text: String(trimmedLine.dropFirst(2))))
            continue
        }

        // Dividers
        if trimmedLine == "---" || trimmedLine == "***" || trimmedLine == "___" {
            blocks.append(ContentBlock(type: .divider, text: ""))
            continue
        }

        // Regular paragraph
        blocks.append(ContentBlock(type: .paragraph, text: trimmedLine))
    }

    // Handle unclosed code block
    if inCodeBlock && !codeBlockContent.isEmpty {
        blocks.append(ContentBlock(type: .codeBlock, text: codeBlockContent.joined(separator: "\n")))
    }

    // Handle unclosed table
    if inTable && (!tableHeaders.isEmpty || !tableRows.isEmpty) {
        blocks.append(ContentBlock(
            type: .table,
            text: "",
            tableHeaders: tableHeaders,
            tableRows: tableRows
        ))
    }

    return blocks
}

private func extractEmoji(from text: String) -> (emoji: String?, cleanText: String) {
    let trimmed = text.trimmingCharacters(in: .whitespaces)

    if let firstScalar = trimmed.unicodeScalars.first {
        if firstScalar.properties.isEmoji && firstScalar.value > 127 {
            var emojiEndIndex = trimmed.startIndex
            for (i, char) in trimmed.enumerated() {
                if char.unicodeScalars.first?.properties.isEmoji == true && char.unicodeScalars.first!.value > 127 {
                    emojiEndIndex = trimmed.index(trimmed.startIndex, offsetBy: i + 1)
                } else {
                    break
                }
            }
            let emoji = String(trimmed[..<emojiEndIndex])
            let cleanText = String(trimmed[emojiEndIndex...]).trimmingCharacters(in: .whitespaces)
            return (emoji, cleanText)
        }
    }

    return (nil, trimmed)
}

private func countLeadingSpaces(_ line: String) -> Int {
    var count = 0
    for char in line {
        if char == " " {
            count += 1
        } else if char == "\t" {
            count += 2
        } else {
            break
        }
    }
    return count
}

// MARK: - Preview

#Preview {
    ScrollView {
        FormattedTextView(
            content: """
            ## 📚 Key Concepts

            **Brief Overview**

            This article covers the **fundamentals of SwiftUI** and how to build modern iOS apps.

            ### Main Points

            • SwiftUI provides a **declarative syntax** for building user interfaces
            • Views are structs that conform to the View protocol
            • State management is handled through property wrappers

            ---

            ## 🚀 Getting Started

            1. Create a new Xcode project
            2. Select SwiftUI as the interface option
            3. Start building your first view

            > SwiftUI makes it easy to build beautiful, responsive interfaces with minimal code.

            | Feature | Description |
            |---------|-------------|
            | Declarative | Describe what you want |
            | Reactive | Automatic updates |
            """,
            fontSize: 18,
            lineSpacing: 8,
            highlightIndex: 2,
            highlightColor: .yellow
        )
        .padding()
    }
}
