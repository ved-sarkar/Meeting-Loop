import Foundation
import AVFoundation
import Darwin

@main
struct CaptureHelper {
    static func main() async {
        signal(SIGPIPE, SIG_IGN)
        do {
            let options = try Options(Array(CommandLine.arguments.dropFirst()))
            switch options.command {
            case "diagnostics": try EventSink().emit("diagnostics", diagnostics())
            case "devices": try EventSink().emit("devices", ["microphones": try inputDevices(), "permissionPrompted": false])
            case "record":
                guard options.consent else { throw CaptureFailure("Recording requires explicit --consent from a visible user start action") }
                let recorder = try Recorder(options: options)
                do { try await recorder.start() }
                catch {
                    recorder.reportStartupFailure(error)
                    await recorder.stop()
                    exit(1)
                }
                let input = Task.detached {
                    while let line = readLine() {
                        recorder.command(line)
                        if recorder.shouldStop { break }
                    }
                    recorder.command("stop")
                }
                signal(SIGINT, SIG_IGN)
                signal(SIGTERM, SIG_IGN)
                let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
                let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
                interrupt.setEventHandler { recorder.command("stop") }
                terminate.setEventHandler { recorder.command("stop") }
                interrupt.resume()
                terminate.resume()
                var tick = 0
                while !recorder.shouldStop {
                    try await Task.sleep(nanoseconds: 200_000_000)
                    tick += 1
                    if tick % 10 == 0 { recorder.checkDiskSpace() }
                }
                await recorder.stop()
                input.cancel()
                interrupt.cancel()
                terminate.cancel()
                exit(recorder.didFail ? 1 : 0)
            case "screenshot":
                guard options.consent else { throw CaptureFailure("A screenshot requires explicit --consent and a visible user selection") }
                try screenshot(options)
            case "self-test": try syntheticTest(options)
            case "crash-fixture": try crashFixture(options)
            case "help", "--help", "-h": print(help)
            default: throw CaptureFailure("Unknown command. Run meeting-loop-capture help")
            }
        } catch {
            try? EventSink().emit("error", ["code": "command_failed", "message": error.localizedDescription])
            exit(1)
        }
    }

    static let help = """
    Meeting Loop native capture helper

      diagnostics                         Permission status; never prompts.
      devices                             Audio input devices; never prompts.
      record --directory ABS --consent    Start local mic + system audio.
        --mic true|false                  Default true.
        --system true|false               Default true.
        --device-id NUMBER                Optional CoreAudio microphone id.
        --display-id NUMBER               Default main display.
        --application-pid NUMBER          Limit system audio to one application.
      screenshot --directory ABS --consent   Apple's interactive region/window picker.
      self-test --directory ABS           Generate synthetic tones; no capture permissions.

    Record commands on stdin: pause, resume, stop (plain lines or JSON command objects).
    All record output is JSONL. Keep stdin open while recording; EOF stops capture.
    Record only when everyone has consented as required. No networking is implemented.
    """
}

func screenshot(_ options: Options) throws {
    let directory = try options.outputDirectory()
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true,
                                            attributes: [.posixPermissions: 0o700])
    let output = directory.appendingPathComponent("selection-\(UUID().uuidString.lowercased()).png")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-i", "-x", output.path]
    let errors = Pipe()
    process.standardError = errors
    process.standardOutput = FileHandle.nullDevice
    try process.run()
    process.waitUntilExit()
    let sink = try EventSink()
    guard process.terminationStatus == 0, FileManager.default.fileExists(atPath: output.path) else {
        sink.emit("cancelled", ["operation": "screenshot", "message": "Selection cancelled or screenshot permission unavailable"])
        return
    }
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
    sink.emit("screenshot", ["file": output.path, "selection": "interactive_user_picker",
                              "createdAt": ISO8601DateFormatter().string(from: Date())])
}

/// Exercises the real chunk writer with generated tones, without touching devices or TCC.
func syntheticTest(_ options: Options) throws {
    let directory = try options.outputDirectory()
    let manager = FileManager.default
    guard !manager.fileExists(atPath: directory.path) else { throw CaptureFailure("Self-test requires a new directory") }
    let chunks = directory.appendingPathComponent("chunks")
    try manager.createDirectory(at: chunks, withIntermediateDirectories: true,
                                attributes: [.posixPermissions: 0o700])
    let sink = try EventSink(journal: directory.appendingPathComponent("events.jsonl"))
    let format = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
    let mic = ChunkWriter(track: "mic", directory: chunks, sink: sink)
    let system = ChunkWriter(track: "system", directory: chunks, sink: sink)
    for second in 0..<12 {
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 48_000)!
        buffer.frameLength = 48_000
        for frame in 0..<48_000 {
            buffer.floatChannelData![0][frame] = Float(sin(2 * Double.pi * 440 * Double(frame) / 48_000) * 0.08)
        }
        try mic.append(buffer, at: Double(second))
        try system.append(buffer, at: Double(second))
    }
    try mic.finish()
    try system.finish()
    var readFrames: Int64 = 0
    for file in try manager.contentsOfDirectory(at: chunks, includingPropertiesForKeys: nil) {
        let audio = try AVAudioFile(forReading: file)
        readFrames += audio.length
    }
    guard mic.committedChunks == 3, system.committedChunks == 3,
          readFrames == 12 * 48_000 * 2 else { throw CaptureFailure("Synthetic chunk round-trip verification failed") }
    let checks = try verifyCaptureInvariants(under: directory) + 1
    try atomicJSON(["schemaVersion": 1, "synthetic": true, "complete": true,
                    "duration": 12, "readFrames": readFrames, "chunks": 6, "checksPassed": checks],
                   to: directory.appendingPathComponent("manifest.json"))
    sink.emit("self_test", ["passed": true, "synthetic": true, "permissionPrompted": false,
                            "chunks": 6, "readFrames": readFrames, "checksPassed": checks], durable: true)
}
