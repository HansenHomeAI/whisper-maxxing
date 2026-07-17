#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

func expectSharedSuite(
    _ name: String,
    includeFilesystemSocketTest: Bool = false
) throws {
    let result = try SelfTest.run(
        onlySuiteNamed: name,
        includeFilesystemSocketTest: includeFilesystemSocketTest
    )
    #expect(result.suites.count == 1)
    #expect(result.suites.first?.name == name)
    #expect((result.suites.first?.assertionCount ?? 0) > 0)
    #expect(result.assertionCount == result.suites.first?.assertionCount)
}
#else
@testable import WhisperMacCaptureCore

enum TestHarnessAnchor {
    static let linked = true
}
#endif
