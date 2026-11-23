package com.listenai.ui.marketplace

import androidx.annotation.StringRes
import androidx.compose.runtime.Composable
import androidx.compose.ui.res.stringResource
import com.listenai.R

/**
 * Marketplace tags are stored and sent to the server as English keys ("calm", "warm"); the screens show them
 * in the user's language. A tag this app version has no text for (a custom tag from another user) is shown as it is.
 */
object MarketplaceTags {
    /** The tags a user can pick when sharing a voice, in display order. */
    val SHARE_TAGS = listOf(
        "male", "female", "neutral",
        "expressive", "calm", "energetic",
        "deep", "warm", "bright",
        "professional", "casual", "storytelling"
    )

    /** The tags offered as filters while browsing. */
    val FILTER_TAGS = listOf("male", "female", "neutral", "expressive", "calm", "energetic", "deep", "warm")

    @StringRes
    fun labelRes(tag: String): Int? = when (tag.lowercase()) {
        "male" -> R.string.voice_gender_male
        "female" -> R.string.voice_gender_female
        "neutral" -> R.string.voice_gender_neutral
        "calm" -> R.string.voice_style_calm
        "expressive" -> R.string.tag_expressive
        "energetic" -> R.string.tag_energetic
        "deep" -> R.string.tag_deep
        "warm" -> R.string.tag_warm
        "bright" -> R.string.tag_bright
        "professional" -> R.string.tag_professional
        "casual" -> R.string.tag_casual
        "storytelling" -> R.string.tag_storytelling
        else -> null
    }
}

@Composable
fun marketplaceTagLabel(tag: String): String =
    MarketplaceTags.labelRes(tag)?.let { stringResource(it) } ?: tag.replaceFirstChar { it.uppercase() }
