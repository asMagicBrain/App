// Reuse the existing .rh-home square "as" mark and Light Default theme colors.
// Generates outlined SVG, PNG iconset and ICNS using local macOS APIs.
import AppKit
import CoreText
import Foundation

let assets = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
let app = assets.deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
let testRoot = app.deletingLastPathComponent().deletingLastPathComponent().appendingPathComponent("asMagicBrain-Test").standardizedFileURL
guard CommandLine.arguments.count == 2 else {fatalError("Supply an output directory under sibling asMagicBrain-Test.")}
let output = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
guard output.path.hasPrefix(testRoot.path + "/") else {fatalError("Generated icon outputs must stay under asMagicBrain-Test.")}
let fm = FileManager.default
try fm.createDirectory(at: output, withIntermediateDirectories: true)
let iconset = output.appendingPathComponent("asMagicBrain.iconset")
try fm.createDirectory(at: iconset, withIntermediateDirectories: true)

// Original CSS: 32px square, 5px radius, 1px border, 16px bold text,
// -0.5px letter spacing. The 896px mark is centered on a 1024px canvas.
let font = NSFont.systemFont(ofSize: 448, weight: .bold)
let text = NSAttributedString(string: "as", attributes: [.font: font, .kern: -14])
let line = CTLineCreateWithAttributedString(text)
let glyphPath = CGMutablePath()
for run in CTLineGetGlyphRuns(line) as! [CTRun] {
    let count = CTRunGetGlyphCount(run)
    var glyphs = [CGGlyph](repeating: 0, count: count)
    var positions = [CGPoint](repeating: .zero, count: count)
    CTRunGetGlyphs(run, CFRange(location: 0, length: 0), &glyphs)
    CTRunGetPositions(run, CFRange(location: 0, length: 0), &positions)
    let runFont = (CTRunGetAttributes(run) as NSDictionary)[kCTFontAttributeName] as! CTFont
    for index in 0..<count {
        if let shape = CTFontCreatePathForGlyph(runFont, glyphs[index], nil) {
            glyphPath.addPath(shape, transform: CGAffineTransform(translationX: positions[index].x, y: positions[index].y))
        }
    }
}
let bounds = glyphPath.boundingBoxOfPath
let offset = CGPoint(x: 512 - bounds.midX, y: 512 - bounds.midY)
let number: (CGFloat) -> String = {String(format: "%.5f", Double($0))}
let point: (CGPoint) -> String = {"\(number($0.x)) \(number($0.y))"}
var commands = [String]()
glyphPath.applyWithBlock {element in
    let value = element.pointee
    switch value.type {
    case .moveToPoint: commands.append("M\(point(value.points[0]))")
    case .addLineToPoint: commands.append("L\(point(value.points[0]))")
    case .addQuadCurveToPoint: commands.append("Q\(point(value.points[0])) \(point(value.points[1]))")
    case .addCurveToPoint: commands.append("C\(point(value.points[0])) \(point(value.points[1])) \(point(value.points[2]))")
    case .closeSubpath: commands.append("Z")
    @unknown default: fatalError("Unknown outline element")
    }
}
let svg = """
<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024" role="img" aria-labelledby="title">
  <title id="title">asMagicBrain square as mark</title>
  <!-- Existing .rh-home proportions, Light Default colors; lettering outlined locally. -->
  <rect x="78" y="78" width="868" height="868" rx="126" fill="#ffffff" stroke="#d0d7de" stroke-width="28"/>
  <path fill="#1f2328" transform="translate(\(number(offset.x)) \(number(1024 - offset.y))) scale(1 -1)" d="\(commands.joined(separator: " "))"/>
</svg>

"""
try svg.write(to: assets.appendingPathComponent("asMagicBrain.svg"), atomically: true, encoding: .utf8)

