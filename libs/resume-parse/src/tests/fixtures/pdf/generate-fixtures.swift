// RESUME-A1 v1.1 §6 (D-7) — generator for the committed SYNTHETIC PDF fixtures.
//
// Run on macOS (CoreGraphics + CoreText; no third-party deps):
//   swift libs/resume-parse/src/tests/fixtures/pdf/generate-fixtures.swift libs/resume-parse/src/tests/fixtures/pdf
//
// CoreGraphics is used (not pdf-lib) because pdf-lib output is NOT a valid
// oracle under pdf-parse 1.1.4 / pdf.js v1.10.100 (first parse in a process
// can fail; RESUME-A1 v1.1 §10 item 7). Every fixture is guarded by a 5x
// repeat-parse determinism check in pdf-reading-remediation.spec.ts.
// No real résumé content: all text is synthetic.
import CoreGraphics
import CoreText
import Foundation

let out = CommandLine.arguments[1]

func font(_ name: String, _ size: CGFloat) -> CTFont { CTFontCreateWithName(name as CFString, size, nil) }
func attributed(_ text: String, _ f: CTFont) -> NSAttributedString {
  NSAttributedString(string: text, attributes: [NSAttributedString.Key(kCTFontAttributeName as String): f])
}
func width(_ text: String, _ f: CTFont) -> CGFloat {
  CGFloat(CTLineGetTypographicBounds(CTLineCreateWithAttributedString(attributed(text, f)), nil, nil, nil))
}
func line(_ c: CGContext, _ text: String, _ f: CTFont, _ x: CGFloat, _ y: CGFloat) {
  c.textPosition = CGPoint(x: x, y: y)
  CTLineDraw(CTLineCreateWithAttributedString(attributed(text, f)), c)
}
// Each glyph as its own draw call at its natural advance plus `tracking` points.
func glyphs(_ c: CGContext, _ text: String, _ f: CTFont, _ x0: CGFloat, _ y: CGFloat, tracking: CGFloat) {
  var x = x0
  for ch in text { let s = String(ch); line(c, s, f, x, y); x += width(s, f) + tracking }
}
func document(_ name: String, pages: [(CGContext) -> Void]) {
  var box = CGRect(x: 0, y: 0, width: 612, height: 792)
  let c = CGContext(URL(fileURLWithPath: "\(out)/\(name).pdf") as CFURL, mediaBox: &box, nil)!
  for body in pages { c.beginPDFPage(nil); body(c); c.endPDFPage() }
  c.closePDF()
}

let reg = font("Helvetica", 10), bold = font("Helvetica-Bold", 10), serif = font("Times-Roman", 10)

// ── Positive cases: a separator must be restored ──
document("f01-table-label-value", pages: [{ c in
  var y: CGFloat = 700
  for (label, value) in [("TOOLS", "Jira, Confluence"), ("DATA & INTEGRATION", "Oracle, AWS Glue"), ("CERTIFICATIONS", "AWS Certified")] {
    line(c, label, bold, 72, y); line(c, value, reg, 230, y); y -= 16
  }
}])
document("f02-right-aligned-date", pages: [{ c in
  line(c, "EXAMPLE INFOTECH — SOFTWARE ENGINEER", bold, 72, 700)
  let d = "Mar 2008 – Jun 2011"; line(c, d, reg, 540 - width(d, reg), 700)
  line(c, "Bachelor of Engineering — Example University", reg, 72, 680)
  line(c, "1997", reg, 540 - width("1997", reg), 680)
}])
document("f06-justified-words-no-space-chars", pages: [{ c in
  var x: CGFloat = 72
  for w in ["Led", "data", "modernization", "initiatives"] { line(c, w, reg, x, 700); x += width(w, reg) + 6 }
}])
document("f07-two-column-page", pages: [{ c in
  var y: CGFloat = 700
  for (l, r) in [("Left column line one", "Right column line one"), ("Left column line two", "Right column line two")] {
    line(c, l, reg, 72, y); line(c, r, reg, 330, y); y -= 14
  }
}])

// ── Negative cases: NO separator may be inserted ──
document("f03-per-glyph-identifiers", pages: [{ c in
  var y: CGFloat = 700
  for t in ["Kubernetes", "jane.doe@example.com", "https://git.io/a-b_c?x=1", "v2.10.3", "C#/.NET", "U.S.", "AZ-900", "Node.js"] {
    glyphs(c, t, reg, 72, y, tracking: 0); y -= 16
  }
}])
document("f04-letter-spaced-headings", pages: [{ c in
  glyphs(c, "SUMMARY", bold, 72, 700, tracking: 1.5)
  glyphs(c, "WORK EXPERIENCE", bold, 72, 680, tracking: 2.0)
}])
document("f05-font-change-midword", pages: [{ c in
  line(c, "Java", bold, 72, 700); line(c, "Script", reg, 72 + width("Java", bold), 700)
  line(c, "Senior", bold, 72, 680); line(c, " Engineer", reg, 72 + width("Senior", bold), 680)
  line(c, "(Client: Example)", serif, 72, 660); line(c, "Jan 2021", reg, 72 + width("(Client: Example)", serif) + 0.5, 660)
}])
document("f08-baseline-jitter", pages: [{ c in
  line(c, "Python", reg, 72, 700)
  line(c, "3", font("Helvetica", 6), 72 + width("Python", reg), 704)
  line(c, " developer", reg, 72 + width("Python", reg) + 4, 700)
}])
document("f09-tight-gap-below-threshold", pages: [{ c in
  line(c, "ANALYST", bold, 72, 700); line(c, "(Client: X)", serif, 72 + width("ANALYST", bold) + 2.0, 700)
}])

// ── Page completeness (R2) ──
let threePages: [(CGContext) -> Void] = [1, 2, 3].map { n in { c in line(c, "Synthetic page \(n) body text", reg, 72, 700) } }
document("m01-three-page", pages: threePages)
document("m02-blank-page-2", pages: [threePages[0], { _ in }, threePages[2]])

// Corrupt one page of m01 with LENGTH-PRESERVING reference edits (xref offsets stay
// valid): pdf.js then yields zero text for page 2 WITHOUT throwing.
let m01 = try! String(contentsOfFile: "\(out)/m01-three-page.pdf", encoding: .isoLatin1)
let refs = try! NSRegularExpression(pattern: "/Resources (\\d+) 0 R /Contents (\\d+) 0 R")
let matches = refs.matches(in: m01, range: NSRange(m01.startIndex..., in: m01))
precondition(matches.count == 3, "expected 3 page dicts, got \(matches.count)")
let objCount = try! NSRegularExpression(pattern: "(\\d+) 0 obj").matches(in: m01, range: NSRange(m01.startIndex..., in: m01)).count
func corrupt(_ name: String, page: Int, group: Int) {
  let r = Range(matches[page - 1].range(at: group), in: m01)!
  let original = String(m01[r])
  let dangling = String(repeating: "9", count: original.count)
  precondition(Int(dangling)! > objCount, "dangling ref \(dangling) would hit a real object")
  var edited = m01; edited.replaceSubrange(r, with: dangling)
  try! edited.data(using: .isoLatin1)!.write(to: URL(fileURLWithPath: "\(out)/\(name).pdf"))
}
corrupt("c01-page2-resources-dangling", page: 2, group: 1)
corrupt("c02-page3-contents-dangling", page: 3, group: 2)
print("fixtures written to \(out)")
