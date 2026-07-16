import Foundation

public struct CommandLineOptions: Equatable, Sendable {
    public enum Mode: Equatable, Sendable {
        case capture
        case selfTest
        case version
    }

    public let mode: Mode
    public let preferredInputDevice: String?
    public let enforcePreferredInputDevice: Bool

    public init(
        mode: Mode,
        preferredInputDevice: String?,
        enforcePreferredInputDevice: Bool
    ) {
        self.mode = mode
        self.preferredInputDevice = preferredInputDevice
        self.enforcePreferredInputDevice = enforcePreferredInputDevice
    }

    public static func parse(arguments: [String]) throws -> CommandLineOptions {
        var mode = Mode.capture
        var preferredInputDevice: String?
        var enforcePreferredInputDevice = false
        var index = 0

        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--self-test":
                guard mode == .capture else {
                    throw CommandLineError.conflictingModes
                }
                mode = .selfTest
            case "--version":
                guard mode == .capture else {
                    throw CommandLineError.conflictingModes
                }
                mode = .version
            case "--preferred-input-device":
                guard preferredInputDevice == nil else {
                    throw CommandLineError.repeatedOption(argument)
                }
                index += 1
                guard index < arguments.count else {
                    throw CommandLineError.missingValue(argument)
                }
                let value = arguments[index]
                guard !value.isEmpty, !value.hasPrefix("--") else {
                    throw CommandLineError.missingValue(argument)
                }
                preferredInputDevice = value
            case "--enforce-preferred-input-device":
                guard !enforcePreferredInputDevice else {
                    throw CommandLineError.repeatedOption(argument)
                }
                enforcePreferredInputDevice = true
            default:
                throw CommandLineError.unknownOption(argument)
            }
            index += 1
        }

        if mode != .capture && (preferredInputDevice != nil || enforcePreferredInputDevice) {
            throw CommandLineError.modeDoesNotAcceptCaptureOptions
        }
        if enforcePreferredInputDevice && preferredInputDevice == nil {
            throw CommandLineError.enforcementRequiresPreferredInputDevice
        }

        return CommandLineOptions(
            mode: mode,
            preferredInputDevice: preferredInputDevice,
            enforcePreferredInputDevice: enforcePreferredInputDevice
        )
    }
}

public enum CommandLineError: Error, LocalizedError, Equatable {
    case unknownOption(String)
    case missingValue(String)
    case repeatedOption(String)
    case conflictingModes
    case modeDoesNotAcceptCaptureOptions
    case enforcementRequiresPreferredInputDevice

    public var errorDescription: String? {
        switch self {
        case .unknownOption(let option):
            return "Unknown option: \(option)."
        case .missingValue(let option):
            return "Missing value for \(option)."
        case .repeatedOption(let option):
            return "Option may only be specified once: \(option)."
        case .conflictingModes:
            return "--self-test and --version cannot be combined."
        case .modeDoesNotAcceptCaptureOptions:
            return "Capture device options cannot be used with --self-test or --version."
        case .enforcementRequiresPreferredInputDevice:
            return "--enforce-preferred-input-device requires --preferred-input-device."
        }
    }
}
