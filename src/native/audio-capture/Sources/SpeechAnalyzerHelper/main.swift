import AVFoundation
import CoreMedia
import Foundation
import Speech

struct InputMessage: Decodable {
    let type: String
    // realtime audio fields
    let data: String?
    let startMs: Double?
    let sampleRate: Double?
    // file mode fields
    let path: String?
    let locale: String?
}

struct DoneMessage: Encodable {
    let type: String
}

struct TranscriptMessage: Encodable {
    let type: String
    let speaker: String
    let text: String
    let isFinal: Bool
    let startMs: Int
    let endMs: Int
}

struct ErrorMessage: Encodable {
    let type: String
    let code: String
    let message: String
}

struct ReadyMessage: Encodable {
    let type: String
    let sampleRate: Double
}

@available(macOS 26.0, *)
final class SpeechAnalyzerRuntime: @unchecked Sendable {
    private let locale: Locale
    private let sampleRate: Double
    private let encoder = JSONEncoder()
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzerTask: Task<Void, Never>?
    private var resultTask: Task<Void, Never>?
    private var analyzer: SpeechAnalyzer?
    private var transcriber: SpeechTranscriber?
    private var analyzerFormat: AVAudioFormat?

    init(localeIdentifier: String = "ja-JP", sampleRate: Double = 16_000) {
        self.locale = Locale(identifier: localeIdentifier)
        self.sampleRate = sampleRate
    }

