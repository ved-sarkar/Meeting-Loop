import Foundation
import AVFoundation

/// Call only on the recorder's serial queue. Each closed CAF is independently playable.
final class ChunkWriter {
    let track: String
    let directory: URL
    let sink: EventSink
    let chunkSeconds: Double
    private var file: AVAudioFile?
    private var partialURL: URL?
    private var format: AVAudioFormat?
    private var frames: AVAudioFramePosition = 0
    private var chunkStart = 0.0
    private var previousEnd: Double?
    private var number = 0
    private var lastMeterTime = -1.0
    private(set) var committedChunks = 0
    private(set) var committedFrames: Int64 = 0

    init(track: String, directory: URL, sink: EventSink, chunkSeconds: Double = 5) {
        self.track = track
        self.directory = directory
        self.sink = sink
        self.chunkSeconds = chunkSeconds
    }

    func append(_ buffer: AVAudioPCMBuffer, at timestamp: Double) throws {
        guard buffer.frameLength > 0 else { return }
        guard timestamp.isFinite, timestamp >= 0 else { throw CaptureFailure("Invalid audio timestamp") }
        let sameFormat = format?.isEqual(buffer.format) ?? true
        if !sameFormat {
            try finish()
            sink.emit("warning", ["code": "format_changed", "track": track,
                                   "message": "Audio format changed; a new chunk starts here."], durable: true)
        }
        if let previousEnd, abs(timestamp - previousEnd) > 0.25 {
            try finish()
            sink.emit("gap", ["track": track, "start": previousEnd, "end": timestamp,
                              "reason": "source_discontinuity"], durable: true)
        }
        format = buffer.format
        var offset: AVAudioFrameCount = 0
        let capacity = AVAudioFramePosition((buffer.format.sampleRate * chunkSeconds).rounded())
        guard capacity > 0 else { throw CaptureFailure("Invalid audio format") }
        while offset < buffer.frameLength {
            if file == nil { try begin(format: buffer.format, at: timestamp + Double(offset) / buffer.format.sampleRate) }
            let count = min(buffer.frameLength - offset, AVAudioFrameCount(capacity - frames))
            let slice = try copyAudio(buffer, offset: offset, count: count)
            try file?.write(from: slice)
            frames += AVAudioFramePosition(count)
            offset += count
            if frames >= capacity { try finish() }
        }
        previousEnd = timestamp + Double(buffer.frameLength) / buffer.format.sampleRate
        if timestamp - lastMeterTime >= 0.25 {
            lastMeterTime = timestamp
            sink.emit("level", ["track": track, "rms": rmsLevel(buffer), "at": timestamp])
        }
    }

    func finish() throws {
        guard let partialURL, let format, frames > 0 else { file = nil; return }
        // AVAudioFile closes its header when released, before rename makes the chunk visible.
        file = nil
        let handle = try FileHandle(forWritingTo: partialURL)
        try handle.synchronize()
        try handle.close()
        let name = "\(track)-\(String(format: "%06d", number)).caf"
        let destination = directory.appendingPathComponent(name)
        try FileManager.default.moveItem(at: partialURL, to: destination)
        try synchronizeDirectory(directory)
        sink.emit("chunk", ["track": track, "file": "chunks/\(name)",
                            "start": chunkStart, "end": chunkStart + Double(frames) / format.sampleRate,
                            "frames": frames, "sampleRate": format.sampleRate,
                            "channels": format.channelCount, "format": "caf"], durable: true)
        committedChunks += 1
        committedFrames += frames
        self.partialURL = nil
        frames = 0
    }

    func breakSegment() throws {
        try finish()
        previousEnd = nil
    }

    private func begin(format: AVAudioFormat, at timestamp: Double) throws {
        number += 1
        let name = "\(track)-\(String(format: "%06d", number)).partial.caf"
        let url = directory.appendingPathComponent(name)
        guard !FileManager.default.fileExists(atPath: url.path) else { throw CaptureFailure("Refusing to overwrite audio") }
        file = try AVAudioFile(forWriting: url, settings: format.settings,
                               commonFormat: format.commonFormat, interleaved: format.isInterleaved)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: url.path)
        partialURL = url
        chunkStart = timestamp
        frames = 0
    }
}

func copyAudio(_ source: AVAudioPCMBuffer, offset: AVAudioFrameCount = 0,
               count: AVAudioFrameCount? = nil) throws -> AVAudioPCMBuffer {
    let count = count ?? source.frameLength
    guard let copy = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: count) else {
        throw CaptureFailure("Cannot allocate audio buffer")
    }
    copy.frameLength = count
    let from = UnsafeMutableAudioBufferListPointer(source.mutableAudioBufferList)
    let to = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
    let bytesPerFrame = Int(source.format.streamDescription.pointee.mBytesPerFrame)
    for index in 0..<from.count {
        guard let src = from[index].mData, let dst = to[index].mData else { continue }
        memcpy(dst, src.advanced(by: Int(offset) * bytesPerFrame), Int(count) * bytesPerFrame)
    }
    return copy
}

func rmsLevel(_ buffer: AVAudioPCMBuffer) -> Double {
    guard buffer.format.commonFormat == .pcmFormatFloat32,
          let samples = buffer.floatChannelData, buffer.frameLength > 0 else { return 0 }
    let sampleCount = Int(buffer.frameLength) * (buffer.format.isInterleaved ? Int(buffer.format.channelCount) : 1)
    var sum = 0.0
    for index in 0..<sampleCount { sum += Double(samples[0][index] * samples[0][index]) }
    return min(1, sqrt(sum / Double(sampleCount)))
}
