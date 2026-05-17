import Foundation
import UIKit

/// Surfaces the on-device Kokoro model state to the UI layer.
///
/// The actual model lifecycle (download, cache, load) is owned by FluidAudio's
/// `KokoroTtsManager` — we don't need to manage `.mlpackage` files ourselves.
/// This class exists so the UI can show:
///
///   • a download / "ready" state for the Settings → Offline AI toggle
///   • device eligibility (RAM / iOS version)
///   • a way to trigger a warm-up synthesis (which forces FluidAudio to
///     download + compile the Core ML models on first use)
///
@MainActor
final class KokoroModelManager: ObservableObject {

    static let shared = KokoroModelManager()

    // MARK: - State

    enum State: Equatable {
        case notReady
        case preparing
        case ready
        case failed(message: String)
    }

    @Published private(set) var state: State = .notReady

    /// Last error message, if any.
    @Published private(set) var lastError: String? = nil

    /// Fraction-complete (0.0–1.0) when state == .preparing. UI can show a
    /// progress bar against this. Updates are coalesced — they come from
    /// FluidAudio's progressHandler on a background queue and are bounced to
    /// the main actor inside the service before reaching this property.
    @Published private(set) var downloadProgress: Double = 0

    /// Approximate on-disk download size for the Kokoro 82M Core ML bundle.
    /// FluidAudio downloads ~250 MB across 38 files. Used by the onboarding
    /// screen and Settings to set user expectations before the download fires.
    static let estimatedDownloadBytes: Int64 = 250 * 1_024 * 1_024

    // MARK: - Eligibility

    /// Whether this device can reasonably run Kokoro on-device.
    /// Requires iOS 17+ (FluidAudio minimum). RAM gate has been removed in
    /// favor of letting any iOS 17+ device attempt synthesis and surfacing
    /// real failures via `lastError`. The Settings row will display the error
    /// message under the toggle so users can tell what failed on their device.
    /// Sentence-level chunking inside `KokoroOnDeviceTTSService` keeps peak
    /// memory low enough for most A12+ devices.
    nonisolated static var isDeviceEligible: Bool {
        let totalRAM = ProcessInfo.processInfo.physicalMemory
        let ramGB = Double(totalRAM) / 1_073_741_824.0
        if #available(iOS 17.0, *) {
            print("[KokoroModelManager] Device eligibility: iOS 17+ ✓, physical RAM \(String(format: "%.1f", ramGB)) GB → eligible")
            return true
        }
        print("[KokoroModelManager] Device eligibility: iOS <17 → NOT eligible (FluidAudio requires iOS 17+)")
        return false
    }

    // MARK: - State transitions (called by KokoroOnDeviceTTSService)

    /// FluidAudio reported the manager has loaded models successfully.
    func markReady() {
        state = .ready
        lastError = nil
        downloadProgress = 1
    }

    /// Indicate that initialization is in progress (FluidAudio is downloading
    /// or compiling Core ML models). Call before invoking the service.
    func markPreparing() {
        state = .preparing
        downloadProgress = 0
    }

    /// Update the download/compile progress bar.
    func updateProgress(_ fraction: Double) {
        downloadProgress = max(downloadProgress, min(1, fraction))
    }

    /// Surface a download / load failure to the UI.
    func markFailed(_ message: String) {
        state = .failed(message: message)
        lastError = message
    }

    /// Reset to not-ready (e.g. user disabled the feature).
    func reset() {
        state = .notReady
        lastError = nil
        downloadProgress = 0
    }

    // MARK: - Convenience

    /// True when the on-device model is loaded and ready for synthesis.
    var isReady: Bool {
        if case .ready = state { return true }
        return false
    }

    private init() {}
}

// MARK: - Errors

enum KokoroError: LocalizedError {
    case deviceIneligible
    case modelNotReady
    case downloadFailed(file: String, status: Int)
    case inferenceFailed(String)

    var errorDescription: String? {
        switch self {
        case .deviceIneligible:
            return "Offline AI requires iOS 17 or later and at least 6 GB of memory."
        case .modelNotReady:
            return "Offline AI model has not finished downloading yet."
        case .downloadFailed(let file, let status):
            return "Couldn't download Offline AI model file \(file) (HTTP \(status))."
        case .inferenceFailed(let detail):
            return "Offline AI synthesis failed: \(detail)"
        }
    }
}
