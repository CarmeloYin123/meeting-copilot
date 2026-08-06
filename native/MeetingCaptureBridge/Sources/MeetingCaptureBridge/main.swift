import AVFoundation
import CoreGraphics
import CoreMedia
import Foundation
import ScreenCaptureKit

struct PermissionResult: Encodable {
    let screen: Bool
    let microphone: Bool
}

struct AudioFrame: Encodable {
    let source: String
    let sampleRate: Int
    let channels: Int
    let pcmBase64: String
    let capturedAt: String
}

@available(macOS 14.0, *)
final class StreamOutput: NSObject, SCStreamOutput, SCStreamDelegate {
    private let isoFormatter = ISO8601DateFormatter()

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard sampleBuffer.isValid, CMSampleBufferDataIsReady(sampleBuffer) else { return }
        guard outputType == .audio else { return }
        guard let formatDescription = sampleBuffer.formatDescription,
              let description = CMAudioFormatDescriptionGetStreamBasicDescription(formatDescription) else { return }

        do {
            try sampleBuffer.withAudioBufferList { audioBufferList, _ in
                let buffers = audioBufferList.unsafePointer.pointee
                guard buffers.mNumberBuffers > 0, let pointer = buffers.mBuffers.mData else { return }
                let byteCount = Int(buffers.mBuffers.mDataByteSize)
                guard byteCount > 0,
                      let data = pcm16Data(pointer: pointer, byteCount: byteCount, format: description.pointee) else { return }
                let frame = AudioFrame(
                    source: "system",
                    sampleRate: Int(description.pointee.mSampleRate),
                    channels: Int(description.pointee.mChannelsPerFrame),
                    pcmBase64: data.base64EncodedString(),
                    capturedAt: isoFormatter.string(from: Date())
                )
                write(frame)
            }
        } catch {
            write(["type": "capture_error", "message": error.localizedDescription])
        }
    }

    private func pcm16Data(pointer: UnsafeMutableRawPointer, byteCount: Int, format: AudioStreamBasicDescription) -> Data? {
        guard Int(format.mSampleRate.rounded()) == 16_000, format.mChannelsPerFrame == 1 else { return nil }
        let bytesPerSample = Int(format.mBitsPerChannel / 8)
        guard bytesPerSample > 0 else { return nil }
        let sampleCount = byteCount / bytesPerSample
        guard sampleCount > 0 else { return nil }
        if format.mBitsPerChannel == 16 {
            return Data(bytes: pointer, count: sampleCount * MemoryLayout<Int16>.size)
        }
        guard format.mBitsPerChannel == 32 else { return nil }
        let isFloat = (format.mFormatFlags & UInt32(kAudioFormatFlagIsFloat)) != 0
        var output = Data(capacity: sampleCount * MemoryLayout<Int16>.size)
        for index in 0..<sampleCount {
            let normalized: Float
            if isFloat {
                normalized = pointer.assumingMemoryBound(to: Float.self)[index]
            } else {
                normalized = Float(pointer.assumingMemoryBound(to: Int32.self)[index]) / Float(Int32.max)
            }
            var pcm = Int16((max(-1, min(1, normalized)) * Float(Int16.max)).rounded())
            withUnsafeBytes(of: &pcm) { output.append(contentsOf: $0) }
        }
        return output
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        write(["type": "capture_error", "message": error.localizedDescription])
    }

    func announceCaptureStarted() {
        write(["type": "capture_status", "source": "system", "status": "capture-started"])
    }

    private func write<T: Encodable>(_ value: T) {
        guard let data = try? JSONEncoder().encode(value),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }
}

