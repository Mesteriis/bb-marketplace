import { execFile } from "node:child_process";
import { photoTextResult, type PhotoTextResult } from "../../core/contract.ts";

const recognizeText = String.raw`
import Foundation
import ImageIO
import Vision

let data = FileHandle.standardInput.readDataToEndOfFile()
let source = CGImageSourceCreateWithData(data as CFData, nil)
let properties = source.flatMap { CGImageSourceCopyPropertiesAtIndex($0, 0, nil) as? [CFString: Any] }
let orientationValue = (properties?[kCGImagePropertyOrientation] as? NSNumber)?.uint32Value ?? 1
let orientation = CGImagePropertyOrientation(rawValue: orientationValue) ?? .up
let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
if #available(macOS 13.0, *) {
    request.automaticallyDetectsLanguage = true
}
try VNImageRequestHandler(data: data, orientation: orientation).perform([request])
struct Line: Encodable {
    let text: String
    let x, y, width, height: CGFloat
}
let lines: [Line] = (request.results ?? []).prefix(128).compactMap { observation in
    guard let candidate = observation.topCandidates(1).first else { return nil }
    let text = String(candidate.string.prefix(512)).trimmingCharacters(in: .whitespacesAndNewlines)
    let bounds = observation.boundingBox.intersection(CGRect(x: 0, y: 0, width: 1, height: 1))
    guard !text.isEmpty, !bounds.isNull, !bounds.isEmpty else { return nil }
    return Line(text: text, x: bounds.minX, y: 1 - bounds.maxY, width: bounds.width, height: bounds.height)
}
FileHandle.standardOutput.write(try JSONEncoder().encode(lines))
`;

export async function recognizeMacPhotoText(bytes: Buffer): Promise<PhotoTextResult> {
  if (process.platform !== "darwin") throw new Error("Photo text recognition requires macOS.");
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = execFile("/usr/bin/swift", ["-e", recognizeText], {
      encoding: "utf8", timeout: 30_000, maxBuffer: 768 * 1024,
    }, (error, output) => {
      if (error) reject(new Error("macOS Vision could not recognize the photo."));
      else resolve(output);
    });
    child.stdin?.on("error", () => child.kill());
    child.stdin?.end(bytes);
  });
  return photoTextResult.parse({ lines: JSON.parse(stdout) });
}
