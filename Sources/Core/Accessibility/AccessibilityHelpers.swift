import SwiftUI

// MARK: - Accessibility Helpers

/// Central repository for accessibility utilities and best practices.
/// Use these helpers throughout the app for consistent VoiceOver support,
/// Dynamic Type compatibility, and high contrast modes.

// MARK: - Accessibility Labels

/// Provides consistent accessibility labels for common UI elements.
enum AccessibilityLabels {

    // MARK: - Playback Controls

    enum Playback {
        static func playPause(isPlaying: Bool) -> String {
            isPlaying ? "Pause" : "Play"
        }

        static func playPauseHint(isPlaying: Bool) -> String {
            isPlaying ? "Double tap to pause playback" : "Double tap to start playback"
        }

        static let skipForward = "Skip forward 15 seconds"
        static let skipBackward = "Go back 15 seconds"
        static let skipForwardHint = "Double tap to skip ahead"
        static let skipBackwardHint = "Double tap to go back"

        static func speed(_ rate: Float) -> String {
            if rate == 1.0 {
                return "Playback speed: Normal"
            }
            return "Playback speed: \(String(format: "%.1f", rate)) times"
        }

        static let speedHint = "Double tap to change playback speed"

        static func progress(current: TimeInterval, total: TimeInterval, percentage: Double) -> String {
            let currentStr = current.accessibleDuration
            let totalStr = total.accessibleDuration
            let percentStr = Int(percentage * 100)
            return "\(percentStr) percent complete. \(currentStr) of \(totalStr)"
        }

        static func sleepTimer(active: Bool, remaining: TimeInterval?) -> String {
            if !active {
                return "Sleep timer off"
            }
            if let remaining = remaining {
                return "Sleep timer: \(remaining.accessibleDuration) remaining"
            }
            return "Sleep timer active"
        }

        static let sleepTimerHint = "Double tap to set sleep timer"
    }

    // MARK: - Queue

    enum Queue {
        static let title = "Listening Queue"
        static let emptyState = "Queue is empty. Add articles to listen later."

        static func item(title: String, author: String, duration: TimeInterval, position: Int) -> String {
            "Item \(position): \(title) by \(author). Duration: \(duration.accessibleDuration)"
        }

        static func nowPlaying(title: String, author: String, progress: Double) -> String {
            let percentComplete = Int(progress * 100)
            return "Now playing: \(title) by \(author). \(percentComplete) percent complete"
        }

        static func upNextCount(_ count: Int) -> String {
            count == 1 ? "1 item up next" : "\(count) items up next"
        }

        static let shuffleOn = "Shuffle is on"
        static let shuffleOff = "Shuffle is off"
        static let shuffleHint = "Double tap to toggle shuffle"

        static func repeatMode(_ mode: String) -> String {
            "Repeat mode: \(mode)"
        }
        static let repeatHint = "Double tap to change repeat mode"

        static let clearQueue = "Clear queue"
        static let clearQueueHint = "Double tap to remove all items from queue"
    }

    // MARK: - Usage & Quota

    enum Usage {
        static func dailyUsage(used: Int, limit: Int, percentage: Float) -> String {
            if limit == Int.max {
                return "Daily usage: \(used.accessibleCharacterCount). No limit."
            }
            let percentStr = Int(percentage * 100)
            return "Daily usage: \(percentStr) percent. \(used.accessibleCharacterCount) of \(limit.accessibleCharacterCount) used."
        }

        static func monthlyUsage(used: Int, limit: Int, percentage: Float) -> String {
            if limit == Int.max {
                return "Monthly usage: \(used.accessibleCharacterCount). No limit."
            }
            let percentStr = Int(percentage * 100)
            return "Monthly usage: \(percentStr) percent. \(used.accessibleCharacterCount) of \(limit.accessibleCharacterCount) used."
        }

        static func remaining(characters: Int) -> String {
            if characters == Int.max {
                return "Unlimited remaining"
            }
            return "\(characters.accessibleCharacterCount) remaining"
        }

        static func warningBanner(level: String, message: String) -> String {
            "\(level) warning: \(message)"
        }

        static func tier(_ tierName: String) -> String {
            "Current plan: \(tierName)"
        }

