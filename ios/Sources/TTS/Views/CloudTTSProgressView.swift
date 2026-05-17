import SwiftUI

/// Rich progress visualization for Cloud TTS jobs.
///
/// Replaces the single percentage ProgressView with:
///   • A chunk-strip showing per-chunk completion (uniform-width bars; the
///     backend currently exposes only chunks_total/chunks_completed, so a
///     completed chunk is fully filled, the next is in-progress, the rest empty).
///   • A queue context pill ("3 jobs ahead • ~90 sec") when the job hasn't
///     started yet, hidden once we're processing our own chunks.
///   • An "Use offline AI" CTA when queue_depth > 5 — surfaces only when the
///     device is also eligible for on-device synthesis.
///
/// Phase 2 (later): when backend exposes per-chunk char counts, the strip
/// switches to proportional bar widths.
struct CloudTTSProgressView: View {
    /// Latest job-status snapshot. nil while we haven't polled yet.
    let response: TTSJobStatusResponse?

    /// Threshold for surfacing the "Use offline AI" CTA. Match server design.
    let busyQueueThreshold: Int = 5

    /// Tap handler for the offline CTA. Owner decides whether to switch
    /// the synthesis source — typically navigates to Settings → Offline AI
    /// or kicks off `KokoroOnDeviceTTSService` directly.
    let onUseOffline: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            header

            if let response, response.status == .processing || response.status == .partialReady {
                chunkStrip(for: response)
            }

            if let response {
                queueAndETARow(for: response)
            }

            if shouldShowOfflineCTA {
                offlineCTA
            }
        }
        .padding(16)
        .background(.background.secondary)
        .clipShape(RoundedRectangle(cornerRadius: 14))
    }

    // MARK: - Subviews

    private var header: some View {
        HStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text(headerTitle)
                .font(.subheadline.weight(.semibold))
            Spacer()
            if let pct = response?.percentage {
                Text("\(pct)%")
                    .font(.subheadline.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var headerTitle: String {
        guard let response else { return "Generating audio…" }
        switch response.status {
        case .queued: return "Waiting in queue…"
        case .processing: return "Generating audio…"
        case .partialReady: return "Streaming preview…"
        case .ready: return "Ready"
        case .failed: return "Failed"
        case .cancelled: return "Cancelled"
        }
    }

    /// Uniform-width bars colored by per-chunk state.
    /// `chunks_completed` are filled, the next is partially filled (using the
    /// global percentage to estimate within-chunk progress), the rest empty.
    @ViewBuilder
    private func chunkStrip(for response: TTSJobStatusResponse) -> some View {
        let total = response.progress.chunksTotal ?? 0
        let completed = response.progress.chunksCompleted
        if total > 0 {
            HStack(spacing: 3) {
                ForEach(0..<total, id: \.self) { idx in
                    chunkBar(index: idx, completed: completed, total: total, overallPct: response.percentage)
                }
            }
            .frame(height: 8)

            HStack {
                Text("Chunk \(min(completed + 1, total)) of \(total)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer()
                if let remaining = response.progress.estimatedRemainingSec, remaining > 0 {
                    Text("~\(formatSeconds(remaining)) remaining")
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func chunkBar(index: Int, completed: Int, total: Int, overallPct: Int) -> some View {
        // Fully filled if this chunk is already done.
        // Partially filled if it's the next one in line — use overall percentage
        // remainder as a rough fraction so the bar doesn't sit empty during a long chunk.
        let fillFraction: Double = {
            if index < completed { return 1.0 }
            if index == completed {
                // Map the global percentage minus completed-chunk contribution onto this bar.
                let perChunk = 100.0 / Double(total)
                let baseline = Double(completed) * perChunk
                let frac = max(0, min(perChunk, Double(overallPct) - baseline)) / perChunk
                return frac
            }
            return 0
        }()

        return GeometryReader { geo in
            ZStack(alignment: .leading) {
                RoundedRectangle(cornerRadius: 3)
                    .fill(.tertiary)
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color.accentColor)
                    .frame(width: max(0, geo.size.width * fillFraction))
            }
        }
    }

    @ViewBuilder
    private func queueAndETARow(for response: TTSJobStatusResponse) -> some View {
        if let position = response.queuePosition,
           response.status == .queued {
            HStack(spacing: 6) {
                Image(systemName: "person.line.dotted.person")
                    .font(.caption)
                Text(queueLabel(position: position, depth: response.queueDepth ?? 0))
                    .font(.caption)
            }
            .foregroundStyle(.secondary)
        }
    }

    private var offlineCTA: some View {
        Button(action: onUseOffline) {
            HStack(spacing: 8) {
                Image(systemName: "iphone.gen3.radiowaves.left.and.right")
                Text("Queue is busy — use offline AI instead")
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                Image(systemName: "arrow.right")
                    .font(.caption.weight(.bold))
            }
            .font(.footnote.weight(.semibold))
            .padding(.horizontal, 12)
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(Color.accentColor.opacity(0.12))
            .foregroundStyle(Color.accentColor)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    // MARK: - Helpers

    private var shouldShowOfflineCTA: Bool {
        guard KokoroModelManager.isDeviceEligible else { return false }
        guard let depth = response?.queueDepth else { return false }
        return depth > busyQueueThreshold
    }

    private func queueLabel(position: Int, depth: Int) -> String {
        // "3rd in line" + optional "system has 12 queued"
        let ordinal = ordinalString(position)
        if depth > position {
            return "\(ordinal) in line • \(depth) jobs queued"
        }
        return "\(ordinal) in line"
    }

    private func ordinalString(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .ordinal
        return formatter.string(from: NSNumber(value: n)) ?? "\(n)"
    }

    private func formatSeconds(_ s: Int) -> String {
        if s < 60 { return "\(s)s" }
        let m = s / 60
        let r = s % 60
        return r == 0 ? "\(m)m" : "\(m)m \(r)s"
    }
}

// MARK: - Preview

#if DEBUG
#Preview("Queued, busy") {
    CloudTTSProgressView(
        response: TTSJobStatusResponse(
            status: .queued, jobId: "abc",
            progress: .init(durationSec: 120, progressSec: 0, chunksTotal: 8, chunksCompleted: 0, percentage: 0, estimatedRemainingSec: 95),
            queueDepth: 12, queuePosition: 3,
            previewUrl: nil, audioUrl: nil, previewDurationSec: nil,
            error: nil, createdAt: nil, updatedAt: nil
        ),
        onUseOffline: {}
    )
    .padding()
}

#Preview("Processing, mid-job") {
    CloudTTSProgressView(
        response: TTSJobStatusResponse(
            status: .processing, jobId: "abc",
            progress: .init(durationSec: 120, progressSec: 50, chunksTotal: 10, chunksCompleted: 4, percentage: 47, estimatedRemainingSec: 45),
            queueDepth: 2, queuePosition: nil,
            previewUrl: nil, audioUrl: nil, previewDurationSec: nil,
            error: nil, createdAt: nil, updatedAt: nil
        ),
        onUseOffline: {}
    )
    .padding()
}
#endif
