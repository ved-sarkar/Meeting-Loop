import Foundation
import AVFoundation
import Darwin

/// Command-line-tools macOS SDKs omit XCTest. Keep the synthetic validation executable
/// through the helper itself so the exact shipping audio code can be checked there too.
func verifyCaptureInvariants(under root: URL) throws -> Int {
    func require(_ condition: @autoclosure () -> Bool, _ message: String) throws {
        guard condition() else { throw CaptureFailure("Self-test: \(message)") }
    }
    func audio(seconds: Double, rate: Double = 48_000) -> AVAudioPCMBuffer {
        let format = AVAudioFormat(standardFormatWithSampleRate: rate, channels: 1)!
        let frames = AVAudioFrameCount(seconds * rate)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: frames)!
        buffer.frameLength = frames
        for i in 0..<Int(frames) { buffer.floatChannelData![0][i] = Float(i % 100) / 1000 }
        return buffer
    }
    func fixture(_ name: String) throws -> (URL, URL, EventSink) {
        let directory = root.appendingPathComponent("checks/\(name)")
        let chunks = directory.appendingPathComponent("chunks")
        try FileManager.default.createDirectory(at: chunks, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        return (directory, chunks, try EventSink(journal: directory.appendingPathComponent("events.jsonl")))
    }
    func events(_ directory: URL) throws -> [[String: Any]] {
        try String(contentsOf: directory.appendingPathComponent("events.jsonl"), encoding: .utf8)
            .split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
    }

    do {
        let (directory, chunks, sink) = try fixture("gap")
        let writer = ChunkWriter(track: "system", directory: chunks, sink: sink)
        try writer.append(audio(seconds: 1), at: 0)
        try writer.append(audio(seconds: 1), at: 3)
        try writer.finish()
        let captured = try events(directory)
        let gap = captured.first { $0["type"] as? String == "gap" }
        try require(gap?["start"] as? Double == 1 && gap?["end"] as? Double == 3, "discontinuity must be explicit")
        try require(captured.filter { $0["type"] as? String == "chunk" }.count == 2, "gap must split files")
    }
    do {
        let (directory, chunks, sink) = try fixture("abandoned_writer")
        var writer: ChunkWriter? = ChunkWriter(track: "mic", directory: chunks, sink: sink)
        try writer?.append(audio(seconds: 6), at: 0)
        writer = nil
        let committed = try events(directory).filter { $0["type"] as? String == "chunk" }
        try require(committed.count == 1, "only the completed chunk should be registered")
        let file = try AVAudioFile(forReading: directory.appendingPathComponent(committed[0]["file"] as! String))
        try require(file.length == 5 * 48_000, "committed chunk must remain readable")
        try require(FileManager.default.fileExists(atPath: chunks.appendingPathComponent("mic-000002.partial.caf").path), "active chunk must stay marked partial")
    }
    do {
        let (directory, chunks, sink) = try fixture("format_change")
        let writer = ChunkWriter(track: "mic", directory: chunks, sink: sink)
        try writer.append(audio(seconds: 1), at: 0)
        try writer.append(audio(seconds: 1, rate: 44_100), at: 1)
        try writer.finish()
        let committed = try events(directory).filter { $0["type"] as? String == "chunk" }
        try require(committed.compactMap { $0["sampleRate"] as? Double } == [48_000, 44_100], "format change must split files")
    }
    do {
        let (directory, chunks, sink) = try fixture("private_gap")
        let writer = ChunkWriter(track: "mic", directory: chunks, sink: sink)
        try writer.append(audio(seconds: 1), at: 0)
        try writer.breakSegment()
        try writer.append(audio(seconds: 1), at: 8)
        try writer.finish()
        let committed = try events(directory).filter { $0["type"] as? String == "chunk" }
        try require(committed.compactMap { $0["start"] as? Double } == [0, 8], "pause must preserve timeline gap")
        try require(writer.committedFrames == 2 * 48_000, "private time must not become fabricated audio")
    }
    do {
        var relativeRejected = false
        do { _ = try Options(["record", "--directory", "relative"]).outputDirectory() }
        catch { relativeRejected = true }
        try require(relativeRejected, "relative capture directory must be rejected")
        var invalidBoolRejected = false
        do { _ = try Options(["record", "--mic", "perhaps"]).bool("mic", default: true) }
        catch { invalidBoolRejected = true }
        try require(invalidBoolRejected, "invalid boolean must be rejected")
        let link = root.appendingPathComponent("checks/symlink")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: root)
        var symlinkRejected = false
        do { _ = try Options(["record", "--directory", link.path]).outputDirectory() }
        catch { symlinkRejected = true }
        try require(symlinkRejected, "symlink capture directory must be rejected")
        try FileManager.default.removeItem(at: link)
    }
    do {
        let directory = root.appendingPathComponent("checks/forced_process_crash")
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[0]).standardizedFileURL
        child.arguments = ["crash-fixture", "--directory", directory.path]
        child.standardOutput = FileHandle.nullDevice
        child.standardError = FileHandle.nullDevice
        try child.run()
        child.waitUntilExit()
        try require(child.terminationReason == .uncaughtSignal && child.terminationStatus == SIGKILL,
                    "crash fixture must be terminated abruptly")
        let committed = try events(directory).filter { $0["type"] as? String == "chunk" }
        try require(committed.count == 1, "forced crash must retain committed event")
        let file = try AVAudioFile(forReading: directory.appendingPathComponent(committed[0]["file"] as! String))
        let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat, frameCapacity: AVAudioFrameCount(file.length))!
        try file.read(into: buffer)
        try require(file.length == 5 * 48_000 && rmsLevel(buffer) > 0,
                    "forced crash must retain the complete playable five-second chunk")
    }
    return 6
}

/// Used only by self-test. Synthetic PCM is deliberately killed after one committed chunk.
func crashFixture(_ options: Options) throws {
    let directory = try options.outputDirectory()
    guard !FileManager.default.fileExists(atPath: directory.path) else { throw CaptureFailure("Crash fixture needs a new directory") }
    let chunks = directory.appendingPathComponent("chunks")
    try FileManager.default.createDirectory(at: chunks, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    let sink = try EventSink(journal: directory.appendingPathComponent("events.jsonl"))
    let writer = ChunkWriter(track: "mic", directory: chunks, sink: sink)
    let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 6 * 48_000)!
    buffer.frameLength = 6 * 48_000
    for frame in 0..<Int(buffer.frameLength) { buffer.floatChannelData![0][frame] = 0.02 }
    try writer.append(buffer, at: 0)
    kill(getpid(), SIGKILL)
}
