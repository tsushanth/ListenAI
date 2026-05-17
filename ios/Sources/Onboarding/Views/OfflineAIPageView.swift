import SwiftUI

/// Onboarding screen for the on-device "Offline AI" feature.
/// Only included in the flow when the device is eligible — see
/// `OnboardingPage.isAvailable(on:)`. Shows download size, cellular policy,
/// and a Skip option.
struct OfflineAIPageView: View {
    @ObservedObject private var manager = OnboardingManager.shared
    @ObservedObject private var voicePresets = VoicePresetManager.shared
    @ObservedObject private var kokoro = KokoroModelManager.shared

    var body: some View {
        VStack(spacing: 0) {
            Spacer()

            iconView
                .padding(.bottom, 24)

            VStack(spacing: 12) {
                Text("Offline AI")
                    .font(.system(size: 28, weight: .bold))
                    .multilineTextAlignment(.center)

                Text("Skip the queue. Get instant playback that works without internet — your audio is generated entirely on your iPhone.")
                    .font(.body)
                    .foregroundStyle(Color(white: 0.33))
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 24)
            }

            VStack(alignment: .leading, spacing: 14) {
                BulletRow(icon: "bolt.fill", color: .yellow, text: "Instant — no waiting in queue")
                BulletRow(icon: "wifi.slash", color: .blue, text: "Works offline once downloaded")
                BulletRow(icon: "lock.fill", color: .green, text: "Your text never leaves your phone")
                BulletRow(icon: "internaldrive.fill", color: .gray, text: "One-time download, about \(formattedSize)")
            }
            .padding(.horizontal, 32)
            .padding(.top, 28)

            cellularToggle
                .padding(.horizontal, 24)
                .padding(.top, 24)

            Spacer()

            footer
        }
    }

    // MARK: - Pieces

    private var iconView: some View {
        ZStack {
            Circle()
                .fill(LinearGradient(colors: [.teal.opacity(0.15), .blue.opacity(0.15)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(width: 140, height: 140)

            Image(systemName: "iphone.gen3")
                .font(.system(size: 60))
                .foregroundStyle(LinearGradient(colors: [.teal, .blue],
                                                startPoint: .top, endPoint: .bottom))

            Image(systemName: "waveform")
                .font(.system(size: 18, weight: .semibold))
                .foregroundStyle(.white)
                .padding(8)
                .background(Circle().fill(Color.green))
                .offset(x: 38, y: 38)
        }
    }

    private var cellularToggle: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: "antenna.radiowaves.left.and.right")
                .foregroundStyle(.orange)
                .frame(width: 24)
                .padding(.top, 2)

            VStack(alignment: .leading, spacing: 2) {
                Text("Allow cellular download")
                    .font(.subheadline.weight(.medium))
                Text("Off by default — saves your data plan. We'll wait for WiFi.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer()
            Toggle("", isOn: $voicePresets.allowCellularModelDownload)
                .labelsHidden()
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 16)
        .background(Color(.secondarySystemBackground))
        .cornerRadius(12)
    }

    private var footer: some View {
        VStack(spacing: 12) {
            OnboardingFooterView(buttonTitle: "Enable Offline AI", showTerms: false) {
                voicePresets.useOfflineAI = true
                OfflineAIDownloadCoordinator.shared.prepareIfPossible()
                manager.nextPage()
            }

            Button("Skip — I'll use cloud TTS") {
                voicePresets.useOfflineAI = false
                manager.nextPage()
            }
            .font(.subheadline)
            .foregroundStyle(Color(white: 0.4))
            .padding(.bottom, 8)
        }
    }

    private var formattedSize: String {
        let formatter = ByteCountFormatter()
        formatter.allowedUnits = [.useMB]
        formatter.countStyle = .file
        return formatter.string(fromByteCount: KokoroModelManager.estimatedDownloadBytes)
    }
}

private struct BulletRow: View {
    let icon: String
    let color: Color
    let text: String

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: icon)
                .foregroundStyle(color)
                .frame(width: 22)
            Text(text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer()
        }
    }
}

#Preview("Offline AI") {
    OfflineAIPageView()
}
