import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

enum ProbeError: Error, CustomStringConvertible {
    case usage(String)
    case failure(String)

    var description: String {
        switch self {
        case .usage(let message), .failure(let message): return message
        }
    }
}

struct Component: Codable {
    let x: Int
    let y: Int
    let width: Int
    let height: Int
    let area: Int
}

struct Analysis: Codable {
    let scale: Double
    let largeComponentCount: Int
    let components: [Component]
}

func writePNG(_ image: CGImage, to path: String) throws {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let destination = CGImageDestinationCreateWithURL(url, UTType.png.identifier as CFString, 1, nil) else {
        throw ProbeError.failure("Unable to create PNG destination")
    }
    CGImageDestinationAddImage(destination, image, nil)
    guard CGImageDestinationFinalize(destination) else {
        throw ProbeError.failure("Unable to write PNG at \(path)")
    }
}

func readPNG(_ path: String) throws -> CGImage {
    let url = URL(fileURLWithPath: path) as CFURL
    guard let source = CGImageSourceCreateWithURL(url, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw ProbeError.failure("Unable to read PNG at \(path)")
    }
    return image
}

func cropMenuBar(_ inputPath: String, to outputPath: String) throws {
    let image = try readPNG(inputPath)
    let logicalWidth = NSScreen.main?.frame.width ?? CGFloat(image.width / 2)
    let scale = Double(image.width) / logicalWidth
    let height = min(image.height, max(1, Int((52.0 * scale).rounded())))
    guard let cropped = image.cropping(to: CGRect(x: 0, y: 0, width: image.width, height: height)) else {
        throw ProbeError.failure("Unable to crop menu bar")
    }
    try writePNG(cropped, to: outputPath)
}

func rgba(_ image: CGImage) throws -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: image.width * image.height * 4)
    guard let context = CGContext(
        data: &bytes,
        width: image.width,
        height: image.height,
        bitsPerComponent: 8,
        bytesPerRow: image.width * 4,
        space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { throw ProbeError.failure("Unable to create image context") }
    context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
    return bytes
}

func analyze(baselinePath: String, currentPath: String, maskPath: String) throws -> Analysis {
    let baseline = try readPNG(baselinePath)
    let current = try readPNG(currentPath)
    guard baseline.width == current.width, baseline.height == current.height else {
        throw ProbeError.failure("Baseline and current screenshots have different dimensions")
    }
    let base = try rgba(baseline)
    let pixels = try rgba(current)
    let width = current.width
    let height = current.height
    var candidate = [Bool](repeating: false, count: width * height)
    for index in 0..<(width * height) {
        let offset = index * 4
        let r = Int(pixels[offset])
        let g = Int(pixels[offset + 1])
        let b = Int(pixels[offset + 2])
        let difference = abs(r - Int(base[offset])) + abs(g - Int(base[offset + 1])) + abs(b - Int(base[offset + 2]))
        candidate[index] = r >= 220 && g >= 90 && g <= 190 && b <= 80 && r >= g + 55 && difference >= 70
    }

    var visited = [Bool](repeating: false, count: candidate.count)
    var components: [Component] = []
    for seed in 0..<candidate.count where candidate[seed] && !visited[seed] {
        var queue = [seed]
        visited[seed] = true
        var cursor = 0
        var minX = seed % width, maxX = minX, minY = seed / width, maxY = minY, area = 0
        while cursor < queue.count {
            let index = queue[cursor]
            cursor += 1
            let x = index % width, y = index / width
            minX = min(minX, x); maxX = max(maxX, x); minY = min(minY, y); maxY = max(maxY, y); area += 1
            for (nx, ny) in [(x - 1, y), (x + 1, y), (x, y - 1), (x, y + 1)] {
                guard nx >= 0, ny >= 0, nx < width, ny < height else { continue }
                let next = ny * width + nx
                if candidate[next] && !visited[next] { visited[next] = true; queue.append(next) }
            }
        }
        if area >= 8 { components.append(Component(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1, area: area)) }
    }

    let logicalWidth = NSScreen.main?.frame.width ?? CGFloat(width / 2)
    let scale = Double(width) / logicalWidth
    let large = components.filter {
        Double($0.width) / scale >= 36 && Double($0.height) / scale >= 20 && Double($0.area) / (scale * scale) >= 500
    }
    var maskBytes = [UInt8](repeating: 0, count: width * height * 4)
    for index in 0..<candidate.count {
        let offset = index * 4
        if candidate[index] { maskBytes[offset] = 255; maskBytes[offset + 1] = 145; maskBytes[offset + 3] = 255 }
        else { maskBytes[offset + 3] = 255 }
    }
    guard let maskContext = CGContext(data: &maskBytes, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue),
          let maskImage = maskContext.makeImage() else { throw ProbeError.failure("Unable to create segmentation mask") }
    try writePNG(maskImage, to: maskPath)
    return Analysis(scale: scale, largeComponentCount: large.count, components: components)
}

func postShortcut(keyCode: CGKeyCode, flags: CGEventFlags) throws {
    guard AXIsProcessTrusted() else { throw ProbeError.failure("Accessibility permission is required") }
    guard let source = CGEventSource(stateID: .hidSystemState),
          let down = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: true),
          let up = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: false) else {
        throw ProbeError.failure("Unable to create keyboard events")
    }
    down.flags = flags; up.flags = flags
    down.post(tap: .cghidEventTap); usleep(60_000); up.post(tap: .cghidEventTap)
}

func recognize(_ path: String) throws -> String {
    let image = try readPNG(path)
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
}

do {
    let arguments = Array(CommandLine.arguments.dropFirst())
    guard let command = arguments.first else { throw ProbeError.usage("missing command") }
    switch command {
    case "preflight":
        guard AXIsProcessTrusted() else { throw ProbeError.failure("Accessibility permission is required") }
        guard CGPreflightScreenCaptureAccess() else { throw ProbeError.failure("Screen Recording permission is required") }
        print("{\"accessibility\":true,\"screenRecording\":true}")
    case "crop-menu":
        guard arguments.count == 3 else { throw ProbeError.usage("crop-menu requires input and output paths") }
        try cropMenuBar(arguments[1], to: arguments[2])
    case "analyze":
        guard arguments.count == 4 else { throw ProbeError.usage("analyze requires baseline current mask") }
        let result = try analyze(baselinePath: arguments[1], currentPath: arguments[2], maskPath: arguments[3])
        let data = try JSONEncoder().encode(result)
        print(String(decoding: data, as: UTF8.self))
    case "dictation-shortcut":
        try postShortcut(keyCode: 47, flags: .maskCommand)
    case "history-shortcut":
        try postShortcut(keyCode: 4, flags: [.maskCommand, .maskControl])
    case "ocr":
        guard arguments.count == 2 else { throw ProbeError.usage("ocr requires an image path") }
        print(try recognize(arguments[1]))
    default:
        throw ProbeError.usage("unknown command \(command)")
    }
} catch {
    fputs("MacAcceptanceProbe: \(error)\n", stderr)
    exit(1)
}
