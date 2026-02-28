import SwiftUI

// MARK: - Document To Audio Page View

/// Second onboarding screen - "Turn any document to audio"
/// Shows import methods pills, phone mockup with article text and waveform.
struct DocumentToAudioPageView: View {
    @ObservedObject private var manager = OnboardingManager.shared

    /// Creates attributed string with highlighted portion
    private var highlightedTextAttributed: AttributedString {
        var result = AttributedString()

        // Highlighted portion
        var highlighted = AttributedString("The study of space and its components")
        highlighted.backgroundColor = .yellow.opacity(0.4)
        result.append(highlighted)

        // Rest of the sentence
        var rest = AttributedString(" is known as astronomy, a science that has fascinated humans for millennia.")
        result.append(rest)

        return result
    }

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Import method pills
            importMethodPills
                .padding(.bottom, 20)

            // Phone mockup with article
            phoneMockupView
                .padding(.horizontal, 40)

            Spacer()

            // Title and subtitle
            VStack(spacing: 12) {
                Text("Turn any document to audio")
                    .font(.system(size: 28, weight: .bold))
                    .multilineTextAlignment(.center)

                Text("Listen to PDFs, articles, news and more")
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

    // MARK: - Import Method Pills

    private var importMethodPills: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                ImportPill(icon: "textformat", text: "Type & Paste Text", color: .pink)
                ImportPill(icon: "text.quote", text: "Scan Text", color: .orange)
            }

            HStack(spacing: 10) {
                ImportPill(icon: "link", text: "Web Link", color: .blue)
                ImportPill(icon: "doc.fill", text: "PDF, ePUB & more", color: .orange)
            }
        }
    }

    // MARK: - Phone Mockup

    private var phoneMockupView: some View {
        ZStack {
            // Phone frame
            RoundedRectangle(cornerRadius: 40)
                .fill(Color(.systemBackground))
                .shadow(color: .black.opacity(0.1), radius: 20, y: 10)

            VStack(spacing: 0) {
                // Status bar
                HStack {
                    Text("9:41")
                        .font(.caption.weight(.semibold))
                    Spacer()
                    HStack(spacing: 4) {
                        Image(systemName: "cellularbars")
                        Image(systemName: "wifi")
                        Image(systemName: "battery.100")
                    }
                    .font(.caption)
                }
                .padding(.horizontal, 20)
                .padding(.top, 12)

                // Navigation bar
                HStack {
                    Image(systemName: "chevron.left")
                        .font(.body)
                    Spacer()
                    HStack(spacing: 16) {
                        Image(systemName: "slider.horizontal.3")
                        Image(systemName: "square.and.pencil")
                    }
                    .font(.body)
                }
                .foregroundStyle(.secondary)
                .padding(.horizontal, 16)
                .padding(.top, 8)

                // Article content - flowing text with inline highlight
                VStack(alignment: .leading, spacing: 12) {
                    Text("Space is home to countless celestial objects and phenomena, including stars, planets, moons, asteroids, comets, and galaxies. These objects are spread across the universe, which is believed to be around 13.8 billion years old.")
                        .font(.system(size: 11))
                        .foregroundStyle(.primary)

                    // Flowing text with highlighted portion using AttributedString
                    Text(highlightedTextAttributed)
                        .font(.system(size: 11))

                    Text("One of the most notable features of space is its vastness. The distances between objects in space are immense...")
                        .font(.system(size: 11))
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16)
                .padding(.top, 12)

                Spacer()

                // Waveform animation
                OnboardingWaveformView()
                    .frame(height: 60)
                    .padding(.horizontal, 20)
                    .padding(.bottom, 20)
            }
            .padding(.vertical, 8)
        }
        .frame(height: 380)
    }
}

// MARK: - Import Pill

struct ImportPill: View {
    let icon: String
    let text: String
    let color: Color

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: icon)
                .font(.caption)
            Text(text)
                .font(.caption.weight(.medium))
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(color)
        .foregroundStyle(.white)
        .cornerRadius(20)
    }
}

// MARK: - Onboarding Waveform View

struct OnboardingWaveformView: View {
    @State private var animate = false

    private let barCount = 30
    private let animationDuration = 0.8

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<barCount, id: \.self) { index in
                OnboardingWaveformBar(
                    delay: Double(index) * 0.05,
                    duration: animationDuration
                )
            }
        }
        .onAppear {
            animate = true
        }
    }
}

struct OnboardingWaveformBar: View {
    let delay: Double
    let duration: Double

    @State private var height: CGFloat = 10

    var body: some View {
        RoundedRectangle(cornerRadius: 2)
            .fill(Color.yellow.opacity(0.8))
            .frame(width: 4, height: height)
            .onAppear {
                withAnimation(
                    .easeInOut(duration: duration)
                    .repeatForever(autoreverses: true)
                    .delay(delay)
                ) {
                    height = CGFloat.random(in: 15...45)
                }
            }
    }
}

#Preview("DocumentToAudio") {
    DocumentToAudioPageView()
}