@available(macOS 14.0, *)
final class MicrophoneCapture {
    private let engine = AVAudioEngine()
    private let isoFormatter = ISO8601DateFormatter()
    private let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatInt16,
        sampleRate: 16_000,
        channels: 1,
        interleaved: false
    )!
    private var converter: AVAudioConverter?
    private var sourceSampleRate: Double = 0
    private var sourceChannelCount: AVAudioChannelCount = 0
    private var reportedConversionError = false

    func start() throws {
        let input = engine.inputNode
        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            throw NSError(
                domain: "MeetingCaptureBridge",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "未检测到可用的麦克风输入格式。"]
            )
        }
        // Use the hardware format selected by macOS. Asking the tap to force a
        // format can silently produce no callbacks on some built-in / Bluetooth
        // microphones. Conversion happens inside the callback instead.
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1_024, format: nil) { [weak self] buffer, _ in
            self?.emitConvertedFrame(buffer)
        }
        engine.prepare()
        try engine.start()
        write(["type": "capture_status", "source": "microphone", "status": "capture-started"])
    }

    func stop() {
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
    }

    private func emitConvertedFrame(_ buffer: AVAudioPCMBuffer) {
        let inputFormat = buffer.format
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else { return }
        if converter == nil || sourceSampleRate != inputFormat.sampleRate || sourceChannelCount != inputFormat.channelCount {
            converter = AVAudioConverter(from: inputFormat, to: outputFormat)
            sourceSampleRate = inputFormat.sampleRate
            sourceChannelCount = inputFormat.channelCount
        }
        guard let converter else {
            reportConversionError("无法初始化麦克风 16k PCM 转换器。")
            return
        }
        let capacity = AVAudioFrameCount(
            max(1, (Double(buffer.frameLength) * outputFormat.sampleRate / inputFormat.sampleRate).rounded(.up) + 8)
        )
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            reportConversionError("无法分配麦克风 PCM 输出缓冲。")
            return
        }
        do {
            try converter.convert(to: output, from: buffer)
        } catch {
            reportConversionError("麦克风 PCM 转换失败：\(error.localizedDescription)")
            return
        }
        guard output.frameLength > 0,
              let samples = output.int16ChannelData else { return }
        let data = Data(bytes: samples[0], count: Int(output.frameLength) * MemoryLayout<Int16>.size)
        guard !data.isEmpty else { return }
        let frame = AudioFrame(
            source: "microphone",
            sampleRate: 16_000,
            channels: 1,
            pcmBase64: data.base64EncodedString(),
            capturedAt: isoFormatter.string(from: Date())
        )
        write(frame)
    }

    private func reportConversionError(_ message: String) {
        guard !reportedConversionError else { return }
        reportedConversionError = true
        write(["type": "capture_error", "message": message])
    }

    private func write<T: Encodable>(_ value: T) {
        guard let data = try? JSONEncoder().encode(value),
              let line = String(data: data, encoding: .utf8) else { return }
        print(line)
        fflush(stdout)
    }
}

@available(macOS 14.0, *)
final class CaptureSession {
    let output: StreamOutput
    let stream: SCStream
    let microphone: MicrophoneCapture

    init(output: StreamOutput, stream: SCStream, microphone: MicrophoneCapture) {
        self.output = output
        self.stream = stream
        self.microphone = microphone
    }

    func start() async throws {
        try microphone.start()
        try await stream.startCapture()
        output.announceCaptureStarted()
    }

    deinit {
        microphone.stop()
    }
}

@available(macOS 14.0, *)
func startCapture() async throws -> CaptureSession {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first else {
        throw NSError(domain: "MeetingCaptureBridge", code: 1, userInfo: [NSLocalizedDescriptionKey: "未找到可采集的显示器。"])
    }
    let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
    let config = SCStreamConfiguration()
    config.capturesAudio = true
    config.excludesCurrentProcessAudio = true
    config.sampleRate = 16_000
    config.channelCount = 1

    let output = StreamOutput()
    let stream = SCStream(filter: filter, configuration: config, delegate: output)
    try stream.addStreamOutput(output, type: .audio, sampleHandlerQueue: DispatchQueue(label: "com.meetingcopilot.system-audio"))
    let session = CaptureSession(output: output, stream: stream, microphone: MicrophoneCapture())
    try await session.start()
    return session
}

func checkPermissions() {
    let screen = CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess()
    let semaphore = DispatchSemaphore(value: 0)
    let microphoneResult = MicrophonePermissionResult(
        granted: AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
    )
    if !microphoneResult.granted {
        AVCaptureDevice.requestAccess(for: .audio) { granted in
            microphoneResult.granted = granted
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: .now() + 20)
    }
    let result = PermissionResult(screen: screen, microphone: microphoneResult.granted)
    if let data = try? JSONEncoder().encode(result), let text = String(data: data, encoding: .utf8) {
        print(text)
    }
}

final class MicrophonePermissionResult: @unchecked Sendable {
    var granted: Bool
    init(granted: Bool) {
        self.granted = granted
    }
}

if CommandLine.arguments.contains("--check-permissions") {
    checkPermissions()
} else if #available(macOS 14.0, *) {
    do {
        let session = try await startCapture()
        while !Task.isCancelled {
            try await Task.sleep(nanoseconds: 3_600_000_000_000)
        }
        _ = session
    } catch {
        let error = ["type": "capture_error", "message": error.localizedDescription]
        if let data = try? JSONSerialization.data(withJSONObject: error), let text = String(data: data, encoding: .utf8) { print(text) }
        exit(1)
    }
} else {
    fputs("macOS 14 or later is required.\\n", stderr)
    exit(2)
}