func writePNG(size: Int, to url: URL) throws {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
        bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.scaleBy(x: CGFloat(size) / 1024, y: CGFloat(size) / 1024)
    let square = CGPath(roundedRect: CGRect(x: 78, y: 78, width: 868, height: 868), cornerWidth: 126, cornerHeight: 126, transform: nil)
    context.addPath(square)
    context.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
    context.setStrokeColor(CGColor(red: 208.0/255, green: 215.0/255, blue: 222.0/255, alpha: 1))
    context.setLineWidth(28)
    context.drawPath(using: .fillStroke)
    context.translateBy(x: offset.x, y: offset.y)
    context.addPath(glyphPath)
    context.setFillColor(CGColor(red: 31.0/255, green: 35.0/255, blue: 40.0/255, alpha: 1))
    context.fillPath()
    let png = NSBitmapImageRep(cgImage: context.makeImage()!).representation(using: .png, properties: [:])!
    try png.write(to: url, options: .atomic)
}

for size in [16, 32, 128, 256, 512] {
    try writePNG(size: size, to: iconset.appendingPathComponent("icon_\(size)x\(size).png"))
    try writePNG(size: size * 2, to: iconset.appendingPathComponent("icon_\(size)x\(size)@2x.png"))
}
try writePNG(size: 1024, to: output.appendingPathComponent("asMagicBrain-1024.png"))

// ICNS entries contain an eight-byte type/length header and representation data.
// Constructing this container avoids relying on iconutil's encoder; validate
// the generated source with iconutil's independent decoder before packaging.
func uint32(_ value: Int) -> Data {
    var bigEndian = UInt32(value).bigEndian
    return withUnsafeBytes(of: &bigEndian) {Data($0)}
}
let entries = [
    ("ic11", "icon_16x16@2x.png"), ("ic12", "icon_32x32@2x.png"),
    ("ic07", "icon_128x128.png"), ("ic13", "icon_128x128@2x.png"),
    ("ic08", "icon_256x256.png"), ("ic14", "icon_256x256@2x.png"),
    ("ic09", "icon_512x512.png"), ("ic10", "icon_512x512@2x.png")
]
var payload = Data()
func appendEntry(_ type: String, _ data: Data) {
    payload.append(Data(type.utf8))
    payload.append(uint32(data.count + 8))
    payload.append(data)
}
// macOS's icon reader uses the classic RGB/mask representations at non-Retina
// 16/32px. Each plane uses literal RLE packets (up to 128 bytes per packet).
for (size, rgbType, alphaType) in [(16, "is32", "s8mk"), (32, "il32", "l8mk")] {
    let bitmap = NSBitmapImageRep(data: try Data(contentsOf: iconset.appendingPathComponent("icon_\(size)x\(size).png")))!
    precondition(!bitmap.isPlanar && bitmap.bitsPerSample == 8 && bitmap.samplesPerPixel == 4 &&
        bitmap.bitmapFormat.contains(.alphaNonpremultiplied) && !bitmap.bitmapFormat.contains(.alphaFirst),
        "Expected decoded RGBA8 PNG pixels")
    let pixels = bitmap.bitmapData!
    var channels = [[UInt8]](repeating: [], count: 4)
    for y in 0..<size {
        for x in 0..<size {
            for index in 0..<4 {
                channels[index].append(pixels[y * bitmap.bytesPerRow + x * 4 + index])
            }
        }
    }
    var rgb = Data()
    for channel in channels.prefix(3) {
        for start in stride(from: 0, to: channel.count, by: 128) {
            let end = min(start + 128, channel.count)
            rgb.append(UInt8(end - start - 1))
            rgb.append(contentsOf: channel[start..<end])
        }
    }
    appendEntry(alphaType, Data(channels[3]))
    appendEntry(rgbType, rgb)
}
for (type, filename) in entries {
    let png = try Data(contentsOf: iconset.appendingPathComponent(filename))
    appendEntry(type, png)
}
var icns = Data("icns".utf8)
icns.append(uint32(payload.count + 8))
icns.append(payload)
let destination = assets.appendingPathComponent("asMagicBrain.icns")
try icns.write(to: destination, options: .atomic)
print("Generated \(assets.appendingPathComponent("asMagicBrain.svg").path), \(destination.path) and \(iconset.path)")
