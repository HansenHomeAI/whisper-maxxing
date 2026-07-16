import Foundation
import Testing
@testable import WhisperMacCaptureCore

private final class ChunkCollector: @unchecked Sendable {
    private let lock = NSLock()
    private var chunks: [[Int16]] = []

    func append(_ chunk: [Int16]) {
        lock.lock()
        chunks.append(chunk)
        lock.unlock()
    }

    func snapshot() -> [[Int16]] {
        lock.lock()
        defer { lock.unlock() }
        return chunks
    }
}

@Suite("Sample chunker")
struct SampleChunkerTests {
    @Test("aggregates fragmented input into exact 20 ms chunks")
    func chunksFragmentedInput() {
        let collector = ChunkCollector()
        let chunker = SampleChunker { collector.append($0) }
        chunker.append(Array(0..<100).map(Int16.init))
        chunker.append(Array(100..<319).map(Int16.init))
        #expect(collector.snapshot().isEmpty)
        chunker.append(Array(319..<700).map(Int16.init))

        let chunks = collector.snapshot()
        #expect(chunks.count == 2)
        #expect(chunks[0] == Array(0..<320).map(Int16.init))
        #expect(chunks[1] == Array(320..<640).map(Int16.init))
        #expect(chunker.bufferedSampleCount == 60)
    }
}