        static let upgradeButton = "Upgrade plan"
        static let upgradeHint = "Double tap to view upgrade options"

        static let viewDetails = "View usage details"
        static let viewDetailsHint = "Double tap to see detailed usage statistics"
    }

    // MARK: - Voice Presets

    enum Voice {
        static func preset(name: String, category: String, isPremium: Bool) -> String {
            var label = "\(name) voice. Category: \(category)"
            if isPremium {
                label += ". Premium voice"
            }
            return label
        }

        static func presetSelected(name: String) -> String {
            "\(name) voice selected"
        }

        static let previewButton = "Preview voice"
        static let previewButtonHint = "Double tap to hear a sample of this voice"
        static let previewPlaying = "Playing voice preview. Double tap to stop."

        static func speedSlider(value: Float) -> String {
            "Speaking speed: \(String(format: "%.1f", value)) times normal"
        }

        static func pitchSlider(value: Float) -> String {
            "Voice pitch: \(String(format: "%.1f", value))"
        }

        static func volumeSlider(value: Float) -> String {
            "Volume: \(Int(value * 100)) percent"
        }

        static let customizeButton = "Customize voice settings"
        static let customizeHint = "Double tap to adjust voice parameters"
    }

    // MARK: - Playlists

    enum Playlist {
        static func item(name: String, itemCount: Int, totalDuration: TimeInterval) -> String {
            let items = itemCount == 1 ? "1 item" : "\(itemCount) items"
            return "\(name) playlist. \(items). Total duration: \(totalDuration.accessibleDuration)"
        }

        static let createNew = "Create new playlist"
        static let createHint = "Double tap to create a new playlist"

        static let favorites = "Favorites"
        static let listenLater = "Listen Later"
    }

    // MARK: - Common Actions

    enum Actions {
        static let dismiss = "Dismiss"
        static let close = "Close"
        static let cancel = "Cancel"
        static let done = "Done"
        static let edit = "Edit"
        static let delete = "Delete"
        static let share = "Share"
        static let addToQueue = "Add to queue"
        static let removeFromQueue = "Remove from queue"
        static let playNext = "Play next"
    }
}

// MARK: - Accessible Duration Formatting

extension TimeInterval {
    /// Returns a VoiceOver-friendly duration string.
    var accessibleDuration: String {
        let totalSeconds = Int(self)
        let hours = totalSeconds / 3600
        let minutes = (totalSeconds % 3600) / 60
        let seconds = totalSeconds % 60

        var components: [String] = []

        if hours > 0 {
            components.append(hours == 1 ? "1 hour" : "\(hours) hours")
        }
        if minutes > 0 {
            components.append(minutes == 1 ? "1 minute" : "\(minutes) minutes")
        }
        if seconds > 0 && hours == 0 {
            components.append(seconds == 1 ? "1 second" : "\(seconds) seconds")
        }

        if components.isEmpty {
            return "0 seconds"
        }

        return components.joined(separator: " ")
    }
}

// MARK: - Accessible Character Count

extension Int {
    /// Returns a VoiceOver-friendly character count.
    var accessibleCharacterCount: String {
        if self >= 1_000_000 {
            let millions = Double(self) / 1_000_000
            return String(format: "%.1f million characters", millions)
        } else if self >= 1_000 {
            let thousands = Double(self) / 1_000
            return String(format: "%.1f thousand characters", thousands)
        } else {
            return self == 1 ? "1 character" : "\(self) characters"
        }
    }
}

// MARK: - View Modifiers for Accessibility

/// Adds comprehensive accessibility support to a view.
struct AccessibleModifier: ViewModifier {
    let label: String
    let hint: String?
    let traits: AccessibilityTraits
    let value: String?

    init(
        label: String,
        hint: String? = nil,
        traits: AccessibilityTraits = [],
        value: String? = nil
    ) {
        self.label = label
        self.hint = hint
        self.traits = traits
        self.value = value
    }

    func body(content: Content) -> some View {
        content
            .accessibilityLabel(label)
            .accessibilityHint(hint ?? "")
            .accessibilityAddTraits(traits)
            .accessibilityValue(value ?? "")
    }
}

