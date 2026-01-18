import SwiftUI

// MARK: - Take Notes Page View

/// Third onboarding screen - "Take notes on key concepts"
/// Shows note-taking feature with article text and playback controls.
struct TakeNotesPageView: View {
    @ObservedObject private var manager = OnboardingManager.shared

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Article with note illustration
            noteIllustrationView
                .padding(.horizontal, 32)

            // Playback controls mockup
            playbackControlsView
                .padding(.top, 24)
                .padding(.horizontal, 32)

            Spacer()

            // Title and subtitle
            VStack(spacing: 12) {
                Text("Take notes on key concepts")
                    .font(.system(size: 28, weight: .bold))
                    .multilineTextAlignment(.center)

                Text("Take notes on key ideas with a single tap")
                    .font(.body)
                    .foregroundStyle(.secondary)
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

    // MARK: - Note Illustration

    private var noteIllustrationView: some View {
        ZStack {
            // Background article text (blurred/faded)
            VStack(alignment: .leading, spacing: 8) {
                Text("The key to productivity is not working harder, but working smarter on what truly matters.")
                    .font(.system(size: 14))
                    .foregroundStyle(.secondary.opacity(0.6))

                Text("Introduction")
                    .font(.headline)
                    .foregroundStyle(.secondary.opacity(0.5))

                Text("Research shows that taking breaks and focusing on deep work leads to better outcomes. Many successful people attribute their achievements to deliberate practice...")
                    .font(.system(size: 12))
                    .foregroundStyle(.secondary.opacity(0.4))
                    .lineLimit(4)
            }
            .blur(radius: 1)

            // Note card
            VStack {
                Spacer()
                HStack {
                    noteCardView
                    Spacer()
                }
            }
        }
        .frame(height: 280)
    }

    private var noteCardView: some View {
        VStack(alignment: .leading, spacing: 8) {
            // Take Note button
            HStack(spacing: 6) {
                Image(systemName: "pencil.and.outline")
                    .font(.caption)
                Text("Take Note")
                    .font(.caption.weight(.semibold))
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Color.orange)
            .foregroundStyle(.white)
            .cornerRadius(16)

            // Note content card
            VStack(alignment: .leading, spacing: 4) {
                Text("Key Insight")
                    .font(.subheadline.weight(.semibold))

                Text("Focus on deep work and deliberate practice for better outcomes.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            .padding(12)
            .background(Color(.systemBackground))
            .cornerRadius(12)
            .shadow(color: .black.opacity(0.08), radius: 8, y: 4)
        }
    }

    // MARK: - Playback Controls

    private var playbackControlsView: some View {
        VStack(spacing: 16) {
            // Title
            Text("The Art of Deep Work")
                .font(.subheadline.weight(.medium))
                .lineLimit(1)

            // Progress bar
            VStack(spacing: 4) {
                GeometryReader { geometry in
                    ZStack(alignment: .leading) {
                        // Track
                        Capsule()
                            .fill(Color.gray.opacity(0.2))
                            .frame(height: 4)

                        // Progress
                        Capsule()
                            .fill(Color.yellow)
                            .frame(width: geometry.size.width * 0.4, height: 4)

                        // Thumb
                        Circle()
                            .fill(Color.yellow)
                            .frame(width: 12, height: 12)
                            .offset(x: geometry.size.width * 0.4 - 6)
                    }
                }
                .frame(height: 12)

                // Time labels
                HStack {
                    Text("5:10")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                    Spacer()
                    Text("12:38")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }

            // Controls
            HStack(spacing: 40) {
                Button {} label: {
                    Image(systemName: "gobackward.15")
                        .font(.title2)
                        .foregroundStyle(.primary)
                }

                Button {} label: {
                    ZStack {
                        Circle()
                            .fill(Color.yellow)
                            .frame(width: 56, height: 56)

                        Image(systemName: "play.fill")
                            .font(.title2)
                            .foregroundStyle(.black)
                    }
                }

                Button {} label: {
                    Image(systemName: "goforward.15")
                        .font(.title2)
                        .foregroundStyle(.primary)
                }
            }
        }
        .padding(20)
        .background(Color(.systemBackground))
        .cornerRadius(16)
        .shadow(color: .black.opacity(0.05), radius: 8, y: 4)
    }
}

#Preview("TakeNotes") {
    TakeNotesPageView()
}
