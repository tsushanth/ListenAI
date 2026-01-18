import Foundation
import Vision
import PDFKit
import UIKit

// MARK: - OCR Service

/// Service for extracting text from images and scanned PDFs using Vision framework.
actor OCRService {

    // MARK: - Singleton

    static let shared = OCRService()

    // MARK: - Configuration

    private let recognitionLevel: VNRequestTextRecognitionLevel = .accurate
    private let recognitionLanguages: [String] = ["en-US"]
    private let usesLanguageCorrection: Bool = true

    // MARK: - Public Methods

    /// Extract text from an image
    func extractText(from image: UIImage) async throws -> String {
        guard let cgImage = image.cgImage else {
            throw OCRError.invalidImage
        }

        return try await performOCR(on: cgImage)
    }

    /// Extract text from image data
    func extractText(from imageData: Data) async throws -> String {
        guard let image = UIImage(data: imageData),
              let cgImage = image.cgImage else {
            throw OCRError.invalidImage
        }

        return try await performOCR(on: cgImage)
    }

    /// Extract text from a scanned PDF
    func extractText(from pdfURL: URL) async throws -> OCRExtractionResult {
        guard let document = PDFDocument(url: pdfURL) else {
            throw OCRError.pdfLoadFailed
        }

        return try await extractText(from: document, sourceURL: pdfURL)
    }

    /// Extract text from PDF data
    func extractText(from pdfData: Data) async throws -> OCRExtractionResult {
        guard let document = PDFDocument(data: pdfData) else {
            throw OCRError.pdfLoadFailed
        }

        return try await extractText(from: document, sourceURL: nil)
    }

    /// Extract text from a PDFDocument
    func extractText(from document: PDFDocument, sourceURL: URL?) async throws -> OCRExtractionResult {
        let pageCount = document.pageCount

        guard pageCount > 0 else {
            throw OCRError.emptyDocument
        }

        var allPageTexts: [PageOCRResult] = []
        var totalConfidence: Float = 0

        for pageIndex in 0..<pageCount {
            guard let page = document.page(at: pageIndex) else { continue }

            let pageResult = try await extractText(from: page, pageNumber: pageIndex + 1)
            allPageTexts.append(pageResult)
            totalConfidence += pageResult.confidence
        }

        let combinedText = allPageTexts
            .map { $0.text }
            .joined(separator: "\n\n")

        let avgConfidence = allPageTexts.isEmpty ? 0 : totalConfidence / Float(allPageTexts.count)

        // Extract title from first page or filename
        let title = extractTitle(from: combinedText, sourceURL: sourceURL)

        return OCRExtractionResult(
            text: combinedText,
            title: title,
            pageResults: allPageTexts,
            totalPages: pageCount,
            averageConfidence: avgConfidence,
            language: detectLanguage(combinedText)
        )
    }

    /// Extract text from a single PDF page
    func extractText(from page: PDFPage, pageNumber: Int) async throws -> PageOCRResult {
        // Render page to image at high resolution for better OCR
        let pageRect = page.bounds(for: .mediaBox)
        let scale: CGFloat = 2.0 // 2x scale for better OCR accuracy

        let width = Int(pageRect.width * scale)
        let height = Int(pageRect.height * scale)

        UIGraphicsBeginImageContextWithOptions(
            CGSize(width: width, height: height),
            true,
            1.0
        )

        guard let context = UIGraphicsGetCurrentContext() else {
            UIGraphicsEndImageContext()
            throw OCRError.renderFailed
        }

        // White background
        context.setFillColor(UIColor.white.cgColor)
        context.fill(CGRect(x: 0, y: 0, width: width, height: height))

        // Scale and flip for PDF rendering
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: 0, y: pageRect.height)
        context.scaleBy(x: 1, y: -1)

        // Draw PDF page
        page.draw(with: .mediaBox, to: context)

        let image = UIGraphicsGetImageFromCurrentImageContext()
        UIGraphicsEndImageContext()

        guard let cgImage = image?.cgImage else {
            throw OCRError.renderFailed
        }

        let (text, confidence) = try await performOCRWithConfidence(on: cgImage)

        return PageOCRResult(
            pageNumber: pageNumber,
            text: text,
            confidence: confidence,
            wordCount: text.split(separator: " ").count
        )
    }

    // MARK: - Private Methods

    private func performOCR(on cgImage: CGImage) async throws -> String {
        let (text, _) = try await performOCRWithConfidence(on: cgImage)
        return text
    }

    private func performOCRWithConfidence(on cgImage: CGImage) async throws -> (String, Float) {
        return try await withCheckedThrowingContinuation { continuation in
            let request = VNRecognizeTextRequest { request, error in
                if let error = error {
                    continuation.resume(throwing: OCRError.recognitionFailed(error.localizedDescription))
                    return
                }

                guard let observations = request.results as? [VNRecognizedTextObservation] else {
                    continuation.resume(returning: ("", 0))
                    return
                }

                var recognizedTexts: [String] = []
                var totalConfidence: Float = 0
                var observationCount: Int = 0

                for observation in observations {
                    guard let topCandidate = observation.topCandidates(1).first else { continue }
                    recognizedTexts.append(topCandidate.string)
                    totalConfidence += topCandidate.confidence
                    observationCount += 1
                }

                let avgConfidence = observationCount > 0 ? totalConfidence / Float(observationCount) : 0
                let text = recognizedTexts.joined(separator: "\n")

                continuation.resume(returning: (text, avgConfidence))
            }

            request.recognitionLevel = recognitionLevel
            request.recognitionLanguages = recognitionLanguages
            request.usesLanguageCorrection = usesLanguageCorrection

            let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])

            do {
                try handler.perform([request])
            } catch {
                continuation.resume(throwing: OCRError.recognitionFailed(error.localizedDescription))
            }
        }
    }

    private func extractTitle(from text: String, sourceURL: URL?) -> String {
        // Try first line if it looks like a title
        let lines = text.components(separatedBy: "\n")
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        if let firstLine = lines.first,
           firstLine.count > 5 && firstLine.count < 150 && !firstLine.contains(".") {
            return firstLine
        }

        // Fall back to filename
        if let url = sourceURL {
            let name = (url.lastPathComponent as NSString).deletingPathExtension
            return name.replacingOccurrences(of: "_", with: " ")
                .replacingOccurrences(of: "-", with: " ")
        }

        return "Scanned Document"
    }

    private func detectLanguage(_ text: String) -> String {
        let sample = String(text.prefix(1000))
        let englishWords = ["the", "is", "and", "of", "to", "in", "a", "that", "for", "it"]
        let words = sample.lowercased().split(separator: " ").map(String.init)
        let englishCount = words.filter { englishWords.contains($0) }.count

        if Float(englishCount) / Float(max(1, words.count)) > 0.1 {
            return "en"
        }

        return "en" // Default
    }
}

// MARK: - OCR Error

enum OCRError: LocalizedError {
    case invalidImage
    case pdfLoadFailed
    case emptyDocument
    case renderFailed
    case recognitionFailed(String)
    case noTextFound

    var errorDescription: String? {
        switch self {
        case .invalidImage:
            return "Could not process the image"
        case .pdfLoadFailed:
            return "Could not load the PDF document"
        case .emptyDocument:
            return "The document is empty"
        case .renderFailed:
            return "Could not render the page for text recognition"
        case .recognitionFailed(let reason):
            return "Text recognition failed: \(reason)"
        case .noTextFound:
            return "No text was found in the document"
        }
    }
}

// MARK: - OCR Result Types

struct OCRExtractionResult: Sendable {
    let text: String
    let title: String
    let pageResults: [PageOCRResult]
    let totalPages: Int
    let averageConfidence: Float
    let language: String

    var wordCount: Int {
        text.split(separator: " ").count
    }

    var isEmpty: Bool {
        text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var confidencePercentage: Int {
        Int(averageConfidence * 100)
    }
}

struct PageOCRResult: Sendable {
    let pageNumber: Int
    let text: String
    let confidence: Float
    let wordCount: Int

    var confidencePercentage: Int {
        Int(confidence * 100)
    }
}