    func start() {
        let inputStream = AsyncStream<AnalyzerInput> { continuation in
            self.inputContinuation = continuation
        }

        analyzerTask = Task {
            do {
                guard SpeechTranscriber.isAvailable else {
                    emitError(code: "speech_transcriber_unavailable", message: "SpeechTranscriber is not available on this Mac")
                    return
                }

                let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) ?? locale
                let transcriber = SpeechTranscriber(
                    locale: supportedLocale,
                    preset: .timeIndexedProgressiveTranscription
                )
                try await ensureAssetsAvailable(for: transcriber, locale: supportedLocale)
                self.transcriber = transcriber

                resultTask = Task {
                    await consumeResults(from: transcriber)
                }

                let analyzer = SpeechAnalyzer(
                    modules: [transcriber],
                    options: .init(priority: .userInitiated, modelRetention: .whileInUse)
                )
                self.analyzer = analyzer

                guard let naturalFormat = AVAudioFormat(
                    commonFormat: .pcmFormatFloat32,
                    sampleRate: sampleRate,
                    channels: 1,
                    interleaved: false
                ) else {
                    emitError(code: "speech_audio_format_unavailable", message: "Failed to create natural audio format")
                    return
                }
                let format = await SpeechAnalyzer.bestAvailableAudioFormat(
                    compatibleWith: [transcriber],
                    considering: naturalFormat
                ) ?? naturalFormat
                self.analyzerFormat = format
                try await analyzer.prepareToAnalyze(in: format)
                emit(ReadyMessage(type: "ready", sampleRate: format.sampleRate))

                try await analyzer.start(inputSequence: inputStream)
            } catch {
                emitError(code: "speech_analyzer_failed", message: error.localizedDescription)
            }
        }
    }

    func appendAudio(base64: String, startMs: Double) {
        guard let data = Data(base64Encoded: base64) else {
            emitError(code: "invalid_audio_base64", message: "Audio chunk data is not valid base64")
            return
        }
        guard let buffer = makePCMBuffer(linear16: data) else {
            emitError(code: "invalid_audio_buffer", message: "Audio chunk could not be converted to PCM")
            return
        }

        let startTime = CMTime(value: CMTimeValue(startMs), timescale: 1000)
        inputContinuation?.yield(AnalyzerInput(buffer: buffer, bufferStartTime: startTime))
    }

    func stop() async {
        inputContinuation?.finish()
        if let analyzer {
            do {
                try await analyzer.finalizeAndFinishThroughEndOfInput()
            } catch {
                emitError(code: "speech_analyzer_finalize_failed", message: error.localizedDescription)
            }
        }
        resultTask?.cancel()
        analyzerTask?.cancel()
    }

    private func consumeResults(from transcriber: SpeechTranscriber) async {
        do {
            for try await result in transcriber.results {
                let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else {
                    continue
                }

                let startSeconds = CMTimeGetSeconds(result.range.start)
                let endSeconds = CMTimeGetSeconds(CMTimeRangeGetEnd(result.range))
                emitTranscript(
                    text: text,
                    isFinal: true,
                    startMs: milliseconds(fromSeconds: startSeconds),
                    endMs: milliseconds(fromSeconds: endSeconds)
                )
            }
        } catch {
            emitError(code: "speech_transcriber_results_failed", message: error.localizedDescription)
        }
    }

    private func makePCMBuffer(linear16 data: Data) -> AVAudioPCMBuffer? {
        guard let format = analyzerFormat else {
            return nil
        }

        let sourceFrames = data.count / MemoryLayout<Int16>.size
        let frameCount = AVAudioFrameCount(max(1, Int((Double(sourceFrames) * format.sampleRate / sampleRate).rounded(.down))))
        guard frameCount > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            return nil
        }

        buffer.frameLength = frameCount

        data.withUnsafeBytes { rawBuffer in
            let samples = rawBuffer.bindMemory(to: Int16.self)
            if let destination = buffer.floatChannelData?[0] {
                for index in 0..<Int(frameCount) {
                    let sourceIndex = min(sourceFrames - 1, Int((Double(index) * sampleRate / format.sampleRate).rounded(.down)))
                    destination[index] = max(-1.0, min(1.0, Float(samples[sourceIndex]) / 32768.0))
                }
            } else if let destination = buffer.int16ChannelData?[0] {
                for index in 0..<Int(frameCount) {
                    let sourceIndex = min(sourceFrames - 1, Int((Double(index) * sampleRate / format.sampleRate).rounded(.down)))
                    destination[index] = samples[sourceIndex]
                }
            }
        }

        return buffer
    }

    private func ensureAssetsAvailable(for transcriber: SpeechTranscriber, locale: Locale) async throws {
        _ = try await AssetInventory.reserve(locale: locale)
        let modules: [any SpeechModule] = [transcriber]
        let status = await AssetInventory.status(forModules: modules)
        switch status {
        case .installed:
            return
        case .supported, .downloading:
            if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                try await request.downloadAndInstall()
            }
        case .unsupported:
            emitError(code: "speech_assets_unsupported", message: "Speech assets are unsupported for locale \(locale.identifier)")
        @unknown default:
            emitError(code: "speech_assets_unknown_status", message: "Speech assets returned an unknown status")
        }
    }

    private func emitTranscript(text: String, isFinal: Bool, startMs: Int, endMs: Int) {
        emit(
            TranscriptMessage(
                type: "transcript",
                speaker: "counterpart",
                text: text,
                isFinal: isFinal,
                startMs: startMs,
                endMs: max(startMs + 1, endMs)
            )
        )
    }

    private func emitError(code: String, message: String) {
        emit(ErrorMessage(type: "error", code: code, message: message))
    }

    private func emit<T: Encodable>(_ message: T) {
        guard let data = try? encoder.encode(message), let line = String(data: data, encoding: .utf8) else {
            return
        }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

// MARK: - File-mode batch transcription

// REQUIRES on-device build verification (cannot compile Swift in CI/Linux env)

/// Reads an audio file via AVAudioFile, feeds it through SpeechAnalyzer, and emits
/// transcript JSON events identical to realtime mode, followed by {type:"done"}.
/// Per W3-C: supports {type:"file", path:"<abs path>", locale?} input message.
@available(macOS 26.0, *)
final class SpeechAnalyzerFileRuntime: @unchecked Sendable {
    private let locale: Locale
    private let encoder = JSONEncoder()

    init(localeIdentifier: String = "ja-JP") {
        self.locale = Locale(identifier: localeIdentifier)
    }

    func transcribe(filePath: String) async {
        let url = URL(fileURLWithPath: filePath)
        do {
            guard SpeechTranscriber.isAvailable else {
                emitError(code: "speech_transcriber_unavailable", message: "SpeechTranscriber is not available on this Mac")
                emitDone()
                return
            }

            let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) ?? locale
            let transcriber = SpeechTranscriber(
                locale: supportedLocale,
                preset: .timeIndexedProgressiveTranscription
            )
            _ = try await AssetInventory.reserve(locale: supportedLocale)
            let modules: [any SpeechModule] = [transcriber]
            let assetStatus = await AssetInventory.status(forModules: modules)
            switch assetStatus {
            case .installed:
                break
            case .supported, .downloading:
                if let request = try await AssetInventory.assetInstallationRequest(supporting: modules) {
                    try await request.downloadAndInstall()
                }
            case .unsupported:
                emitError(code: "speech_assets_unsupported", message: "Speech assets unsupported for locale \(supportedLocale.identifier)")
                emitDone()
                return
            @unknown default:
                break
            }

            let audioFile = try AVAudioFile(forReading: url)
            let fileFormat = audioFile.processingFormat

            let analyzer = SpeechAnalyzer(
                modules: [transcriber],
                options: .init(priority: .userInitiated, modelRetention: .whileInUse)
            )

            // Prefer the file's natural format; SpeechAnalyzer will pick the best compatible one.
            let naturalFormat = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: fileFormat.sampleRate,
                channels: 1,
                interleaved: false
            ) ?? fileFormat
            let analyzerFormat = await SpeechAnalyzer.bestAvailableAudioFormat(
                compatibleWith: [transcriber],
                considering: naturalFormat
            ) ?? naturalFormat

            try await analyzer.prepareToAnalyze(in: analyzerFormat)

            // Collect results concurrently while feeding audio buffers.
            let resultTask = Task<Void, Never> {
                do {
                    for try await result in transcriber.results {
                        let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !text.isEmpty else { continue }
                        let startSeconds = CMTimeGetSeconds(result.range.start)
                        let endSeconds = CMTimeGetSeconds(CMTimeRangeGetEnd(result.range))
                        self.emitTranscript(
                            text: text,
                            startMs: milliseconds(fromSeconds: startSeconds),
                            endMs: milliseconds(fromSeconds: endSeconds)
                        )
                    }
                } catch {
                    self.emitError(code: "speech_transcriber_results_failed", message: error.localizedDescription)
                }
            }

            // Build input sequence from file buffers.
            let inputStream = AsyncStream<AnalyzerInput> { continuation in
                Task {
                    let bufferFrameCapacity: AVAudioFrameCount = 4096
                    var currentSamplePosition: AVAudioFramePosition = 0

                    // Convert file buffers to the analyzer's required format using AVAudioConverter.
                    guard let converter = AVAudioConverter(from: fileFormat, to: analyzerFormat),
                          let convertedBuffer = AVAudioPCMBuffer(
                            pcmFormat: analyzerFormat,
                            frameCapacity: bufferFrameCapacity
                          ) else {
                        self.emitError(code: "speech_file_converter_failed", message: "Could not create AVAudioConverter for file")
                        continuation.finish()
                        return
                    }

                    while currentSamplePosition < audioFile.length {
                        guard let sourceBuffer = AVAudioPCMBuffer(pcmFormat: fileFormat, frameCapacity: bufferFrameCapacity) else {
                            break
                        }
                        do {
                            try audioFile.read(into: sourceBuffer)
                        } catch {
                            self.emitError(code: "speech_file_read_failed", message: error.localizedDescription)
                            break
                        }
                        guard sourceBuffer.frameLength > 0 else { break }

                        var error: NSError?
                        var inputConsumed = false
                        converter.convert(to: convertedBuffer, error: &error) { _, outStatus in
                            if inputConsumed {
                                outStatus.pointee = .noDataNow
                                return nil
                            }
                            inputConsumed = true
                            outStatus.pointee = .haveData
                            return sourceBuffer
                        }
                        if let error {
                            self.emitError(code: "speech_file_convert_failed", message: error.localizedDescription)
                            break
                        }

                        let startTimeSeconds = Double(currentSamplePosition) / fileFormat.sampleRate
                        let startTime = CMTime(value: CMTimeValue(startTimeSeconds * 1000), timescale: 1000)
                        continuation.yield(AnalyzerInput(buffer: convertedBuffer, bufferStartTime: startTime))
                        currentSamplePosition += AVAudioFramePosition(sourceBuffer.frameLength)
                    }
                    continuation.finish()
                }
            }

            try await analyzer.start(inputSequence: inputStream)
            try await analyzer.finalizeAndFinishThroughEndOfInput()
            await resultTask.value
        } catch {
            emitError(code: "speech_file_transcription_failed", message: error.localizedDescription)
        }

        emitDone()
    }

    private func emitTranscript(text: String, startMs: Int, endMs: Int) {
        emit(
            TranscriptMessage(
                type: "transcript",
                speaker: "counterpart",
                text: text,
                isFinal: true,
                startMs: startMs,
                endMs: max(startMs + 1, endMs)
            )
        )
    }

    private func emitDone() {
        emit(DoneMessage(type: "done"))
    }

    private func emitError(code: String, message: String) {
        emit(ErrorMessage(type: "error", code: code, message: message))
    }

    private func emit<T: Encodable>(_ message: T) {
        guard let data = try? encoder.encode(message), let line = String(data: data, encoding: .utf8) else {
            return
        }
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

// MARK: - Utilities

func milliseconds(fromSeconds seconds: Double) -> Int {
    if seconds.isFinite {
        return max(0, Int((seconds * 1000).rounded()))
    }
    return 0
}

func emitStartupError(_ code: String, _ message: String) {
    let encoder = JSONEncoder()
    let payload = ErrorMessage(type: "error", code: code, message: message)
    if let data = try? encoder.encode(payload), let line = String(data: data, encoding: .utf8) {
        FileHandle.standardOutput.write(Data((line + "\n").utf8))
    }
}

if #available(macOS 26.0, *) {
    // Read the first non-empty line to determine the operating mode:
    // - {type:"file", path, locale?} → batch file transcription mode (exit after done)
    // - {type:"audio"/"stop"} → realtime streaming mode (existing behaviour)
    var firstLinePendingInput = Data()
    var firstLineData: Data? = nil

    readFirstLine: while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty {
            // EOF before any message — nothing to do.
            exit(0)
        }
        firstLinePendingInput.append(chunk)
        if let newlineRange = firstLinePendingInput.firstRange(of: Data([0x0A])) {
            let lineData = firstLinePendingInput.subdata(in: firstLinePendingInput.startIndex..<newlineRange.lowerBound)
            firstLinePendingInput.removeSubrange(firstLinePendingInput.startIndex..<newlineRange.upperBound)
            if !lineData.isEmpty {
                firstLineData = lineData
                break readFirstLine
            }
        }
    }

    guard let firstLineData else {
        exit(0)
    }

    do {
        let firstMessage = try JSONDecoder().decode(InputMessage.self, from: firstLineData)

        if firstMessage.type == "file" {
            // --- File (batch) mode ---
            guard let filePath = firstMessage.path, !filePath.isEmpty else {
                emitStartupError("missing_file_path", "file message must include a non-empty path")
                exit(1)
            }
            let localeId = firstMessage.locale ?? "ja-JP"
            let fileRuntime = SpeechAnalyzerFileRuntime(localeIdentifier: localeId)
            let semaphore = DispatchSemaphore(value: 0)
            Task {
                await fileRuntime.transcribe(filePath: filePath)
                semaphore.signal()
            }
            semaphore.wait()
            exit(0)
        }

        // --- Realtime (streaming) mode ---
        // The first line was an audio/stop/other message — start the realtime runtime and
        // re-process the first line, then continue reading from stdin.
        let runtime = SpeechAnalyzerRuntime()
        runtime.start()

        func handleRealtimeMessage(_ lineData: Data) {
            guard let message = try? JSONDecoder().decode(InputMessage.self, from: lineData) else {
                emitStartupError("invalid_input_message", "Could not decode input message")
                return
            }
            switch message.type {
            case "audio":
                if let audio = message.data {
                    runtime.appendAudio(base64: audio, startMs: message.startMs ?? 0)
                }
            case "stop":
                let stopSemaphore = DispatchSemaphore(value: 0)
                Task {
                    await runtime.stop()
                    stopSemaphore.signal()
                }
                stopSemaphore.wait()
                exit(0)
            default:
                break
            }
        }

        // Process the already-read first line.
        handleRealtimeMessage(firstLineData)

        // Continue processing remaining stdin lines (including any bytes buffered after the first line).
        var pendingInput = firstLinePendingInput
        while true {
            let chunk = FileHandle.standardInput.availableData
            if chunk.isEmpty {
                break
            }
            pendingInput.append(chunk)

            while let newlineRange = pendingInput.firstRange(of: Data([0x0A])) {
                let lineData = pendingInput.subdata(in: pendingInput.startIndex..<newlineRange.lowerBound)
                pendingInput.removeSubrange(pendingInput.startIndex..<newlineRange.upperBound)
                guard !lineData.isEmpty else { continue }
                handleRealtimeMessage(lineData)
            }
        }

        let semaphore = DispatchSemaphore(value: 0)
        Task {
            await runtime.stop()
            semaphore.signal()
        }
        semaphore.wait()

    } catch {
        emitStartupError("invalid_input_message", error.localizedDescription)
        exit(1)
    }
} else {
    emitStartupError("speech_analyzer_unsupported_macos", "Apple SpeechAnalyzer requires macOS 26.0 or newer")
    exit(2)
}
