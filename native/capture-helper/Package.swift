// swift-tools-version: 5.10
import PackageDescription
import Foundation

let directory = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
    name: "MeetingLoopCapture",
    platforms: [.macOS(.v13)],
    products: [.executable(name: "meeting-loop-capture", targets: ["CaptureHelper"])],
    targets: [
        .executableTarget(
            name: "CaptureHelper",
            linkerSettings: [.unsafeFlags([
                "-Xlinker", "-sectcreate", "-Xlinker", "__TEXT",
                "-Xlinker", "__info_plist", "-Xlinker", "\(directory)/Info.plist"
            ])]
        )
    ]
)
