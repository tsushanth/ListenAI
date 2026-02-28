import SwiftUI

// MARK: - Productivity Page View

/// Fourth onboarding screen - "Increase your productivity"
/// Shows voice avatars carousel, speed selector, and productivity badge.
struct ProductivityPageView: View {
    @ObservedObject private var manager = OnboardingManager.shared
    @State private var selectedSpeed: Double = 1.5

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Voice avatars carousel
            voiceAvatarsCarousel
                .padding(.bottom, 8)

            // Waveform
            HStack(spacing: 2) {
                ForEach(0..<25, id: \.self) { _ in
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Color.gray.opacity(0.3))
                        .frame(width: 3, height: CGFloat.random(in: 8...24))
                }
            }
            .padding(.bottom, 16)

            // Article card with speed selector
            articleCardView
                .padding(.horizontal, 24)

            Spacer()

            // Title and subtitle
            VStack(spacing: 12) {
                Text("Increase your productivity")
                    .font(.system(size: 28, weight: .bold))
                    .multilineTextAlignment(.center)

                Text("Listen to texts faster, learn more")
                    .font(.body)
                    .foregroundStyle(Color(white: 0.33))
                    .multilineTextAlignment(.center)
            }
            .padding(.horizontal, 32)

            Spacer()

            // Footer
            OnboardingFooterView(buttonTitle: "Continue") {
                manager.nextPage()
            }
        }
    }

    // MARK: - Voice Avatars Carousel

    private var voiceAvatarsCarousel: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 12) {
                ForEach(sampleAvatars, id: \.name) { avatar in
                    OnboardingVoiceAvatarView(
                        name: avatar.name,
                        imageColor: avatar.color,
                        isSelected: avatar.isSelected
                    )
                }
            }
            .padding(.horizontal, 24)
        }
    }

    private var sampleAvatars: [(name: String, color: Color, isSelected: Bool)] {
        [
            ("", .gray, false),
            ("Emma", .pink, false),
            ("Sarah", .brown, true),  // Selected - larger
            ("James", .blue, false),
            ("Sofia", .purple, false),
            ("", .gray, false)
        ]
    }

    // MARK: - Article Card

    private var articleCardView: some View {
        ZStack(alignment: .topTrailing) {
            VStack(alignment: .leading, spacing: 12) {
                Text("The Endless Tale")
                    .font(.headline)

                Text("In the Far East there was a great king who had no work to do. Every day, and all day long, he sat on soft cushions and listened to stories. And no matter what the story was about, he never grew tired of hearing it, even though it was very lon. \"There is only one fault that I find with your story,\" he often said: \"it is too short.\" All the story-tellers in the world were invited to his palace; and some of them told tales that were very long indeed. But the king was always sad when a story was ended. At last he sent word into every city and town and country place, offering a prize to any one who should tell him an...")
                    .font(.system(size: 13))
                    .foregroundStyle(.primary)
                    .lineLimit(12)

                // Productivity badge
                HStack(spacing: 8) {
                    Image(systemName: "headphones")
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Text("50% increase in")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.orange)
                    +
                    Text(" productivity")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 20)
                        .stroke(Color.yellow, lineWidth: 2)
                )
            }
            .padding(20)
            .background(Color(.systemBackground))
            .cornerRadius(20)
            .shadow(color: .black.opacity(0.08), radius: 12, y: 6)

            // Speed selector
            speedSelectorView
                .offset(x: 20, y: 60)
        }
    }

    // MARK: - Speed Selector

    private var speedSelectorView: some View {
        VStack(spacing: 8) {
            SpeedOption(speed: 0.7, isSelected: selectedSpeed == 0.7) {
                selectedSpeed = 0.7
            }
            SpeedOption(speed: 1.5, isSelected: selectedSpeed == 1.5, isHighlighted: true) {
                selectedSpeed = 1.5
            }
            SpeedOption(speed: 2.0, isSelected: selectedSpeed == 2.0) {
                selectedSpeed = 2.0
            }
        }
        .padding(8)
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.1), radius: 8, y: 4)
    }
}

// MARK: - Onboarding Voice Avatar View

struct OnboardingVoiceAvatarView: View {
    let name: String
    let imageColor: Color
    let isSelected: Bool

    var body: some View {
        VStack(spacing: 4) {
            ZStack {
                Circle()
                    .fill(isSelected ? Color.yellow : Color.clear)
                    .frame(width: isSelected ? 76 : 56, height: isSelected ? 76 : 56)

                Circle()
                    .fill(imageColor.opacity(name.isEmpty ? 0.3 : 1))
                    .frame(width: isSelected ? 68 : 48, height: isSelected ? 68 : 48)

                if !name.isEmpty {
                    // Person silhouette
                    Image(systemName: "person.fill")
                        .font(.system(size: isSelected ? 28 : 20))
                        .foregroundStyle(.white.opacity(0.8))
                }
            }
        }
        .opacity(name.isEmpty ? 0.5 : 1)
    }
}

// MARK: - Speed Option

struct SpeedOption: View {
    let speed: Double
    let isSelected: Bool
    var isHighlighted: Bool = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(String(format: "%.1f x", speed))
                .font(.subheadline.weight(isSelected ? .bold : .medium))
                .foregroundStyle(isHighlighted && isSelected ? .yellow : .primary)
                .padding(.horizontal, 16)
                .padding(.vertical, 8)
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(isSelected ? Color.yellow.opacity(0.15) : Color.clear)
                )
        }
    }
}

#Preview("Productivity") {
    ProductivityPageView()
}
