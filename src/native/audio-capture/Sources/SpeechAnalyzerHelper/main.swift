import AVFoundation
import CoreMedia
import Foundation
import Speech

struct InputMessage: Decodable {
    let type: String
    let data: String?
    let startMs: Double?
    let sampleRate: Double?
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

@available(macOS 26.0, *)
final class SpeechAnalyzerRuntime: @unchecked Sendable {
    private let locale: Locale
    private let sampleRate: Double
    private let encoder = JSONEncoder()
    private var inputContinuation: AsyncStream<AnalyzerInput>.Continuation?
    private var analyzerTask: Task<Void, Never>?
    private var resultTask: Task<Void, Never>?
    private var transcriber: SpeechTranscriber?

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
                self.transcriber = transcriber

                resultTask = Task {
                    await consumeResults(from: transcriber)
                }

                let analyzer = SpeechAnalyzer(
                    modules: [transcriber],
                    options: .init(priority: .userInitiated, modelRetention: .whileInUse)
                )

                if let format = AVAudioFormat(
                    commonFormat: .pcmFormatFloat32,
                    sampleRate: sampleRate,
                    channels: 1,
                    interleaved: false
                ) {
                    try await analyzer.prepareToAnalyze(in: format)
                }

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

    func stop() {
        inputContinuation?.finish()
        analyzerTask?.cancel()
        resultTask?.cancel()
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
                    startMs: milliseconds(fromSeconds: startSeconds),
                    endMs: milliseconds(fromSeconds: endSeconds)
                )
            }
        } catch {
            emitError(code: "speech_transcriber_results_failed", message: error.localizedDescription)
        }
    }

    private func makePCMBuffer(linear16 data: Data) -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(
            commonFormat: .pcmFormatFloat32,
            sampleRate: sampleRate,
            channels: 1,
            interleaved: false
        ) else {
            return nil
        }

        let frameCount = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
        guard frameCount > 0, let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frameCount) else {
            return nil
        }

        buffer.frameLength = frameCount
        guard let destination = buffer.floatChannelData?[0] else {
            return nil
        }

        data.withUnsafeBytes { rawBuffer in
            let samples = rawBuffer.bindMemory(to: Int16.self)
            for index in 0..<Int(frameCount) {
                destination[index] = max(-1.0, min(1.0, Float(samples[index]) / 32768.0))
            }
        }

        return buffer
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
    let runtime = SpeechAnalyzerRuntime()
    runtime.start()

    while let line = readLine(strippingNewline: true) {
        guard let data = line.data(using: .utf8) else {
            continue
        }

        do {
            let message = try JSONDecoder().decode(InputMessage.self, from: data)
            switch message.type {
            case "audio":
                if let audio = message.data {
                    runtime.appendAudio(base64: audio, startMs: message.startMs ?? 0)
                }
            case "stop":
                runtime.stop()
                exit(0)
            default:
                continue
            }
        } catch {
            emitStartupError("invalid_input_message", error.localizedDescription)
        }
    }

    runtime.stop()
} else {
    emitStartupError("speech_analyzer_unsupported_macos", "Apple SpeechAnalyzer requires macOS 26.0 or newer")
    exit(2)
}
