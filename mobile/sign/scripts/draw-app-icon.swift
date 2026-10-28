// Renders the Aramo mark (BrandMarks.tsx AramoMark geometry, 64-unit viewBox) white on the
// Sign accent (#022AC0). Usage: swift scripts/draw-app-icon.swift out.png size markFraction round(0|1)
// App icons use markFraction 0.62: assets/icon.png + iOS AppIcon (1024, 0), Android
// mipmap ic_launcher (0) / ic_launcher_round (1) resized with sips to 48/72/96/144/192.
import AppKit
let a = CommandLine.arguments
let out = a[1]; let size = CGFloat(Double(a[2])!); let frac = CGFloat(Double(a[3])!); let round = a[4] == "1"
let cs = CGColorSpaceCreateDeviceRGB()
let ctx = CGContext(data: nil, width: Int(size), height: Int(size), bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: round ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue)!
ctx.setFillColor(red: 2/255, green: 42/255, blue: 192/255, alpha: 1) // #022AC0
if round { ctx.addEllipse(in: CGRect(x: 0, y: 0, width: size, height: size)); ctx.fillPath() } else { ctx.fill(CGRect(x: 0, y: 0, width: size, height: size)) }
let k = size * frac / 64; let off = (size - 64 * k) / 2
func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: off + x * k, y: size - (off + y * k)) }
ctx.setLineCap(.round)
ctx.setStrokeColor(red: 1, green: 1, blue: 1, alpha: 1); ctx.setLineWidth(5 * k)
for l: [CGFloat] in [[43,32,56,32],[32,43,32,56],[24.2,39.8,15,49],[21,32,8,32],[24.2,24.2,15,15],[32,21,32,8],[39.8,39.8,49,49]] {
  ctx.move(to: p(l[0], l[1])); ctx.addLine(to: p(l[2], l[3])); ctx.strokePath()
}
ctx.setStrokeColor(red: 0xD9/255, green: 0x77/255, blue: 0x57/255, alpha: 1); ctx.setLineWidth(6 * k)
ctx.move(to: p(39.8, 24.2)); ctx.addLine(to: p(54.5, 9.5)); ctx.strokePath()
ctx.setFillColor(red: 1, green: 1, blue: 1, alpha: 1)
let c = p(32, 32); ctx.addEllipse(in: CGRect(x: c.x - 6 * k, y: c.y - 6 * k, width: 12 * k, height: 12 * k)); ctx.fillPath()
let rep = NSBitmapImageRep(cgImage: ctx.makeImage()!)
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