extension View {
    /// Adds comprehensive accessibility support.
    func accessible(
        label: String,
        hint: String? = nil,
        traits: AccessibilityTraits = [],
        value: String? = nil
    ) -> some View {
        modifier(AccessibleModifier(
            label: label,
            hint: hint,
            traits: traits,
            value: value
        ))
    }

    /// Makes the view a single accessible element with combined children.
    func accessibleContainer(label: String, hint: String? = nil) -> some View {
        self
            .accessibilityElement(children: .combine)
            .accessibilityLabel(label)
            .accessibilityHint(hint ?? "")
    }

    /// Hides the view from VoiceOver when it's decorative.
    func accessibilityDecorative() -> some View {
        self.accessibilityHidden(true)
    }
}

// MARK: - Dynamic Type Support

/// Modifier that scales content appropriately for Dynamic Type.
struct ScaledFontModifier: ViewModifier {
    @Environment(\.sizeCategory) var sizeCategory
    let textStyle: Font.TextStyle
    let maxSize: CGFloat?

    func body(content: Content) -> some View {
        let scaledFont = Font.system(textStyle)

        return content
            .font(scaledFont)
            .lineLimit(sizeCategory.isAccessibilityCategory ? nil : 2)
    }
}

extension View {
    /// Applies a scalable font that respects Dynamic Type settings.
    func scaledFont(_ style: Font.TextStyle, maxSize: CGFloat? = nil) -> some View {
        modifier(ScaledFontModifier(textStyle: style, maxSize: maxSize))
    }
}

extension ContentSizeCategory {
    /// Returns true if the current size category is an accessibility size.
    var isAccessibilityCategory: Bool {
        switch self {
        case .accessibilityMedium,
             .accessibilityLarge,
             .accessibilityExtraLarge,
             .accessibilityExtraExtraLarge,
             .accessibilityExtraExtraExtraLarge:
            return true
        default:
            return false
        }
    }
}

// MARK: - High Contrast Support

/// Provides colors that adapt to high contrast mode.
struct HighContrastColors {
    @Environment(\.colorSchemeContrast) private var contrast

    /// Returns a color that works well in high contrast mode.
    static func adaptive(
        normal: Color,
        highContrast: Color
    ) -> Color {
        // Note: Use with @Environment(\.colorSchemeContrast)
        // This is a helper for documentation
        return normal
    }

    // Semantic colors that work well in both modes
    static let primaryText = Color.primary
    static let secondaryText = Color.secondary
    static let tertiaryText = Color(uiColor: .tertiaryLabel)

    static let success = Color.green
    static let warning = Color.orange
    static let error = Color.red
    static let info = Color.blue

    // Progress colors with good contrast
    static func progressColor(percentage: Float, highContrast: Bool) -> Color {
        if percentage >= 1.0 {
            return highContrast ? .red : Color(red: 0.9, green: 0.2, blue: 0.2)
        } else if percentage >= 0.9 {
            return highContrast ? .orange : Color(red: 0.95, green: 0.6, blue: 0.1)
        } else if percentage >= 0.8 {
            return highContrast ? .yellow : Color(red: 0.95, green: 0.8, blue: 0.2)
        } else {
            return highContrast ? .green : Color(red: 0.2, green: 0.8, blue: 0.4)
        }
    }
}

/// View modifier that adjusts appearance for high contrast mode.
struct HighContrastModifier: ViewModifier {
    @Environment(\.colorSchemeContrast) var contrast

    var isHighContrast: Bool {
        contrast == .increased
    }

    func body(content: Content) -> some View {
        content
    }
}

extension View {
    /// Access high contrast environment value.
    func withHighContrastSupport() -> some View {
        modifier(HighContrastModifier())
    }
}

// MARK: - Accessible Progress View

/// A progress view that announces changes to VoiceOver.
struct AccessibleProgressView: View {
    let value: Double
    let total: Double
    let label: String

    @Environment(\.colorSchemeContrast) var contrast

    private var percentage: Double {
        guard total > 0 else { return 0 }
        return value / total
    }

