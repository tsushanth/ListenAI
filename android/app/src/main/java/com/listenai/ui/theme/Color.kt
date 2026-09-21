package com.listenai.ui.theme

import androidx.compose.ui.graphics.Color

// Primary colors
val Blue = Color(0xFF007AFF)
val BlueLight = Color(0xFF5AC8FA)
val Green = Color(0xFF34C759)
val GreenLight = Color(0xFF30D158)
val Orange = Color(0xFFFF9500)
val Purple = Color(0xFFAF52DE)
val Red = Color(0xFFFF3B30)
val Coral = Color(0xFFFF6666)
val Yellow = Color(0xFFFFCC00)
val Teal = Color(0xFF5AC8FA)
val Pink = Color(0xFFEC4899)

// Listen palette — sampled from the ListenAI reference app on-device (Sep 2026).
// A warm, cream-and-amber identity: a soft pink/lavender diagonal hero, near-black
// text, and one unified icon treatment (amber-on-cream) instead of a different
// accent color per row.
val ListenHeroPink = Color(0xFFFBD7FF)
val ListenHeroLavender = Color(0xFFFAC1FE)
val ListenInk = Color(0xFF0B0B0B)
val ListenInkSecondary = Color(0xFF6E6E73)
val ListenCreamTile = Color(0xFFFFF9EA)
val ListenAmber = Color(0xFFE8A33D)
val ListenCardBorder = Color(0xFFEFEDEA)
val ListenMintBadgeBg = Color(0xFFE7F9EE)

// Neutral colors - Light mode
val BackgroundLight = Color(0xFFFFFFFF)
val SurfaceLight = Color(0xFFFFFFFF)
val CardLight = Color(0xFFFFFFFF)
val TextPrimaryLight = ListenInk
val TextSecondaryLight = ListenInkSecondary
val TextTertiaryLight = Color(0xFFC7C7CC)
val DividerLight = ListenCardBorder

// Neutral colors - Dark mode
val BackgroundDark = Color(0xFF000000)
val SurfaceDark = Color(0xFF1C1C1E)
val CardDark = Color(0xFF2C2C2E)
val TextPrimaryDark = Color(0xFFFFFFFF)
val TextSecondaryDark = Color(0xFF8E8E93)
val TextTertiaryDark = Color(0xFF48484A)
val DividerDark = Color(0xFF38383A)

// Source type colors
val WebColor = Blue
val PdfColor = Red
val ClipboardColor = Purple
val FileColor = Orange
val ManualColor = Green

// Usage warning colors
val WarningLow = Color(0xFFFFCC00)
val WarningMedium = Color(0xFFFF9500)
val WarningHigh = Color(0xFFFF6B00)
val WarningCritical = Color(0xFFFF3B30)
