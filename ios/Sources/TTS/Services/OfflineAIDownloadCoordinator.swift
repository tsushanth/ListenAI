import Foundation
import Network

/// Coordinates the on-device Kokoro model download, gating it on the user's
/// "Allow cellular download" preference. When cellular is disallowed and the
/// device isn't on WiFi, we wait — `NWPathMonitor` notifies us when an
/// expensive-free path becomes available and we kick the download then.
///
/// The Settings toggle and the onboarding screen both call into
/// `prepareIfPossible()`. Calling repeatedly is safe: if a download is already
/// in flight, in-progress, or finished, it no-ops.
@MainActor
final class OfflineAIDownloadCoordinator: ObservableObject {

    static let shared = OfflineAIDownloadCoordinator()

    /// True when we're queued waiting for a WiFi connection. Distinct from
    /// `KokoroModelManager.state == .preparing` (which means the download is
    /// actively running). UI can show "Will download when on WiFi" when this
    /// is true.
    @Published private(set) var isWaitingForWiFi: Bool = false

    private let monitor = NWPathMonitor()
    private let monitorQueue = DispatchQueue(label: "OfflineAIDownloadCoordinator")
    private var inFlight: Task<Void, Never>?
    private var pendingTrigger: Bool = false

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            Task { @MainActor [weak self] in
                self?.handlePathUpdate(path)
            }
        }
        monitor.start(queue: monitorQueue)
    }

    /// Kick off a download if eligible, the user wants offline AI, and the
    /// network policy allows it. Otherwise mark as pending so the next WiFi
    /// transition triggers it.
    func prepareIfPossible() {
        guard KokoroModelManager.isDeviceEligible else { return }
        guard VoicePresetManager.shared.useOfflineAI else { return }
        if KokoroModelManager.shared.isReady { return }
        if inFlight != nil { return }

        if canDownloadNow() {
            startDownload()
        } else {
            pendingTrigger = true
            isWaitingForWiFi = true
        }
    }

    /// Cancel any pending wait (e.g. user disabled the toggle).
    func cancelPending() {
        pendingTrigger = false
        isWaitingForWiFi = false
    }

    // MARK: - Internal

    private func canDownloadNow() -> Bool {
        if VoicePresetManager.shared.allowCellularModelDownload { return true }
        let path = monitor.currentPath
        return path.status == .satisfied && !path.isExpensive && !path.usesInterfaceType(.cellular)
    }

    private func handlePathUpdate(_ path: NWPath) {
        guard pendingTrigger else { return }
        let allowsCellular = VoicePresetManager.shared.allowCellularModelDownload
        let allowed = path.status == .satisfied && (allowsCellular || (!path.isExpensive && !path.usesInterfaceType(.cellular)))
        if allowed {
            pendingTrigger = false
            isWaitingForWiFi = false
            startDownload()
        }
    }

    private func startDownload() {
        isWaitingForWiFi = false
        inFlight = Task { [weak self] in
            await TTSCoordinator.shared.prepareOfflineAI()
            await MainActor.run { self?.inFlight = nil }
        }
    }
}