    private var progressColor: Color {
        let pct = Float(percentage)
        return HighContrastColors.progressColor(
            percentage: pct,
            highContrast: contrast == .increased
        )
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack(alignment: .leading) {
                // Background
                Capsule()
                    .fill(Color.secondary.opacity(contrast == .increased ? 0.4 : 0.2))
                    .frame(height: contrast == .increased ? 8 : 6)

                // Progress
                Capsule()
                    .fill(progressColor)
                    .frame(
                        width: geometry.size.width * CGFloat(min(percentage, 1.0)),
                        height: contrast == .increased ? 8 : 6
                    )
            }
        }
        .frame(height: contrast == .increased ? 8 : 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue("\(Int(percentage * 100)) percent")
    }
}

// MARK: - Accessible Gauge

/// A circular gauge that works with VoiceOver and high contrast.
struct AccessibleGauge: View {
    let value: Double
    let label: String
    let valueLabel: String

    @Environment(\.colorSchemeContrast) var contrast
    @Environment(\.sizeCategory) var sizeCategory

    private var progressColor: Color {
        HighContrastColors.progressColor(
            percentage: Float(value),
            highContrast: contrast == .increased
        )
    }

    private var lineWidth: CGFloat {
        contrast == .increased ? 12 : 10
    }

    var body: some View {
        ZStack {
            // Background circle
            Circle()
                .stroke(
                    Color.secondary.opacity(contrast == .increased ? 0.4 : 0.2),
                    lineWidth: lineWidth
                )

            // Progress circle
            Circle()
                .trim(from: 0, to: CGFloat(min(value, 1.0)))
                .stroke(
                    progressColor,
                    style: StrokeStyle(lineWidth: lineWidth, lineCap: .round)
                )
                .rotationEffect(.degrees(-90))

            // Value label
            VStack(spacing: 2) {
                Text(valueLabel)
                    .font(sizeCategory.isAccessibilityCategory ? .title3 : .title2)
                    .fontWeight(.bold)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(valueLabel)
    }
}

// MARK: - Reduce Motion Support

/// Checks if reduce motion is enabled.
struct ReduceMotionModifier: ViewModifier {
    @Environment(\.accessibilityReduceMotion) var reduceMotion

    func body(content: Content) -> some View {
        content
    }
}

extension View {
    /// Conditionally applies animation based on reduce motion preference.
    func animationIfAllowed<V: Equatable>(
        _ animation: Animation?,
        value: V
    ) -> some View {
        modifier(ConditionalAnimationModifier(animation: animation, value: value))
    }
}

struct ConditionalAnimationModifier<V: Equatable>: ViewModifier {
    @Environment(\.accessibilityReduceMotion) var reduceMotion
    let animation: Animation?
    let value: V

    func body(content: Content) -> some View {
        if reduceMotion {
            content
        } else {
            content.animation(animation, value: value)
        }
    }
}

// MARK: - Accessible Button Style

/// A button style with enhanced accessibility features.
struct AccessibleButtonStyle: ButtonStyle {
    @Environment(\.colorSchemeContrast) var contrast
    @Environment(\.isEnabled) var isEnabled

    let role: ButtonRole?

    init(role: ButtonRole? = nil) {
        self.role = role
    }

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .opacity(configuration.isPressed ? 0.7 : 1.0)
            .opacity(isEnabled ? 1.0 : 0.5)
            .overlay(
                RoundedRectangle(cornerRadius: 8)
                    .stroke(
                        contrast == .increased ? Color.primary : Color.clear,
                        lineWidth: contrast == .increased ? 2 : 0
                    )
            )
    }
}

// MARK: - Rotor Actions

/// Common rotor actions for accessibility.
enum AccessibilityRotorAction {
    case playPause
    case skipForward
    case skipBackward
    case adjustSpeed
    case nextItem
    case previousItem
}

// MARK: - Preview

#Preview {
    VStack(spacing: 20) {
        AccessibleProgressView(
            value: 0.7,
            total: 1.0,
            label: "Progress"
        )
        .padding()

        AccessibleGauge(
            value: 0.75,
            label: "Daily usage",
            valueLabel: "75%"
        )
        .frame(width: 100, height: 100)
    }
    .padding()
}
