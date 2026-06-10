// swift-tools-version: 6.2

import PackageDescription

let package = Package(
    name: "SalesTalkAudioCapture",
    platforms: [.macOS(.v26)],
    products: [
        .executable(name: "speech-analyzer-helper", targets: ["SpeechAnalyzerHelper"])
    ],
    targets: [
        .executableTarget(
            name: "SpeechAnalyzerHelper",
            path: "Sources/SpeechAnalyzerHelper"
        )
    ]
)
