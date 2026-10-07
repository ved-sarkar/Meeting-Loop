import Foundation
import AVFoundation
import AudioToolbox
import CoreGraphics
import ScreenCaptureKit

final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
    let directory: URL
    let sink: EventSink
    private let options: Options
    private let queue = DispatchQueue(label: "com.meetingloop.capture.writer", qos: .userInitiated)
    private let screenQueue = DispatchQueue(label: "com.meetingloop.capture.screen", qos: .userInitiated)
    private var stream: SCStream?
    private var engine: AVAudioEngine?
    private var micWriter: ChunkWriter?
    private var systemWriter: ChunkWriter?
    private var origin = ProcessInfo.processInfo.systemUptime
    private var paused = false
    private var stopRequested = false
    private var stopped = false
    private var failed = false
    private var pauseStart: Double?
    private var configurationObserver: NSObjectProtocol?
    private var manifest: [String: Any] = ["schemaVersion": 1, "status": "starting",
                                           "privacy": "LOCAL_ONLY", "consent": "explicit_start",
                                           "createdAt": ISO8601DateFormatter().string(from: Date()),
                                           "complete": false]

    init(options: Options) throws {
        self.options = options
        directory = try options.outputDirectory()
        let manager = FileManager.default
        if manager.fileExists(atPath: directory.appendingPathComponent("manifest.json").path) ||
           manager.fileExists(atPath: directory.appendingPathComponent("events.jsonl").path) {
            throw CaptureFailure("Choose a new session directory; existing capture must not be overwritten")
        }
        try manager.createDirectory(at: directory, withIntermediateDirectories: true,
                                    attributes: [.posixPermissions: 0o700])
        let chunks = directory.appendingPathComponent("chunks", isDirectory: true)
        guard !manager.fileExists(atPath: chunks.path) else {
            throw CaptureFailure("Choose a fresh directory without existing audio chunks")
        }
        try manager.createDirectory(at: chunks, withIntermediateDirectories: false,
                                    attributes: [.posixPermissions: 0o700])
        sink = try EventSink(journal: directory.appendingPathComponent("events.jsonl"))
        super.init()
        micWriter = ChunkWriter(track: "mic", directory: chunks, sink: sink)
        systemWriter = ChunkWriter(track: "system", directory: chunks, sink: sink)
    }

    var shouldStop: Bool { queue.sync { stopRequested || sink.failed } }
    var didFail: Bool { queue.sync { failed || sink.failed } }

    func start() async throws {
        let microphone = try options.bool("mic", default: true)
        let system = try options.bool("system", default: true)
        guard microphone || system else { throw CaptureFailure("Select at least one audio source") }
        if microphone {
            var granted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
            if AVCaptureDevice.authorizationStatus(for: .audio) == .notDetermined {
                granted = await AVCaptureDevice.requestAccess(for: .audio)
            }
            guard granted else { throw CaptureFailure("Microphone permission is denied. Enable it in System Settings > Privacy & Security > Microphone.") }
        }
        if system && !CGPreflightScreenCaptureAccess() {
            guard CGRequestScreenCaptureAccess() else {
                throw CaptureFailure("System audio requires Screen & System Audio Recording permission. Enable it in System Settings and restart the app if macOS requests it.")
            }
        }
        origin = ProcessInfo.processInfo.systemUptime
        manifest = ["schemaVersion": 1, "createdAt": ISO8601DateFormatter().string(from: Date()),
                    "status": "recording", "privacy": "LOCAL_ONLY", "consent": "explicit_start",
                    "clock": "monotonic_uptime_seconds_relative_to_session_start",
                    "chunkSeconds": 5, "tracks": ["mic": microphone, "system": system],
                    "videoCaptured": false, "complete": false]
        try atomicJSON(manifest, to: directory.appendingPathComponent("manifest.json"))
        if system { try await startSystem() }
        if microphone { try startMicrophone() }
        sink.emit("ready", ["directory": directory.path, "mic": microphone, "system": system,
                            "state": "recording"], durable: true)
        sink.emit("state", ["state": "recording", "at": elapsed], durable: true)
    }

    private var elapsed: Double { max(0, ProcessInfo.processInfo.systemUptime - origin) }

    private func startSystem() async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        let display: SCDisplay?
        if let value = options.values["display-id"] {
            guard let id = UInt32(value) else { throw CaptureFailure("Invalid --display-id") }
            display = content.displays.first(where: { $0.displayID == id })
        } else {
            display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first
        }
        guard let display else { throw CaptureFailure("Requested display is not available for system audio") }
        let filter: SCContentFilter
        if let value = options.values["application-pid"] {
            guard let pid = Int32(value), let application = content.applications.first(where: { $0.processID == pid }) else {
                throw CaptureFailure("Requested application is not available for audio capture")
            }
            filter = SCContentFilter(display: display, including: [application], exceptingWindows: [])
            sink.emit("source", ["track": "system", "scope": "application", "pid": pid])
        } else {
            filter = SCContentFilter(display: display, excludingWindows: [])
            sink.emit("source", ["track": "system", "scope": "system_audio", "displayId": display.displayID])
        }
        let configuration = SCStreamConfiguration()
        configuration.capturesAudio = true
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48_000
        configuration.channelCount = 2
        configuration.width = 2
        configuration.height = 2
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        configuration.showsCursor = false
        let stream = SCStream(filter: filter, configuration: configuration, delegate: self)
        try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: screenQueue)
        self.stream = stream
        // There is deliberately no screen output: no screen images are persisted or exposed.
        try await stream.startCapture()
    }

    private func startMicrophone() throws {
        let engine = AVAudioEngine()
        let input = engine.inputNode
        if let requested = options.values["device-id"] {
            guard var device = UInt32(requested), let unit = input.audioUnit else {
                throw CaptureFailure("Invalid microphone --device-id")
            }
            let result = AudioUnitSetProperty(unit, kAudioOutputUnitProperty_CurrentDevice,
                                              kAudioUnitScope_Global, 0, &device,
                                              UInt32(MemoryLayout<AudioDeviceID>.size))
            guard result == noErr else { throw CaptureFailure("Requested microphone is unavailable (\(result))") }
        }
        let format = input.outputFormat(forBus: 0)
        guard format.channelCount > 0, format.sampleRate > 0 else { throw CaptureFailure("No usable microphone is connected") }
        input.installTap(onBus: 0, bufferSize: 4096, format: format) { [weak self] buffer, time in
            guard let self else { return }
            let timestamp = time.isHostTimeValid ? AVAudioTime.seconds(forHostTime: time.hostTime) : ProcessInfo.processInfo.systemUptime
            do {
                let copied = try copyAudio(buffer)
                self.accept(copied, track: "mic", timestamp: max(0, timestamp - self.origin))
            } catch { self.fail("microphone_buffer_failed", error.localizedDescription) }
        }
        self.engine = engine
        engine.prepare()
        try engine.start()
        configurationObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: nil
        ) { [weak self] _ in
            self?.fail("microphone_configuration_changed", "The microphone device or format changed. Saved chunks are safe; start a new recording with the available device.")
        }
        sink.emit("source", ["track": "mic", "sampleRate": format.sampleRate,
                             "channels": format.channelCount])
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let description = sampleBuffer.formatDescription,
              let format = AVAudioFormat(cmAudioFormatDescription: description) as AVAudioFormat?,
              let buffer = AVAudioPCMBuffer(pcmFormat: format,
                                             frameCapacity: AVAudioFrameCount(sampleBuffer.numSamples)) else { return }
        buffer.frameLength = AVAudioFrameCount(sampleBuffer.numSamples)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0,
                                                                  frameCount: Int32(buffer.frameLength),
                                                                  into: buffer.mutableAudioBufferList)
        guard status == noErr else { fail("system_buffer_failed", "Cannot decode system audio buffer (\(status))"); return }
        let timestamp = CMTimeGetSeconds(sampleBuffer.presentationTimeStamp) - origin
        guard timestamp.isFinite else { fail("system_timestamp_invalid", "System audio timestamp is invalid"); return }
        accept(buffer, track: "system", timestamp: max(0, timestamp))
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        fail("system_audio_stopped", error.localizedDescription)
    }

    private func accept(_ buffer: AVAudioPCMBuffer, track: String, timestamp: Double) {
        queue.async { [weak self] in
            guard let self, !self.paused, !self.stopRequested, !self.stopped,
                  timestamp >= self.resumeCutoff else { return }
            do {
                try (track == "mic" ? self.micWriter : self.systemWriter)?.append(buffer, at: timestamp)
            } catch {
                self.failed = true
                self.stopRequested = true
                self.sink.emit("error", ["code": "audio_write_failed", "track": track,
                                          "message": error.localizedDescription], durable: true)
            }
        }
    }

    func command(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let command: String
        if let data = trimmed.data(using: .utf8),
           let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let name = value["command"] as? String { command = name }
        else { command = trimmed }
        queue.sync {
            guard !stopped else { return }
            do {
                switch command {
                case "pause":
                    guard !paused, !stopRequested else { return }
                    paused = true
                    pauseStart = elapsed
                    try micWriter?.breakSegment()
                    try systemWriter?.breakSegment()
                    sink.emit("state", ["state": "paused", "at": elapsed], durable: true)
                case "resume":
                    guard paused, !stopRequested else { return }
                    // A timestamp cutoff also excludes pre-resume buffers arriving late.
                    resumeCutoff = elapsed
                    paused = false
                    sink.emit("gap", ["start": pauseStart ?? elapsed, "end": elapsed,
                                      "reason": "private_pause", "track": "all"], durable: true)
                    pauseStart = nil
                    sink.emit("state", ["state": "recording", "at": elapsed], durable: true)
                case "stop": stopRequested = true
                default: sink.emit("warning", ["code": "unknown_command", "message": "Expected pause, resume or stop"])
                }
            } catch {
                failed = true
                stopRequested = true
                sink.emit("error", ["code": "chunk_finalize_failed", "message": error.localizedDescription], durable: true)
            }
        }
    }

    private var resumeCutoff = 0.0

    private func fail(_ code: String, _ message: String) {
        queue.async {
            guard !self.stopped else { return }
            self.failed = true
            self.stopRequested = true
            self.sink.emit("error", ["code": code, "message": message], durable: true)
        }
    }

    func reportStartupFailure(_ error: Error) {
        fail("capture_start_failed", error.localizedDescription)
    }

    func checkDiskSpace() {
        do {
            let attributes = try FileManager.default.attributesOfFileSystem(forPath: directory.path)
            if let free = attributes[.systemFreeSize] as? NSNumber, free.int64Value < 128 * 1024 * 1024 {
                fail("disk_space_low", "Less than 128 MB remains on the recording disk. Recording is stopping to protect saved chunks.")
            }
        } catch { fail("disk_status_failed", "Cannot check recording disk availability") }
    }

    func stop() async {
        queue.sync { stopped = true; stopRequested = true }
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        if let stream { try? await stream.stopCapture() }
        queue.sync {
            do {
                try micWriter?.finish()
                try systemWriter?.finish()
                manifest["status"] = failed ? "failed" : "stopped"
                manifest["complete"] = !failed && !sink.failed
                manifest["duration"] = elapsed
                manifest["stoppedAt"] = ISO8601DateFormatter().string(from: Date())
                manifest["committedChunks"] = ["mic": micWriter?.committedChunks ?? 0,
                                                "system": systemWriter?.committedChunks ?? 0]
                try atomicJSON(manifest, to: directory.appendingPathComponent("manifest.json"))
                sink.emit("stopped", ["state": "stopped", "at": elapsed,
                                      "complete": !failed && !sink.failed,
                                      "micChunks": micWriter?.committedChunks ?? 0,
                                      "systemChunks": systemWriter?.committedChunks ?? 0], durable: true)
            } catch {
                failed = true
                sink.emit("error", ["code": "finalize_failed", "message": error.localizedDescription], durable: true)
            }
        }
    }
}
