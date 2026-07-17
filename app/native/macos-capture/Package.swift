// swift-tools-version: 6.0

import Foundation
import PackageDescription

let developerDirectory = ProcessInfo.processInfo.environment["DEVELOPER_DIR"]
    ?? "/Library/Developer/CommandLineTools"
let testingFrameworks = "\(developerDirectory)/Library/Developer/Frameworks"
let testingLibraries = "\(developerDirectory)/Library/Developer/usr/lib"
let testingMacros = "\(developerDirectory)/usr/lib/swift/host/plugins/testing/libTestingMacros.dylib"
let needsCommandLineToolsTestingPaths = FileManager.default.fileExists(
    atPath: testingMacros
)
let testingSwiftSettings: [SwiftSetting] = needsCommandLineToolsTestingPaths
    ? [
        .unsafeFlags([
            "-F", testingFrameworks,
            "-Xfrontend", "-load-plugin-library",
            "-Xfrontend", testingMacros,
        ]),
    ]
    : []
let testingLinkerSettings: [LinkerSetting] = needsCommandLineToolsTestingPaths
    ? [
        .unsafeFlags([
            "-F", testingFrameworks,
            "-Xlinker", "-rpath",
            "-Xlinker", testingFrameworks,
            "-Xlinker", "-rpath",
            "-Xlinker", testingLibraries,
        ]),
    ]
    : []

let package = Package(
    name: "WhisperMacCapture",
    platforms: [
        .macOS(.v14),
    ],
    products: [
        .executable(
            name: "whisper-mac-capture",
            targets: ["WhisperMacCapture"]
        ),
    ],
    dependencies: [
        .package(name: "WhisperMaxxingRoot", path: "../../.."),
    ],
    targets: [
        .target(
            name: "WhisperMacCaptureCore",
            dependencies: [
                .product(
                    name: "WhisperDictationCore",
                    package: "WhisperMaxxingRoot"
                ),
            ],
            linkerSettings: [
                .linkedFramework("AudioToolbox"),
                .linkedFramework("CoreAudio"),
            ]
        ),
        .executableTarget(
            name: "WhisperMacCapture",
            dependencies: ["WhisperMacCaptureCore"],
            swiftSettings: [
                .define(
                    "WMC_RUNTIME_TEST_HOOKS",
                    .when(configuration: .debug)
                ),
            ]
        ),
        .executableTarget(
            name: "WhisperMacCaptureTestRunner",
            dependencies: ["WhisperMacCaptureCore"]
        ),
        .testTarget(
            name: "WhisperMacCaptureCoreTests",
            dependencies: ["WhisperMacCaptureCore"],
            swiftSettings: testingSwiftSettings,
            linkerSettings: testingLinkerSettings,
            plugins: ["WhisperMacCaptureTestPlugin"]
        ),
        .plugin(
            name: "WhisperMacCaptureTestPlugin",
            capability: .buildTool(),
            dependencies: ["WhisperMacCaptureTestRunner"]
        ),
    ]
)
