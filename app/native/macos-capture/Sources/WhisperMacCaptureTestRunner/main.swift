import Foundation
import WhisperMacCaptureCore

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    let result = try SelfTest.run(
        includeFilesystemSocketTest: !arguments.contains("--sandboxed")
    )
    guard !result.suites.isEmpty else {
        throw TestRunnerFailure.zeroTests
    }
    for (index, suite) in result.suites.enumerated() {
        print(
            "Test \(index + 1)/\(result.suites.count): \(suite.name) "
                + "passed (\(suite.assertionCount) assertions)"
        )
    }
    print(
        "NATIVE HELPER TEST HARNESS PASSED: \(result.suites.count) tests, "
            + "\(result.assertionCount) assertions, 0 failures"
    )
    if let stampFlag = arguments.firstIndex(of: "--stamp") {
        guard arguments.indices.contains(stampFlag + 1) else {
            throw TestRunnerFailure.missingStampPath
        }
        try Data("passed\n".utf8).write(
            to: URL(fileURLWithPath: arguments[stampFlag + 1]),
            options: .atomic
        )
    }
} catch {
    FileHandle.standardError.write(
        Data("NATIVE HELPER TEST HARNESS FAILED: \(error.localizedDescription)\n".utf8)
    )
    exit(1)
}

private enum TestRunnerFailure: Error, LocalizedError {
    case zeroTests
    case missingStampPath

    var errorDescription: String? {
        switch self {
        case .zeroTests:
            return "the shared test inventory executed zero tests"
        case .missingStampPath:
            return "--stamp requires an output path"
        }
    }
}
