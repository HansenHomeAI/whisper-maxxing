#if canImport(Testing)
import Testing
@testable import WhisperMacCaptureCore

@Suite("Capture supervisor lifecycle")
struct SupervisorLifecycleTests {
    @Test("cancels before launchd submission")
    func beforeSubmit() throws {
        try expectSharedSuite("SupervisorCancellation.beforeSubmit")
    }

    @Test("cancels after submission and before worker connection")
    func afterSubmitBeforeConnect() throws {
        try expectSharedSuite(
            "SupervisorCancellation.afterSubmitBeforeConnect"
        )
    }

    @Test("forces cleanup for a connected unresponsive worker")
    func connectedUnresponsive() throws {
        try expectSharedSuite("SupervisorCancellation.connectedUnresponsive")
    }

    @Test("surfaces launchd and private-directory cleanup failures")
    func surfacesCleanupFailures() throws {
        try expectSharedSuite("LaunchdCleanup.surfacesFailures")
    }
}
#endif
