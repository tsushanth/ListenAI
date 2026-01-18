package com.listenai.service.import_content

/**
 * Service for cleaning and normalizing text for TTS synthesis
 */
class TextCleaningService {

    /**
     * Clean and normalize text for TTS
     */
    fun cleanText(text: String): String {
        return text
            // Normalize whitespace
            .normalizeWhitespace()
            // Fix common Unicode issues
            .normalizeUnicode()
            // Expand abbreviations for better TTS pronunciation
            .expandAbbreviations()
            // Clean up punctuation
            .cleanPunctuation()
            // Remove or replace problematic characters
            .removeProblematicCharacters()
            // Normalize numbers
            .normalizeNumbers()
            // Final cleanup
            .trim()
    }

    private fun String.normalizeWhitespace(): String {
        return this
            .replace(Regex("\\t"), " ")
            .replace(Regex(" {2,}"), " ")
            .replace(Regex("\\n{3,}"), "\n\n")
            .replace(Regex(" *\\n *"), "\n")
    }

    private fun String.normalizeUnicode(): String {
        return this
            // Smart quotes to regular quotes
            .replace('\u201C', '"')
            .replace('\u201D', '"')
            .replace('\u2018', '\'')
            .replace('\u2019', '\'')
            // Em/en dashes to hyphens
            .replace('\u2013', '-')
            .replace('\u2014', '-')
            // Ellipsis
            .replace("\u2026", "...")
            // Non-breaking space
            .replace('\u00A0', ' ')
            // Other common replacements
            .replace("\u2022", "-") // Bullet
            .replace("\u2023", "-") // Triangular bullet
            .replace("\u25E6", "-") // White bullet
    }

    private fun String.expandAbbreviations(): String {
        val abbreviations = mapOf(
            "Dr." to "Doctor",
            "Mr." to "Mister",
            "Mrs." to "Missus",
            "Ms." to "Miss",
            "Jr." to "Junior",
            "Sr." to "Senior",
            "vs." to "versus",
            "etc." to "et cetera",
            "e.g." to "for example",
            "i.e." to "that is",
            "approx." to "approximately",
            "govt." to "government",
            "dept." to "department",
            "Jan." to "January",
            "Feb." to "February",
            "Mar." to "March",
            "Apr." to "April",
            "Jun." to "June",
            "Jul." to "July",
            "Aug." to "August",
            "Sep." to "September",
            "Oct." to "October",
            "Nov." to "November",
            "Dec." to "December"
        )

        var result = this
        for ((abbr, expanded) in abbreviations) {
            result = result.replace(abbr, expanded, ignoreCase = false)
        }
        return result
    }

    private fun String.cleanPunctuation(): String {
        return this
            // Multiple punctuation marks
            .replace(Regex("[.]{2,}"), "...")
            .replace(Regex("[!]{2,}"), "!")
            .replace(Regex("[?]{2,}"), "?")
            // Space before punctuation
            .replace(Regex(" +([.,!?;:])"), "$1")
            // Space after punctuation (if missing)
            .replace(Regex("([.,!?;:])([A-Za-z])"), "$1 $2")
    }

    private fun String.removeProblematicCharacters(): String {
        return this
            // Remove zero-width characters
            .replace("\u200B", "")
            .replace("\u200C", "")
            .replace("\u200D", "")
            .replace("\uFEFF", "")
            // Remove control characters except newlines and tabs
            .replace(Regex("[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F]"), "")
    }

    private fun String.normalizeNumbers(): String {
        return this
            // Add space between number and unit (for better TTS)
            .replace(Regex("(\\d)([a-zA-Z])"), "$1 $2")
            // Handle ordinals
            .replace(Regex("(\\d)(st|nd|rd|th)\\b"), "$1$2")
    }

    /**
     * Split text into chunks suitable for TTS processing
     */
    fun splitIntoChunks(text: String, maxChunkSize: Int = 5000): List<String> {
        if (text.length <= maxChunkSize) {
            return listOf(text)
        }

        val chunks = mutableListOf<String>()
        var remaining = text

        while (remaining.isNotEmpty()) {
            if (remaining.length <= maxChunkSize) {
                chunks.add(remaining)
                break
            }

            // Find a good break point (end of sentence or paragraph)
            var breakPoint = remaining.substring(0, maxChunkSize).lastIndexOf(". ")
            if (breakPoint == -1) {
                breakPoint = remaining.substring(0, maxChunkSize).lastIndexOf("\n")
            }
            if (breakPoint == -1 || breakPoint < maxChunkSize / 2) {
                breakPoint = remaining.substring(0, maxChunkSize).lastIndexOf(" ")
            }
            if (breakPoint == -1) {
                breakPoint = maxChunkSize
            }

            chunks.add(remaining.substring(0, breakPoint + 1).trim())
            remaining = remaining.substring(breakPoint + 1).trim()
        }

        return chunks
    }

    /**
     * Estimate reading time in minutes
     */
    fun estimateReadingTime(text: String, wordsPerMinute: Int = 150): Int {
        val wordCount = text.split(Regex("\\s+")).size
        return (wordCount / wordsPerMinute).coerceAtLeast(1)
    }

    /**
     * Count characters (useful for usage tracking)
     */
    fun countCharacters(text: String): Int = text.length

    /**
     * Count words
     */
    fun countWords(text: String): Int = text.split(Regex("\\s+")).filter { it.isNotBlank() }.size
}
