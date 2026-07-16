import Foundation

public final class SampleChunker: @unchecked Sendable {
    public typealias ChunkHandler = @Sendable ([Int16]) -> Void

    private let samplesPerChunk: Int
    private let chunkHandler: ChunkHandler
    private let lock = NSLock()
    private var storage: [Int16] = []
    private var readIndex = 0

    public init(
        samplesPerChunk: Int = CaptureProtocol.samplesPerFrame,
        chunkHandler: @escaping ChunkHandler
    ) {
        precondition(samplesPerChunk > 0)
        self.samplesPerChunk = samplesPerChunk
        self.chunkHandler = chunkHandler
    }

    public func append(_ samples: UnsafeBufferPointer<Int16>) {
        lock.lock()
        storage.append(contentsOf: samples)
        var chunks: [[Int16]] = []
        while storage.count - readIndex >= samplesPerChunk {
            let endIndex = readIndex + samplesPerChunk
            chunks.append(Array(storage[readIndex..<endIndex]))
            readIndex = endIndex
        }
        compactStorageIfNeeded()
        lock.unlock()

        for chunk in chunks {
            chunkHandler(chunk)
        }
    }

    public func append(_ samples: [Int16]) {
        samples.withUnsafeBufferPointer(append)
    }

    public var bufferedSampleCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return storage.count - readIndex
    }

    private func compactStorageIfNeeded() {
        if readIndex == storage.count {
            storage.removeAll(keepingCapacity: true)
            readIndex = 0
        } else if readIndex >= 4_096 {
            storage.removeFirst(readIndex)
            readIndex = 0
        }
    }
}
