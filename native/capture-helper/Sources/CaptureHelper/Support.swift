import Foundation
import AVFoundation
import CoreAudio
import CoreGraphics
import Darwin

struct CaptureFailure: LocalizedError {
    let message: String
    var errorDescription: String? { message }
    init(_ message: String) { self.message = message }
}

struct Options {
    let command: String
    var values: [String: String] = [:]
    var consent = false

    init(_ arguments: [String]) throws {
        command = arguments.first ?? "help"
        var index = 1
        while index < arguments.count {
            let key = arguments[index]
            guard key.hasPrefix("--") else { throw CaptureFailure("Expected option; received \(key)") }
            if key == "--consent" { consent = true; index += 1; continue }
            guard index + 1 < arguments.count else { throw CaptureFailure("Missing value for \(key)") }
            values[String(key.dropFirst(2))] = arguments[index + 1]
            index += 2
        }
        let allowed: Set<String> = ["directory", "mic", "system", "display-id", "application-pid", "device-id"]
        if let unknown = values.keys.first(where: { !allowed.contains($0) }) {
            throw CaptureFailure("Unknown option --\(unknown)")
        }
    }

    func bool(_ key: String, default fallback: Bool) throws -> Bool {
        guard let value = values[key] else { return fallback }
        guard ["true", "false"].contains(value) else { throw CaptureFailure("--\(key) must be true or false") }
        return value == "true"
    }

    func outputDirectory() throws -> URL {
        guard let path = values["directory"], path.hasPrefix("/") else {
            throw CaptureFailure("An absolute --directory is required")
        }
        let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
        guard url.path == url.resolvingSymlinksInPath().path else {
            throw CaptureFailure("Capture directory must not contain symbolic links")
        }
        return url
    }
}

final class EventSink: @unchecked Sendable {
    private let lock = NSLock()
    private var handle: FileHandle?
    private var sequence = 0
    private var journalFailed = false
    var failed: Bool {
        lock.lock(); defer { lock.unlock() }
        return journalFailed
    }
    private let origin = ProcessInfo.processInfo.systemUptime

    init(journal: URL? = nil) throws {
        if let journal {
            guard !FileManager.default.fileExists(atPath: journal.path) else {
                throw CaptureFailure("Existing recording journal must not be overwritten")
            }
            guard FileManager.default.createFile(atPath: journal.path, contents: nil,
                                                 attributes: [.posixPermissions: 0o600]) else {
                throw CaptureFailure("Cannot create capture event journal")
            }
            handle = try FileHandle(forWritingTo: journal)
        }
    }

    func emit(_ type: String, _ fields: [String: Any] = [:], durable: Bool = false) {
        lock.lock(); defer { lock.unlock() }
        sequence += 1
        var event = fields
        event["type"] = type
        event["sequence"] = sequence
        event["time"] = max(0, ProcessInfo.processInfo.systemUptime - origin)
        guard var data = try? JSONSerialization.data(withJSONObject: event, options: [.sortedKeys]) else { return }
        data.append(0x0a)
        do {
            try handle?.write(contentsOf: data)
            if durable { try handle?.synchronize() }
        } catch {
            journalFailed = true
            let message = "{\"type\":\"error\",\"code\":\"journal_write_failed\",\"message\":\"Recording journal cannot be written; capture will stop.\"}\n"
            try? FileHandle.standardOutput.write(contentsOf: Data(message.utf8))
        }
        try? FileHandle.standardOutput.write(contentsOf: data)
    }

    deinit { try? handle?.close() }
}

func microphoneAuthorizationName() -> String {
    switch AVCaptureDevice.authorizationStatus(for: .audio) {
    case .authorized: return "authorized"
    case .denied: return "denied"
    case .restricted: return "restricted"
    case .notDetermined: return "not_determined"
    @unknown default: return "unknown"
    }
}

func diagnostics() -> [String: Any] {
    ["version": "0.1.0", "platform": "macOS", "architecture": "\(architecture())",
     "os": ProcessInfo.processInfo.operatingSystemVersionString,
     "microphonePermission": microphoneAuthorizationName(),
     "screenRecordingPermission": CGPreflightScreenCaptureAccess() ? "authorized" : "not_authorized",
     "permissionPrompted": false, "chunkSeconds": 5,
     "trackFormat": "CAF / source PCM", "screenVideoSaved": false,
     "commands": ["diagnostics", "devices", "record", "screenshot", "self-test"]]
}

func architecture() -> String {
    #if arch(arm64)
    return "arm64"
    #else
    return "x86_64"
    #endif
}

func inputDevices() throws -> [[String: Any]] {
    var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDevices,
                                             mScope: kAudioObjectPropertyScopeGlobal,
                                             mElement: kAudioObjectPropertyElementMain)
    var size: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size) == noErr else {
        throw CaptureFailure("Cannot enumerate audio devices")
    }
    var devices = [AudioDeviceID](repeating: 0, count: Int(size) / MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &devices) == noErr else {
        throw CaptureFailure("Cannot read audio devices")
    }
    var defaultInput = AudioDeviceID(0)
    var defaultSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    var defaultAddress = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyDefaultInputDevice,
                                                    mScope: kAudioObjectPropertyScopeGlobal,
                                                    mElement: kAudioObjectPropertyElementMain)
    AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &defaultAddress, 0, nil,
                               &defaultSize, &defaultInput)
    return devices.compactMap { device in
        var streams = AudioObjectPropertyAddress(mSelector: kAudioDevicePropertyStreams,
                                                 mScope: kAudioDevicePropertyScopeInput,
                                                 mElement: kAudioObjectPropertyElementMain)
        var streamSize: UInt32 = 0
        guard AudioObjectGetPropertyDataSize(device, &streams, 0, nil, &streamSize) == noErr,
              streamSize > 0 else { return nil }
        var nameAddress = AudioObjectPropertyAddress(mSelector: kAudioObjectPropertyName,
                                                     mScope: kAudioObjectPropertyScopeGlobal,
                                                     mElement: kAudioObjectPropertyElementMain)
        var name: CFString = "Audio input" as CFString
        var nameSize = UInt32(MemoryLayout<CFString>.size)
        _ = withUnsafeMutablePointer(to: &name) {
            AudioObjectGetPropertyData(device, &nameAddress, 0, nil, &nameSize, $0)
        }
        return ["id": device, "name": name as String, "isDefault": device == defaultInput]
    }
}

func atomicJSON(_ value: [String: Any], to file: URL) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys])
    try data.write(to: file, options: [.atomic])
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: file.path)
    let handle = try FileHandle(forWritingTo: file)
    try handle.synchronize()
    try handle.close()
}

func synchronizeDirectory(_ directory: URL) throws {
    let descriptor = open(directory.path, O_RDONLY)
    guard descriptor >= 0 else { throw CaptureFailure("Cannot open audio directory for synchronization") }
    defer { close(descriptor) }
    guard fsync(descriptor) == 0 else { throw CaptureFailure("Cannot synchronize audio directory") }
}
