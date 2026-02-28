import SwiftUI

// MARK: - Welcome Page View

/// First onboarding screen - "Welcome to ReadAloud AI!"
/// Shows file type icons orbiting around a microphone, badges for app rating.
struct WelcomePageView: View {
    @ObservedObject private var manager = OnboardingManager.shared

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            // Feature pills at top
            featurePillsView

            // Orbiting icons illustration
            orbitingIconsView
                .padding(.vertical, 24)

            // Badges
            badgesView
                .padding(.bottom, 24)

            // Title and subtitle
            VStack(spacing: 12) {
                Text("Welcome to\nReadAloud AI!")
                    .font(.system(size: 28, weight: .bold))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)

                Text("Read anything aloud in the highest quality voices.")
                    .font(.body)
                    .foregroundStyle(Color(white: 0.33))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 24)

            Spacer()

            // Footer
            OnboardingFooterView(buttonTitle: "Get Started") {
                manager.nextPage()
            }
        }
    }

    // MARK: - Feature Pills

    private var featurePillsView: some View {
        VStack(spacing: 12) {
            HStack(spacing: 12) {
                FeaturePill(icon: "doc.fill", text: "PDF, ePUB & more", color: .orange)
            }

            HStack(spacing: 12) {
                FeaturePill(icon: "text.quote", text: "Scan Text", color: .gray)
                FeaturePill(icon: "link", text: "Web Link", color: .blue)
            }

            HStack(spacing: 12) {
                FeaturePill(icon: "textformat", text: "Type or Paste Text", color: .gray)
            }
        }
    }

    // MARK: - Orbiting Icons

    private var orbitingIconsView: some View {
        ZStack {
            // Orbit circles
            Circle()
                .stroke(Color.gray.opacity(0.15), lineWidth: 1)
                .frame(width: 280, height: 280)

            Circle()
                .stroke(Color.gray.opacity(0.1), lineWidth: 1)
                .frame(width: 200, height: 200)

            // Center microphone icon
            ZStack {
                Circle()
                    .fill(Color.white)
                    .frame(width: 80, height: 80)
                    .shadow(color: .black.opacity(0.05), radius: 8, y: 4)

                Image(systemName: "mic.fill")
                    .font(.system(size: 32))
                    .foregroundStyle(.yellow)
            }

            // Orbiting file icons
            FileTypeIcon(type: "PDF", color: .purple, angle: 220, radius: 140)
            FileTypeIcon(type: "DOC", color: .red, angle: 320, radius: 140)
            FileTypeIcon(type: "URL", color: .orange, angle: 40, radius: 140)
            FileTypeIcon(type: "TXT", color: .cyan, angle: 140, radius: 140)
            FileTypeIcon(type: "ePUB", color: .green, angle: 180, radius: 100)
        }
        .frame(height: 300)
    }

    // MARK: - Badges

    private var badgesView: some View {
        BadgeView(
            icon: "laurel.leading",
            text: "Top Text to\nSpeech App",
            trailingIcon: "laurel.trailing"
        )
    }
}

// MARK: - Feature Pill

struct FeaturePill: View {
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
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color(.systemBackground))
        .foregroundStyle(color == .gray ? .primary : color)
        .cornerRadius(20)
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }
}

// MARK: - File Type Icon

struct FileTypeIcon: View {
    let type: String
    let color: Color
    let angle: Double
    let radius: CGFloat

    var body: some View {
        let x = cos(angle * .pi / 180) * radius
        let y = sin(angle * .pi / 180) * radius

        ZStack {
            RoundedRectangle(cornerRadius: 8)
                .fill(color)
                .frame(width: 44, height: 52)

            // Folded corner effect
            VStack {
                HStack {
                    Spacer()
                    Triangle()
                        .fill(color.opacity(0.7))
                        .frame(width: 12, height: 12)
                }
                Spacer()
            }
            .frame(width: 44, height: 52)

            Text(type)
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(.white)
        }
        .offset(x: x, y: y)
    }
}

// MARK: - Triangle Shape

struct Triangle: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.minY))
        path.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY))
        path.closeSubpath()
        return path
    }
}

// MARK: - Badge View

struct BadgeView: View {
    let icon: String?
    let text: String
    var trailingIcon: String? = nil
    var stars: Int? = nil

    var body: some View {
        HStack(spacing: 4) {
            if let icon = icon {
                Image(systemName: icon)
                    .font(.caption)
                    .foregroundStyle(.gray)
            }

            Text(text)
                .font(.caption)
                .foregroundStyle(Color(white: 0.33))
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)

            if let trailingIcon = trailingIcon {
                Image(systemName: trailingIcon)
                    .font(.caption)
                    .foregroundStyle(.gray)
            }

            if let stars = stars {
                HStack(spacing: 2) {
                    ForEach(0..<stars, id: \.self) { _ in
                        Image(systemName: "star.fill")
                            .font(.system(size: 10))
                            .foregroundStyle(.yellow)
                    }
                }
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .background(Color(.systemBackground))
        .cornerRadius(12)
        .shadow(color: .black.opacity(0.05), radius: 4, y: 2)
    }
}

#Preview("Welcome") {
    WelcomePageView()
}
