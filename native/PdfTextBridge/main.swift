import Darwin
import Foundation
import PDFKit

struct PdfPage: Encodable {
    let page: Int
    let text: String
}

func fail(_ message: String) -> Never {
    fputs("PdfTextBridge: \(message)\n", stderr)
    exit(2)
}

guard CommandLine.arguments.count == 2 else {
    fail("expected exactly one PDF file path")
}

let inputURL = URL(fileURLWithPath: CommandLine.arguments[1])
guard FileManager.default.fileExists(atPath: inputURL.path) else {
    fail("PDF file does not exist")
}
guard let document = PDFDocument(url: inputURL) else {
    fail("PDFKit could not open this PDF")
}

var pages: [PdfPage] = []
for index in 0..<document.pageCount {
    guard let text = document.page(at: index)?.string?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else {
        continue
    }
    pages.append(PdfPage(page: index + 1, text: text))
}

do {
    let output = try JSONEncoder().encode(pages)
    FileHandle.standardOutput.write(output)
} catch {
    fail("could not encode extracted pages: \(error.localizedDescription)")
}
