import SwiftUI
import VisionKit
import Vision
import AVFoundation

// MARK: - Scan Text View

/// Camera-based text scanning view using VisionKit.
/// Opens camera for OCR text extraction from documents/images.
struct ScanTextView: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject private var coordinator = ImportCoordinator.shared

    @State private var showScanner = false
    @State private var isProcessing = false
    @State private var processingMessage = "Processing..."
    @State private var scannedImages: [UIImage] = []
    @State private var importError: String?
    @State private var importedArticle: Article?
    @State private var showReader = false
    @State private var cameraPermissionStatus: AVAuthorizationStatus = .notDetermined
    @State private var isCheckingPermission = true

    var body: some View {
        ZStack {
            Color(.systemBackground)
                .ignoresSafeArea()

            if isCheckingPermission {
                ProgressView("Checking camera access...")
            } else if cameraPermissionStatus == .authorized {
                if showScanner {
                    // Document scanner
                    ScannerViewRepresentable(
                        onScan: { images in
                            scannedImages = images
                            showScanner = false
                            processScannedImages()
                        },
                        onCancel: {
                            dismiss()
                        }
                    )
                    .ignoresSafeArea()
                }
            } else if cameraPermissionStatus == .denied || cameraPermissionStatus == .restricted {
                // Permission denied view
                cameraPermissionDeniedView
            } else {
                // Request permission view
                requestPermissionView
            }

            // Processing overlay
            if isProcessing {
                ZStack {
                    Color.black.opacity(0.7)
                        .ignoresSafeArea()

                    VStack(spacing: 20) {
                        ProgressView()
                            .scaleEffect(1.5)
                            .tint(.white)

                        Text(processingMessage)
                            .font(.headline)
                            .foregroundStyle(.white)

                        Text("This may take a moment...")
                            .font(.subheadline)
                            .foregroundStyle(.white.opacity(0.7))
                    }
                    .padding(32)
                    .background(Color(.systemGray6).opacity(0.9))
                    .cornerRadius(16)
                }
            }
        }
        .alert("Error", isPresented: .constant(importError != nil)) {
            Button("OK") {
                importError = nil
                dismiss()
            }
        } message: {
            Text(importError ?? "")
        }
        .fullScreenCover(isPresented: $showReader) {
            if let article = importedArticle {
                NavigationStack {
                    ArticleReaderView(article: article)
                        .toolbar {
                            ToolbarItem(placement: .topBarLeading) {
                                Button("Done") {
                                    showReader = false
                                    dismiss()
                                }
                            }
                        }
                }
                .environmentObject(AudioPlaybackService.shared)
                .environmentObject(QueueManager.shared)
            }
        }
        .onChange(of: showReader) { _, isShowing in
            // Ensure mini player is shown when ArticleReaderView fullscreen cover is dismissed
            if !isShowing {
                AudioPlaybackService.shared.isArticleReaderActive = false
            }
        }
        .onAppear {
            checkCameraPermission()
        }
    }

    // MARK: - Permission Views

    private var requestPermissionView: some View {
        VStack(spacing: 24) {
            Image(systemName: "camera.fill")
                .font(.system(size: 60))
                .foregroundStyle(.secondary)

            Text("Camera Access Required")
                .font(.title2.weight(.semibold))

            Text("ReadAloud AI needs camera access to scan documents and extract text for listening.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Button {
                requestCameraPermission()
            } label: {
                Text("Allow Camera Access")
                    .fontWeight(.medium)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.blue)
                    .foregroundStyle(.white)
                    .cornerRadius(12)
            }
            .padding(.horizontal, 32)

            Button("Cancel") {
                dismiss()
            }
            .foregroundStyle(.secondary)
        }
    }

    private var cameraPermissionDeniedView: some View {
        VStack(spacing: 24) {
            Image(systemName: "camera.fill")
                .font(.system(size: 60))
                .foregroundStyle(.red.opacity(0.7))

            Text("Camera Access Denied")
                .font(.title2.weight(.semibold))

            Text("Please enable camera access in Settings to scan documents.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            Button {
                openSettings()
            } label: {
                Text("Open Settings")
                    .fontWeight(.medium)
                    .frame(maxWidth: .infinity)
                    .padding()
                    .background(Color.blue)
                    .foregroundStyle(.white)
                    .cornerRadius(12)
            }
            .padding(.horizontal, 32)

            Button("Cancel") {
                dismiss()
            }
            .foregroundStyle(.secondary)
        }
    }

    // MARK: - Permission Handling

    private func checkCameraPermission() {
        let status = AVCaptureDevice.authorizationStatus(for: .video)
        cameraPermissionStatus = status
        isCheckingPermission = false

        if status == .authorized {
            showScanner = true
        }
    }

    private func requestCameraPermission() {
        AVCaptureDevice.requestAccess(for: .video) { granted in
            DispatchQueue.main.async {
                cameraPermissionStatus = granted ? .authorized : .denied
                if granted {
                    showScanner = true
                }
            }
        }
    }

    private func openSettings() {
        if let settingsURL = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(settingsURL)
        }
    }

    // MARK: - Processing

    private func processScannedImages() {
        guard !scannedImages.isEmpty else {
            importError = "No images scanned"
            return
        }

        isProcessing = true
        processingMessage = "Extracting text..."

        Task {
            // Extract text from all scanned images
            var extractedText = ""

            for (index, image) in scannedImages.enumerated() {
                await MainActor.run {
                    processingMessage = "Processing page \(index + 1) of \(scannedImages.count)..."
                }

                if let text = await extractText(from: image) {
                    extractedText += text + "\n\n"
                }
            }

            let trimmedText = extractedText.trimmingCharacters(in: .whitespacesAndNewlines)

            guard !trimmedText.isEmpty else {
                await MainActor.run {
                    isProcessing = false
                    importError = "No text detected in the scanned images. Please try scanning again with clearer text."
                }
                return
            }

            await MainActor.run {
                processingMessage = "Creating article..."
            }

            do {
                let article = try await coordinator.importFromText(trimmedText, title: "Scanned Document")
                await MainActor.run {
                    importedArticle = article
                    isProcessing = false
                    showReader = true
                }
            } catch {
                await MainActor.run {
                    isProcessing = false
                    importError = error.localizedDescription
                }
            }
        }
    }

    private func extractText(from image: UIImage) async -> String? {
        guard let cgImage = image.cgImage else { return nil }

        return await withCheckedContinuation { continuation in
            var extractedText = ""

            let request = VNRecognizeTextRequest { request, error in
                guard let observations = request.results as? [VNRecognizedTextObservation] else {
                    continuation.resume(returning: nil)
                    return
                }

                for observation in observations {
                    if let topCandidate = observation.topCandidates(1).first {
                        extractedText += topCandidate.string + "\n"
                    }
                }

                continuation.resume(returning: extractedText.isEmpty ? nil : extractedText)
            }

            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

            DispatchQueue.global(qos: .userInitiated).async {
                do {
                    try handler.perform([request])
                } catch {
                    print("OCR error: \(error)")
                    continuation.resume(returning: nil)
                }
            }
        }
    }
}

// MARK: - Scanner View Representable

struct ScannerViewRepresentable: UIViewControllerRepresentable {
    let onScan: ([UIImage]) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> VNDocumentCameraViewController {
        let scanner = VNDocumentCameraViewController()
        scanner.delegate = context.coordinator
        return scanner
    }

    func updateUIViewController(_ uiViewController: VNDocumentCameraViewController, context: Context) {}

    func makeCoordinator() -> Coordinator {
        Coordinator(onScan: onScan, onCancel: onCancel)
    }

    class Coordinator: NSObject, VNDocumentCameraViewControllerDelegate {
        let onScan: ([UIImage]) -> Void
        let onCancel: () -> Void

        init(onScan: @escaping ([UIImage]) -> Void, onCancel: @escaping () -> Void) {
            self.onScan = onScan
            self.onCancel = onCancel
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
            var images: [UIImage] = []
            for pageIndex in 0..<scan.pageCount {
                images.append(scan.imageOfPage(at: pageIndex))
            }
            onScan(images)
        }

        func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
            onCancel()
        }

        func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
            print("Scanner error: \(error)")
            onCancel()
        }
    }
}

// MARK: - Preview

#Preview {
    ScanTextView()
}
