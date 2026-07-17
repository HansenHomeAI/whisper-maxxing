import Foundation
import PackagePlugin

@main
struct WhisperMacCaptureTestPlugin: BuildToolPlugin {
    func createBuildCommands(
        context: PluginContext,
        target: Target
    ) async throws -> [Command] {
        let runner = try context.tool(named: "WhisperMacCaptureTestRunner")
        let nonce = context.pluginWorkDirectoryURL.appending(
            path: "invocation-nonce.txt"
        )
        let stamp = context.pluginWorkDirectoryURL.appending(
            path: "test-harness.stamp"
        )
        try UUID().uuidString.write(
            to: nonce,
            atomically: true,
            encoding: .utf8
        )
        return [
            .buildCommand(
                displayName: "Execute native helper test harness",
                executable: runner.url,
                arguments: [
                    "--sandboxed",
                    "--stamp",
                    stamp.path,
                ],
                inputFiles: [nonce],
                outputFiles: [stamp]
            ),
        ]
    }
}
