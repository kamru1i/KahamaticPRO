import Foundation
import AVFoundation
import Accelerate
import CoreGraphics
import CoreText
import ImageIO

// =========================================================================
// Shared Models
// =========================================================================

struct V1ClipInput: Codable {
    let idx: Int
    let name: String
    let mediaPath: String
    let startSec: Double
    let endSec: Double
    let inSec: Double
    let outSec: Double
}

struct FontListOutput: Codable {
    let fonts: [String]
}

// =========================================================================
// Command 1: list-fonts
// =========================================================================

func cmdListFonts(outPath: String) throws {
    let raw = CTFontManagerCopyAvailablePostScriptNames() as? [String] ?? []
    let sorted = Array(Set(raw)).sorted()
    let data = try JSONEncoder().encode(FontListOutput(fonts: sorted))
    try data.write(to: URL(fileURLWithPath: outPath))
}

// =========================================================================
// Helpers: Audio Extraction along V1 Timeline Ranges
// =========================================================================

let TARGET_SR: Double = 16000.0

func readClipAudioFloat(clip: V1ClipInput) throws -> [Float] {
    let targetSamples = max(1, Int(round((clip.endSec - clip.startSec) * TARGET_SR)))
    guard !clip.mediaPath.isEmpty, FileManager.default.fileExists(atPath: clip.mediaPath) else {
        return [Float](repeating: 0, count: targetSamples)
    }

    let asset = AVURLAsset(url: URL(fileURLWithPath: clip.mediaPath))
    guard let aTrack = asset.tracks(withMediaType: .audio).first else {
        return [Float](repeating: 0, count: targetSamples)
    }

    let reader = try AVAssetReader(asset: asset)
    let srcDur = max(0.05, clip.outSec - clip.inSec)
    reader.timeRange = CMTimeRange(
        start: CMTime(seconds: max(0.0, clip.inSec), preferredTimescale: 600),
        duration: CMTime(seconds: srcDur + 0.05, preferredTimescale: 600)
    )
    let settings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: Int(TARGET_SR),
        AVNumberOfChannelsKey: 1,
        AVLinearPCMBitDepthKey: 32,
        AVLinearPCMIsFloatKey: true,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false
    ]
    let out = AVAssetReaderAudioMixOutput(audioTracks: [aTrack], audioSettings: settings)
    reader.add(out)
    reader.startReading()

    var samples = [Float]()
    samples.reserveCapacity(targetSamples + 4096)

    while let sb = out.copyNextSampleBuffer() {
        if let bb = CMSampleBufferGetDataBuffer(sb) {
            var len = 0
            var ptr: UnsafeMutablePointer<Int8>?
            CMBlockBufferGetDataPointer(bb, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &len, dataPointerOut: &ptr)
            if let p = ptr, len >= 4 {
                let count = len / 4
                p.withMemoryRebound(to: Float.self, capacity: count) { fptr in
                    let buf = UnsafeBufferPointer(start: fptr, count: count)
                    samples.append(contentsOf: buf)
                }
            }
        }
    }
    reader.cancelReading()

    if samples.count > targetSamples {
        return Array(samples.prefix(targetSamples))
    } else if samples.count < targetSamples {
        samples.append(contentsOf: repeatElement(Float(0), count: targetSamples - samples.count))
    }
    return samples
}

func computeRms10ms(samples: [Float]) -> [Float] {
    let win = Int(TARGET_SR * 0.010) // 160 samples = 10ms
    let nWin = samples.count / win
    if nWin == 0 { return [] }
    var out = [Float](repeating: 0, count: nWin)
    samples.withUnsafeBufferPointer { buf in
        guard let base = buf.baseAddress else { return }
        for i in 0..<nWin {
            var rms: Float = 0
            vDSP_rmsqv(base + i * win, 1, &rms, vDSP_Length(win))
            out[i] = rms
        }
    }
    return out
}

func writeAacPack(samples: [Float], outUrl: URL) throws {
    let formatSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatMPEG4AAC,
        AVSampleRateKey: TARGET_SR,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 24000
    ]
    guard let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: TARGET_SR, channels: 1, interleaved: false) else {
        throw NSError(domain: "Kahamatic", code: 1, userInfo: [NSLocalizedDescriptionKey: "Cannot create PCM audio format"])
    }
    let outFile = try AVAudioFile(forWriting: outUrl, settings: formatSettings, commonFormat: .pcmFormatFloat32, interleaved: false)

    let chunkCap = 16384
    var offset = 0
    while offset < samples.count {
        let n = min(chunkCap, samples.count - offset)
        guard let pcmBuf = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: AVAudioFrameCount(n)) else { break }
        pcmBuf.frameLength = AVAudioFrameCount(n)
        if let ch = pcmBuf.floatChannelData?[0] {
            for k in 0..<n {
                ch[k] = samples[offset + k]
            }
        }
        try outFile.write(from: pcmBuf)
        offset += n
    }
}

// =========================================================================
// Command 2: analyze-phase1
// =========================================================================

struct Phase1Input: Codable {
    let clips: [V1ClipInput]
    let fps: Int
    let thresholdDb: Double
    let minPauseSec: Double
    let padSec: Double
    let packAudio: Bool
    let tempDir: String
}

struct MicroValley: Codable {
    let micro_idx: Int
    let src_t: Double
    let tl_t: Double
    let gap_dur: Double
}

struct Phase1SegmentOut: Codable {
    let seg_id: String
    let file_idx: Int
    let src_start: Double
    let src_end: Double
    let tl_start: Double
    let tl_end: Double
    let dur: Double
    let rms: Double
    let peak_rms: Double
    let micros: [MicroValley]
}

struct Phase1SilenceOut: Codable {
    let tl_start_frame: Int
    let tl_end_frame: Int
    let tl_start_sec: Double
    let tl_end_sec: Double
    let dur_sec: Double
}

struct AudioPackOut: Codable {
    let pack_idx: Int
    let m4a_path: String
    let dur_sec: Double
    let segments: [Phase1SegmentOut]
}

struct Phase1Output: Codable {
    let fps: Int
    let sequenceTotalFrames: Int
    let silences: [Phase1SilenceOut]
    let segments: [Phase1SegmentOut]
    let packs: [AudioPackOut]
}

func cmdAnalyzePhase1(inPath: String, outPath: String) throws {
    let inp = try JSONDecoder().decode(Phase1Input.self, from: Data(contentsOf: URL(fileURLWithPath: inPath)))
    let fps = max(1, inp.fps)
    let onLin = Float(pow(10.0, inp.thresholdDb / 20.0))
    let lowLin = onLin * 0.35
    let winMidLin = onLin * 0.68
    let padFrames = max(1, Int(round(inp.padSec * Double(fps))))
    let minGapSec = max(0.18, inp.minPauseSec)
    let minSegDur = 0.18

    var allSilences: [Phase1SilenceOut] = []
    var allSegments: [Phase1SegmentOut] = []
    var packAudioBuffers: [[Float]] = []
    var packSegLists: [[Phase1SegmentOut]] = []

    var curPackPCM = [Float]()
    var curPackSegs = [Phase1SegmentOut]()
    let sepSamplesCount = Int(0.30 * TARGET_SR)
    let beepSamplesCount = Int(0.04 * TARGET_SR)
    var sepAudio = [Float](repeating: 0, count: sepSamplesCount)
    let padSil = (sepSamplesCount - beepSamplesCount) / 2
    for k in 0..<beepSamplesCount {
        sepAudio[padSil + k] = Float(0.22 * sin(2.0 * Double.pi * 880.0 * Double(k) / TARGET_SR))
    }

    var totalEndSec = 0.0

    for (cIdx, clip) in inp.clips.enumerated() {
        totalEndSec = max(totalEndSec, clip.endSec)
        let samples = try readClipAudioFloat(clip: clip)
        let rms10 = computeRms10ms(samples: samples)
        let n = rms10.count
        if n < 3 { continue }

        var visited = rms10.map { $0 >= onLin }
        for i in 1..<n {
            if !visited[i] && visited[i - 1] && rms10[i] >= lowLin { visited[i] = true }
        }
        for i in stride(from: n - 2, through: 0, by: -1) {
            if !visited[i] && visited[i + 1] && rms10[i] >= lowLin { visited[i] = true }
        }
        for i in 1..<(n - 1) {
            if rms10[i - 1] >= winMidLin && rms10[i] >= winMidLin && rms10[i + 1] >= winMidLin {
                visited[i] = true
            }
        }

        var rawVoiced: [(Double, Double)] = []
        var inV = false
        var vs = 0
        for i in 0..<n {
            if visited[i] && !inV { inV = true; vs = i }
            else if !visited[i] && inV {
                inV = false
                rawVoiced.append((Double(vs) * 0.01, Double(i) * 0.01))
            }
        }
        if inV { rawVoiced.append((Double(vs) * 0.01, Double(n) * 0.01)) }

        var merged: [(Double, Double)] = []
        for (s, e) in rawVoiced {
            if merged.isEmpty || (s - merged[merged.count - 1].1) >= minGapSec {
                merged.append((s, e))
            } else {
                merged[merged.count - 1].1 = e
            }
        }

        let clipStartFrame = Int(round(clip.startSec * Double(fps)))
        let clipEndFrame = Int(round(clip.endSec * Double(fps)))
        let clipDur = clip.endSec - clip.startSec

        var clipSegs: [Phase1SegmentOut] = []
        var segCounter = 0
        for (s, e) in merged {
            let dur = e - s
            let i0 = max(0, Int(round(s * 100.0)))
            let i1 = min(n, Int(round(e * 100.0)))
            var sqSum: Float = 0
            var peak: Float = 0
            if i1 > i0 {
                for k in i0..<i1 {
                    sqSum += rms10[k] * rms10[k]
                    if rms10[k] > peak { peak = rms10[k] }
                }
            }
            let segRms = i1 > i0 ? sqrt(Double(sqSum) / Double(i1 - i0)) : 0.0
            if dur < minSegDur && Double(peak) < Double(onLin) * 1.8 { continue }

            var micros: [MicroValley] = []
            var inM = false
            var ms = 0
            if i1 > i0 + 10 {
                for k in i0..<i1 {
                    if rms10[k] < winMidLin * 1.15 {
                        if !inM { inM = true; ms = k }
                    } else if inM {
                        let md = Double(k - ms) * 0.01
                        if md >= 0.14 && ms > i0 + 5 && k < i1 - 5 {
                            var minIdx = ms
                            for z in ms..<k {
                                if rms10[z] < rms10[minIdx] { minIdx = z }
                            }
                            micros.append(MicroValley(
                                micro_idx: micros.count,
                                src_t: (Double(minIdx) * 10.0).rounded() / 1000.0,
                                tl_t: ((clip.startSec + Double(minIdx) * 0.01) * 1000.0).rounded() / 1000.0,
                                gap_dur: (md * 100.0).rounded() / 100.0
                            ))
                        }
                        inM = false
                    }
                }
            }

            segCounter += 1
            let sid = String(format: "C%02d_S%03d", cIdx + 1, segCounter)
            let segOut = Phase1SegmentOut(
                seg_id: sid,
                file_idx: cIdx,
                src_start: s,
                src_end: e,
                tl_start: clip.startSec + s,
                tl_end: clip.startSec + e,
                dur: dur,
                rms: segRms,
                peak_rms: Double(peak),
                micros: micros
            )
            clipSegs.append(segOut)
            allSegments.append(segOut)

            if inp.packAudio {
                let s0 = max(0, min(samples.count, Int(s * TARGET_SR)))
                let s1 = max(s0, min(samples.count, Int(e * TARGET_SR)))
                let sliceDur = Double(s1 - s0) / TARGET_SR
                let curDur = Double(curPackPCM.count) / TARGET_SR
                if !curPackSegs.isEmpty && curDur + sliceDur > 105.0 {
                    packAudioBuffers.append(curPackPCM)
                    packSegLists.append(curPackSegs)
                    curPackPCM = [Float]()
                    curPackSegs = [Phase1SegmentOut]()
                }
                if !curPackSegs.isEmpty {
                    curPackPCM.append(contentsOf: sepAudio)
                }
                if s1 > s0 {
                    curPackPCM.append(contentsOf: samples[s0..<s1])
                }
                curPackSegs.append(segOut)
            }
        }

        // Convert gaps >= minGapSec into padded frame-aligned Silences inside [clipStartFrame, clipEndFrame]
        var cur = 0.0
        for seg in clipSegs {
            if seg.src_start - cur >= minGapSec {
                let sf = clipStartFrame + Int(round(cur * Double(fps))) + (cur > 0 ? padFrames : 0)
                let ef = clipStartFrame + Int(round(seg.src_start * Double(fps))) - padFrames
                if ef > sf + 2 {
                    allSilences.append(Phase1SilenceOut(
                        tl_start_frame: sf,
                        tl_end_frame: ef,
                        tl_start_sec: Double(sf) / Double(fps),
                        tl_end_sec: Double(ef) / Double(fps),
                        dur_sec: Double(ef - sf) / Double(fps)
                    ))
                }
            }
            cur = seg.src_end
        }
        if clipDur - cur >= minGapSec {
            let sf = clipStartFrame + Int(round(cur * Double(fps))) + (cur > 0 ? padFrames : 0)
            let ef = clipEndFrame - 1
            if ef > sf + 2 {
                allSilences.append(Phase1SilenceOut(
                    tl_start_frame: sf,
                    tl_end_frame: ef,
                    tl_start_sec: Double(sf) / Double(fps),
                    tl_end_sec: Double(ef) / Double(fps),
                    dur_sec: Double(ef - sf) / Double(fps)
                ))
            }
        }
    }

    if !curPackSegs.isEmpty {
        packAudioBuffers.append(curPackPCM)
        packSegLists.append(curPackSegs)
    }

    var packsOut: [AudioPackOut] = []
    if inp.packAudio {
        let dirUrl = URL(fileURLWithPath: inp.tempDir, isDirectory: true)
        try FileManager.default.createDirectory(at: dirUrl, withIntermediateDirectories: true)
        for pIdx in 0..<packAudioBuffers.count {
            let m4aUrl = dirUrl.appendingPathComponent(String(format: "pack_%02d.m4a", pIdx + 1))
            try writeAacPack(samples: packAudioBuffers[pIdx], outUrl: m4aUrl)
            packsOut.append(AudioPackOut(
                pack_idx: pIdx + 1,
                m4a_path: m4aUrl.path,
                dur_sec: Double(packAudioBuffers[pIdx].count) / TARGET_SR,
                segments: packSegLists[pIdx]
            ))
        }
    }

    let seqTotalFrames = Int(round(totalEndSec * Double(fps)))
    let outObj = Phase1Output(
        fps: fps,
        sequenceTotalFrames: seqTotalFrames,
        silences: allSilences,
        segments: allSegments,
        packs: packsOut
    )
    let encoded = try JSONEncoder().encode(outObj)
    try encoded.write(to: URL(fileURLWithPath: outPath))
}

// =========================================================================
// Command 3: align-io-words
// =========================================================================

struct AlignIoInput: Codable {
    let clips: [V1ClipInput]
    let inSec: Double
    let outSec: Double
    let fps: Int
    let words: [String]
    let style: String
    let fontPostScript: String
    let fontSize: Double
    let colorHex: String
    let positionMode: String
    let lineGap: Double
    let wordSpacingPx: Double
    let frameWidth: Int
    let frameHeight: Int
    let framePngPath: String?
}

struct AlignedWordOut: Codable {
    let word: String
    let startSec: Double
    let endSec: Double
    let posX: Double
    let posY: Double
    let fontSize: Double?
    let colorHex: String?
    let widthPx: Double
    let heightPx: Double
}

struct AlignIoOutput: Codable {
    let words: [AlignedWordOut]
    let usedPosMode: String
}

func measureWordCoreText(word: String, fontPostScript: String, fontSize: Double) -> (adv: Double, w: Double, h: Double) {
    let font = CTFontCreateWithName(fontPostScript as CFString, CGFloat(fontSize), nil)
    let attrs: [NSAttributedString.Key: Any] = [NSAttributedString.Key(kCTFontAttributeName as String): font]
    let astr = NSAttributedString(string: word, attributes: attrs)
    let line = CTLineCreateWithAttributedString(astr)
    var ascent: CGFloat = 0
    var descent: CGFloat = 0
    var leading: CGFloat = 0
    let adv = Double(CTLineGetTypographicBounds(line, &ascent, &descent, &leading))
    let rect = CTLineGetImageBounds(line, nil)
    let w = max(adv, Double(rect.width))
    let h = max(Double(rect.height), Double(ascent + descent) * 0.85)
    return (adv, w, h)
}

func readAudioWindowSamples(clips: [V1ClipInput], winStartSec: Double, winEndSec: Double) -> [Float] {
    let totalSamples = max(1, Int(round((winEndSec - winStartSec) * TARGET_SR)))
    var outBuf = [Float](repeating: 0, count: totalSamples)
    for clip in clips {
        let ovStart = max(winStartSec, clip.startSec)
        let ovEnd = min(winEndSec, clip.endSec)
        if ovEnd <= ovStart { continue }
        let subClip = V1ClipInput(
            idx: clip.idx,
            name: clip.name,
            mediaPath: clip.mediaPath,
            startSec: ovStart,
            endSec: ovEnd,
            inSec: clip.inSec + (ovStart - clip.startSec),
            outSec: clip.inSec + (ovEnd - clip.startSec)
        )
        if let seg = try? readClipAudioFloat(clip: subClip) {
            let dstOff = max(0, Int(round((ovStart - winStartSec) * TARGET_SR)))
            let n = min(seg.count, totalSamples - dstOff)
            if n > 0 {
                for k in 0..<n { outBuf[dstOff + k] = seg[k] }
            }
        }
    }
    return outBuf
}

func detectWordOnsetSeconds(samples: [Float], winStart: Double, winEnd: Double, words: [String], fps: Int) -> [Double] {
    let n = words.count
    let dur = max(0.25, winEnd - winStart)
    let rms10 = computeRms10ms(samples: samples)
    let chars = words.map { max(2.0, Double($0.count)) }
    let totalChars = chars.reduce(0.0, +)

    // Estimate cumulative voiced mass inside window so word spacing follows speech rhythm naturally
    var cumulativeVoiced = [Double](repeating: 0.0, count: rms10.count + 1)
    let floorRms: Float = 0.0025
    for i in 0..<rms10.count {
        let energy = Double(max(0.0, rms10[i] - floorRms))
        let w = 0.15 + min(1.0, energy * 28.0)
        cumulativeVoiced[i + 1] = cumulativeVoiced[i] + w
    }
    let totalMass = max(1e-6, cumulativeVoiced.last ?? 1.0)

    var onsets: [Double] = [Double(Int(round(winStart * Double(fps)))) / Double(fps)]
    if n == 1 { return onsets }

    var charAcc = chars[0]
    let minStep = max(2.0 / Double(fps), 0.10)

    for idx in 1..<n {
        let targetFrac = charAcc / totalChars
        let targetMass = targetFrac * totalMass
        var chosenSec = winStart + dur * targetFrac

        if rms10.count >= 5 {
            var bestWinIdx = 0
            for k in 0..<cumulativeVoiced.count {
                if cumulativeVoiced[k] >= targetMass {
                    bestWinIdx = k
                    break
                }
            }
            // Refine around +-150ms for local acoustic onset jump
            let lo = max(1, bestWinIdx - 15)
            let hi = min(rms10.count - 2, bestWinIdx + 15)
            var bestScore = -1.0
            var bestK = bestWinIdx
            for k in lo...hi {
                let jump = Double(rms10[k] - rms10[k - 1])
                if jump > bestScore && rms10[k] > 0.005 {
                    bestScore = jump
                    bestK = k
                }
            }
            chosenSec = winStart + Double(bestK) * 0.01
        }

        let prev = onsets[onsets.count - 1]
        let remainingWords = Double(n - idx)
        let maxAllowed = winEnd - remainingWords * minStep
        let clamped = max(prev + minStep, min(maxAllowed, chosenSec))
        let snapped = Double(Int(round(clamped * Double(fps)))) / Double(fps)
        onsets.append(max(prev + (1.0 / Double(fps)), min(winEnd - 0.06, snapped)))
        charAcc += chars[idx]
    }
    return onsets
}

func computePngBusyGrid(pngPath: String, gw: Int = 192, gh: Int = 108) -> [Float]? {
    let url = URL(fileURLWithPath: pngPath)
    guard let src = CGImageSourceCreateWithURL(url as CFURL, nil),
          let cgImg = CGImageSourceCreateImageAtIndex(src, 0, nil) else {
        return nil
    }
    var buf = [UInt8](repeating: 0, count: gw * gh * 4)
    let cs = CGColorSpaceCreateDeviceRGB()
    let ok = buf.withUnsafeMutableBytes { ptr -> Bool in
        guard let ctx = CGContext(
            data: ptr.baseAddress,
            width: gw,
            height: gh,
            bitsPerComponent: 8,
            bytesPerRow: gw * 4,
            space: cs,
            bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return false }
        ctx.interpolationQuality = .low
        ctx.draw(cgImg, in: CGRect(x: 0, y: 0, width: gw, height: gh))
        return true
    }
    if !ok { return nil }

    // Detect background brightness at top center margin to handle light & dark slides uniformly
    var lumSamples = [Double]()
    for y in 0..<gh {
        for x in 0..<gw {
            let off = (y * gw + x) * 4
            let lum = 0.299 * Double(buf[off]) + 0.587 * Double(buf[off + 1]) + 0.114 * Double(buf[off + 2])
            lumSamples.append(lum)
        }
    }
    let sortedLum = lumSamples.sorted()
    let bgLum = sortedLum[sortedLum.count / 2]
    let darkSlide = bgLum < 100.0

    var busy = [Float](repeating: 0, count: gw * gh)
    for idx in 0..<(gw * gh) {
        let off = idx * 4
        let r = Double(buf[off])
        let g = Double(buf[off + 1])
        let b = Double(buf[off + 2])
        let lum = 0.299 * r + 0.587 * g + 0.114 * b
        let sat = max(r, max(g, b)) - min(r, min(g, b))
        if darkSlide {
            busy[idx] = (abs(lum - bgLum) > 28.0 || sat > 36.0) ? 1.0 : 0.0
        } else {
            busy[idx] = (lum < 200.0 || sat > 24.0) ? 1.0 : 0.0
        }
    }
    return busy
}

func boxBusyFraction(busy: [Float], gw: Int, gh: Int, x0: Double, y0: Double, x1: Double, y1: Double) -> Double {
    let ix0 = max(0, min(gw - 1, Int(floor(x0 * Double(gw)))))
    let iy0 = max(0, min(gh - 1, Int(floor(y0 * Double(gh)))))
    let ix1 = max(ix0 + 1, min(gw, Int(ceil(x1 * Double(gw)))))
    let iy1 = max(iy0 + 1, min(gh, Int(ceil(y1 * Double(gh)))))
    var hits: Float = 0
    for y in iy0..<iy1 {
        for x in ix0..<ix1 {
            hits += busy[y * gw + x]
        }
    }
    return Double(hits) / Double((ix1 - ix0) * (iy1 - iy0))
}

func gridTargetNorm(mode: String) -> (x: Double, y: Double, anchorMode: String) {
    switch mode {
    case "TL": return (0.20, 0.16, "left")
    case "TC": return (0.50, 0.16, "center")
    case "TR": return (0.80, 0.16, "right")
    case "ML": return (0.20, 0.50, "left")
    case "MC": return (0.50, 0.50, "center")
    case "MR": return (0.80, 0.50, "right")
    case "BL": return (0.20, 0.84, "left")
    case "BR": return (0.80, 0.84, "right")
    default: return (0.50, 0.84, "center")
    }
}

func cmdAlignIoWords(inPath: String, outPath: String) throws {
    let inp = try JSONDecoder().decode(AlignIoInput.self, from: Data(contentsOf: URL(fileURLWithPath: inPath)))
    let fw = Double(max(320, inp.frameWidth))
    let fh = Double(max(320, inp.frameHeight))
    let isVertical = fh > fw
    let words = inp.words
    let n = words.count

    let audioSamples = readAudioWindowSamples(clips: inp.clips, winStartSec: inp.inSec, winEndSec: inp.outSec)
    let onsets = detectWordOnsetSeconds(samples: audioSamples, winStart: inp.inSec, winEnd: inp.outSec, words: words, fps: max(1, inp.fps))
    let phraseEndSec = Double(Int(round(inp.outSec * Double(max(1, inp.fps))))) / Double(max(1, inp.fps))

    var outWords: [AlignedWordOut] = []
    var usedMode = inp.positionMode

    if inp.style == "kinetic-stack" {
        // Group words dynamically into 1..3 impact lines; last word gets 1.18x accent
        let targetNorm = inp.positionMode == "auto" ? (x: 0.5, y: isVertical ? 0.72 : 0.78, anchorMode: "center") : gridTargetNorm(mode: inp.positionMode)
        var lines: [[Int]] = []
        if n <= 2 {
            lines = [Array(0..<n)]
        } else if n <= 4 {
            let split = n / 2
            lines = [Array(0..<split), Array(split..<n)]
        } else {
            let s1 = max(1, n / 3)
            let s2 = max(s1 + 1, (2 * n) / 3)
            lines = [Array(0..<s1), Array(s1..<s2), Array(s2..<n)]
        }

        let metrics = (0..<n).map { i -> (adv: Double, w: Double, h: Double, fs: Double, col: String?) in
            let isAccent = i == n - 1
            let fs = isAccent ? round(inp.fontSize * 1.18) : inp.fontSize
            let m = measureWordCoreText(word: words[i], fontPostScript: inp.fontPostScript, fontSize: fs)
            return (m.adv, m.w, m.h, fs, isAccent ? "#FFFFFF" : nil)
        }

        let lineHeightNorm = (inp.fontSize * inp.lineGap) / fh
        let totalBlockH = Double(lines.count) * lineHeightNorm
        let startY = max(0.14, min(0.88 - totalBlockH, targetNorm.y - totalBlockH * 0.35))

        var placements = [(posX: Double, posY: Double, fs: Double, col: String?, w: Double, h: Double)](
            repeating: (0.5, 0.5, inp.fontSize, nil, 0, 0), count: n
        )

        for (lIdx, lineIdxs) in lines.enumerated() {
            let totalLineW = lineIdxs.reduce(0.0) { $0 + metrics[$1].adv } + Double(max(0, lineIdxs.count - 1)) * inp.wordSpacingPx
            let lineCenterX = max(0.08 + totalLineW / (2.0 * fw), min(0.92 - totalLineW / (2.0 * fw), targetNorm.x))
            var curX = lineCenterX * fw - totalLineW / 2.0
            let ly = startY + Double(lIdx) * lineHeightNorm
            for wi in lineIdxs {
                let m = metrics[wi]
                placements[wi] = ((curX + m.adv / 2.0) / fw, ly, m.fs, m.col, m.w, m.h)
                curX += m.adv + inp.wordSpacingPx
            }
        }

        for i in 0..<n {
            let p = placements[i]
            outWords.append(AlignedWordOut(
                word: words[i],
                startSec: onsets[i],
                endSec: phraseEndSec,
                posX: p.posX,
                posY: p.posY,
                fontSize: p.fs,
                colorHex: p.col,
                widthPx: p.w,
                heightPx: p.h
            ))
        }
    } else {
        // Horizontal line layout with auto slide collision search or exact grid anchor
        let metrics = words.map { measureWordCoreText(word: $0, fontPostScript: inp.fontPostScript, fontSize: inp.fontSize) }
        let totalW = metrics.reduce(0.0) { $0 + $1.adv } + Double(max(0, n - 1)) * inp.wordSpacingPx
        let normW = totalW / fw
        let normH = (metrics.map { $0.h }.max() ?? inp.fontSize) / fh

        var bestCenterX = 0.5
        var bestCenterY = isVertical ? 0.78 : 0.84

        if inp.positionMode == "auto", let png = inp.framePngPath, let busy = computePngBusyGrid(pngPath: png) {
            usedMode = "auto-scan"
            let yCandidates = isVertical
                ? [0.76, 0.82, 0.22, 0.16, 0.50, 0.68, 0.30]
                : [0.85, 0.78, 0.90, 0.15, 0.22, 0.54, 0.68, 0.42]
            let halfW = normW / 2.0 + 0.015
            let minX = max(0.06 + halfW, 0.06)
            let maxX = min(0.94 - halfW, 0.94)
            var xCandidates: [Double] = [0.5]
            if maxX > minX {
                for step in 0...10 {
                    xCandidates.append(minX + (maxX - minX) * (Double(step) / 10.0))
                }
            }
            var bestCost = Double.infinity
            for yc in yCandidates {
                for xc in xCandidates {
                    let bx0 = max(0.02, xc - normW / 2.0 - 0.01)
                    let bx1 = min(0.98, xc + normW / 2.0 + 0.01)
                    let by0 = max(0.02, yc - normH * 0.75)
                    let by1 = min(0.98, yc + normH * 0.45)
                    let busyFrac = boxBusyFraction(busy: busy, gw: 192, gh: 108, x0: bx0, y0: by0, x1: bx1, y1: by1)
                    let centerBias = abs(xc - 0.5) * 0.04 + (yc < 0.3 ? 0.01 : 0.0)
                    let cost = busyFrac * 10.0 + centerBias
                    if cost < bestCost {
                        bestCost = cost
                        bestCenterX = xc
                        bestCenterY = yc
                    }
                }
            }
        } else if inp.positionMode != "auto" {
            let g = gridTargetNorm(mode: inp.positionMode)
            let halfW = normW / 2.0
            if g.anchorMode == "left" {
                bestCenterX = max(0.06 + halfW, g.x + halfW - 0.12)
            } else if g.anchorMode == "right" {
                bestCenterX = min(0.94 - halfW, g.x - halfW + 0.12)
            } else {
                bestCenterX = g.x
            }
            bestCenterX = max(0.05 + halfW, min(0.95 - halfW, bestCenterX))
            bestCenterY = g.y
        }

        var curX = bestCenterX * fw - totalW / 2.0
        for i in 0..<n {
            let m = metrics[i]
            let cx = (curX + m.adv / 2.0) / fw
            outWords.append(AlignedWordOut(
                word: words[i],
                startSec: onsets[i],
                endSec: phraseEndSec,
                posX: cx,
                posY: bestCenterY,
                fontSize: nil,
                colorHex: nil,
                widthPx: m.w,
                heightPx: m.h
            ))
            curX += m.adv + inp.wordSpacingPx
        }
    }

    let encoded = try JSONEncoder().encode(AlignIoOutput(words: outWords, usedPosMode: usedMode))
    try encoded.write(to: URL(fileURLWithPath: outPath))
}

// =========================================================================
// Command 4: track-red-pen (Auto Camera Zoom & Pan)
// =========================================================================

struct TrackCameraInput: Codable {
    let clips: [V1ClipInput]
    let fps: Int
    let zoomScalePct: Double
    let transitionSec: Double
    let trackMode: String
}

struct CameraSegOut: Codable {
    let tlFrame: Int
    let useClipBase: Bool
    let scale: Double?
    let posX: Double?
    let posY: Double?
}

struct CameraMoveOut: Codable {
    let clipIdx: Int
    let segments: [CameraSegOut]
}

struct TrackCameraOutput: Codable {
    let moves: [CameraMoveOut]
}

func cmdTrackRedPen(inPath: String, outPath: String) throws {
    let inp = try JSONDecoder().decode(TrackCameraInput.self, from: Data(contentsOf: URL(fileURLWithPath: inPath)))
    let fps = max(1, inp.fps)
    let rampFrames = max(5, Int(round(inp.transitionSec * Double(fps))))
    let scaleFactor = inp.zoomScalePct / 100.0
    let W = 240
    let H = 135
    let cs = CGColorSpaceCreateDeviceRGB()
    var moves: [CameraMoveOut] = []

    for clip in inp.clips {
        let clipDur = clip.endSec - clip.startSec
        if clipDur < max(1.6, inp.transitionSec * 2.5) { continue }
        guard !clip.mediaPath.isEmpty, FileManager.default.fileExists(atPath: clip.mediaPath) else { continue }
        let asset = AVURLAsset(url: URL(fileURLWithPath: clip.mediaPath))
        guard let vTrack = asset.tracks(withMediaType: .video).first else { continue }

        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: max(0.0, clip.inSec), preferredTimescale: 600),
            duration: CMTime(seconds: clipDur + 0.05, preferredTimescale: 600)
        )
        let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        vOut.alwaysCopiesSampleData = false
        reader.add(vOut)
        reader.startReading()

        var prevMask = [Bool](repeating: false, count: W * H)
        var prevLum = [Int](repeating: 0, count: W * H)
        var hasPrev = false
        var nextT = 0.0
        var rgba = [UInt8](repeating: 0, count: W * H * 4)

        struct ActiveSample { let tlSec: Double; let cx: Double; let cy: Double; let count: Int }
        var samples: [ActiveSample] = []

        while let sb = vOut.copyNextSampleBuffer() {
            let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
            if pts >= clip.outSec - 0.01 { break }
            if pts + 0.02 < clip.inSec + nextT { continue }
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }

            autoreleasepool {
                CVPixelBufferLockBaseAddress(pb, .readOnly)
                defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
                let pw = CVPixelBufferGetWidth(pb)
                let ph = CVPixelBufferGetHeight(pb)
                let bpr = CVPixelBufferGetBytesPerRow(pb)
                guard let base = CVPixelBufferGetBaseAddress(pb),
                      let srcCtx = CGContext(
                          data: base, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: bpr, space: cs,
                          bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
                      ),
                      let fullImg = srcCtx.makeImage() else { return }

                rgba.withUnsafeMutableBytes { ptr in
                    if let dst = CGContext(
                        data: ptr.baseAddress, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs,
                        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
                    ) {
                        dst.interpolationQuality = .low
                        dst.draw(fullImg, in: CGRect(x: 0, y: 0, width: W, height: H))
                    }
                }

                var sumX = 0.0
                var sumY = 0.0
                var newHits = 0
                for y in 0..<H {
                    for x in 0..<W {
                        let idx = y * W + x
                        let off = idx * 4
                        let r = Int(rgba[off])
                        let g = Int(rgba[off + 1])
                        let b = Int(rgba[off + 2])
                        let lum = (r * 30 + g * 59 + b * 11) / 100
                        let isRedPen = r > 150 && (r - g) > 55 && (r - b) > 55
                        if inp.trackMode == "red-pen" {
                            if hasPrev && isRedPen && !prevMask[idx] {
                                sumX += (Double(x) + 0.5) / Double(W)
                                sumY += (Double(y) + 0.5) / Double(H)
                                newHits += 1
                            }
                            prevMask[idx] = isRedPen
                        } else {
                            if hasPrev && abs(lum - prevLum[idx]) > 22 {
                                sumX += (Double(x) + 0.5) / Double(W)
                                sumY += (Double(y) + 0.5) / Double(H)
                                newHits += 1
                            }
                            prevLum[idx] = lum
                        }
                    }
                }
                hasPrev = true
                if newHits >= 6 && newHits < (W * H) / 4 {
                    samples.append(ActiveSample(
                        tlSec: clip.startSec + nextT,
                        cx: sumX / Double(newHits),
                        cy: sumY / Double(newHits),
                        count: newHits
                    ))
                }
            }
            nextT += 0.25
        }
        reader.cancelReading()

        guard let first = samples.first, let last = samples.last else { continue }
        let csF = Int(round(clip.startSec * Double(fps)))
        let ceF = Int(round(clip.endSec * Double(fps)))
        let leadIn = max(csF + 2, Int(round((first.tlSec - 0.18) * Double(fps))))
        let leadOut = min(ceF - 2, Int(round((last.tlSec + 0.85) * Double(fps))))
        if leadOut - leadIn < rampFrames + 4 { continue }

        let targetPx = 0.5 + (0.5 - first.cx) * scaleFactor
        let targetPy = 0.5 + (0.5 - first.cy) * scaleFactor

        var segs: [CameraSegOut] = [
            CameraSegOut(tlFrame: csF, useClipBase: true, scale: nil, posX: nil, posY: nil),
            CameraSegOut(tlFrame: leadIn - rampFrames > csF ? leadIn - rampFrames : csF + 1, useClipBase: true, scale: nil, posX: nil, posY: nil),
            CameraSegOut(tlFrame: leadIn, useClipBase: false, scale: inp.zoomScalePct, posX: targetPx, posY: targetPy)
        ]

        // Optional mid-clip pan if focus shifted significantly (> 0.18 normalized)
        let mid = samples[samples.count / 2]
        if hypot(mid.cx - first.cx, mid.cy - first.cy) > 0.18 {
            let panStart = Int(round((mid.tlSec - 0.25) * Double(fps)))
            let panEnd = panStart + max(8, rampFrames - 2)
            if panStart > leadIn + 8 && panEnd < leadOut - rampFrames {
                let ppx = 0.5 + (0.5 - mid.cx) * scaleFactor
                let ppy = 0.5 + (0.5 - mid.cy) * scaleFactor
                segs.append(CameraSegOut(tlFrame: panStart, useClipBase: false, scale: inp.zoomScalePct, posX: targetPx, posY: targetPy))
                segs.append(CameraSegOut(tlFrame: panEnd, useClipBase: false, scale: inp.zoomScalePct, posX: ppx, posY: ppy))
                segs.append(CameraSegOut(tlFrame: max(panEnd + 4, leadOut - rampFrames), useClipBase: false, scale: inp.zoomScalePct, posX: ppx, posY: ppy))
            } else {
                segs.append(CameraSegOut(tlFrame: max(leadIn + 2, leadOut - rampFrames), useClipBase: false, scale: inp.zoomScalePct, posX: targetPx, posY: targetPy))
            }
        } else {
            segs.append(CameraSegOut(tlFrame: max(leadIn + 2, leadOut - rampFrames), useClipBase: false, scale: inp.zoomScalePct, posX: targetPx, posY: targetPy))
        }

        segs.append(CameraSegOut(tlFrame: leadOut, useClipBase: true, scale: nil, posX: nil, posY: nil))
        segs.append(CameraSegOut(tlFrame: ceF, useClipBase: true, scale: nil, posX: nil, posY: nil))
        moves.append(CameraMoveOut(clipIdx: clip.idx, segments: segs))
    }

    let encoded = try JSONEncoder().encode(TrackCameraOutput(moves: moves))
    try encoded.write(to: URL(fileURLWithPath: outPath))
}

// =========================================================================
// Command 5: scan-badge-corners
// =========================================================================

struct ScanBadgeInput: Codable {
    let clips: [V1ClipInput]
    let fps: Int
    let scalePct: Double
    let marginNorm: Double
}

struct CornerSampleOut: Codable {
    let sec: Double
    let scores: [String: Double]
}

struct ScanBadgeOutput: Codable {
    let samples: [CornerSampleOut]
}

func cmdScanBadgeCorners(inPath: String, outPath: String) throws {
    let inp = try JSONDecoder().decode(ScanBadgeInput.self, from: Data(contentsOf: URL(fileURLWithPath: inPath)))
    let W = 192
    let H = 108
    let cs = CGColorSpaceCreateDeviceRGB()
    var rgba = [UInt8](repeating: 0, count: W * H * 4)
    var samples: [CornerSampleOut] = []

    let bw = max(0.14, min(0.35, (inp.scalePct / 100.0) * 1.3))
    let bh = max(0.06, min(0.18, (inp.scalePct / 100.0) * 0.35))
    let m = inp.marginNorm
    let boxes: [(String, Double, Double, Double, Double)] = [
        ("BR", 1.0 - m - bw, 1.0 - m - bh, 1.0 - m, 1.0 - m),
        ("TL", m, m, m + bw, m + bh),
        ("TR", 1.0 - m - bw, m, 1.0 - m, m + bh),
        ("BL", m, 1.0 - m - bh, m + bw, 1.0 - m)
    ]

    for clip in inp.clips {
        let clipDur = clip.endSec - clip.startSec
        guard clipDur > 0.1, !clip.mediaPath.isEmpty, FileManager.default.fileExists(atPath: clip.mediaPath) else {
            samples.append(CornerSampleOut(sec: clip.startSec, scores: ["BR": 0, "TL": 0, "TR": 0, "BL": 0]))
            continue
        }
        let asset = AVURLAsset(url: URL(fileURLWithPath: clip.mediaPath))
        guard let vTrack = asset.tracks(withMediaType: .video).first else { continue }
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(
            start: CMTime(seconds: max(0.0, clip.inSec), preferredTimescale: 600),
            duration: CMTime(seconds: clipDur + 0.05, preferredTimescale: 600)
        )
        let vOut = AVAssetReaderTrackOutput(track: vTrack, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA
        ])
        reader.add(vOut)
        reader.startReading()

        var nextT = 0.0
        while let sb = vOut.copyNextSampleBuffer() {
            let pts = CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sb))
            if pts >= clip.outSec - 0.01 { break }
            if pts + 0.05 < clip.inSec + nextT { continue }
            guard let pb = CMSampleBufferGetImageBuffer(sb) else { continue }

            autoreleasepool {
                CVPixelBufferLockBaseAddress(pb, .readOnly)
                defer { CVPixelBufferUnlockBaseAddress(pb, .readOnly) }
                let pw = CVPixelBufferGetWidth(pb)
                let ph = CVPixelBufferGetHeight(pb)
                let bpr = CVPixelBufferGetBytesPerRow(pb)
                guard let base = CVPixelBufferGetBaseAddress(pb),
                      let srcCtx = CGContext(
                          data: base, width: pw, height: ph, bitsPerComponent: 8, bytesPerRow: bpr, space: cs,
                          bitmapInfo: CGBitmapInfo.byteOrder32Little.rawValue | CGImageAlphaInfo.premultipliedFirst.rawValue
                      ),
                      let fullImg = srcCtx.makeImage() else { return }

                rgba.withUnsafeMutableBytes { ptr in
                    if let dst = CGContext(
                        data: ptr.baseAddress, width: W, height: H, bitsPerComponent: 8, bytesPerRow: W * 4, space: cs,
                        bitmapInfo: CGBitmapInfo.byteOrder32Big.rawValue | CGImageAlphaInfo.premultipliedLast.rawValue
                    ) {
                        dst.interpolationQuality = .low
                        dst.draw(fullImg, in: CGRect(x: 0, y: 0, width: W, height: H))
                    }
                }

                var lums = [Double]()
                lums.reserveCapacity(W * H)
                for k in 0..<(W * H) {
                    let off = k * 4
                    lums.append(0.299 * Double(rgba[off]) + 0.587 * Double(rgba[off + 1]) + 0.114 * Double(rgba[off + 2]))
                }
                let bgLum = lums.sorted()[lums.count / 2]
                let darkSlide = bgLum < 100.0
                var busy = [Float](repeating: 0, count: W * H)
                for k in 0..<(W * H) {
                    let off = k * 4
                    let sat = Double(max(rgba[off], max(rgba[off + 1], rgba[off + 2])) - min(rgba[off], min(rgba[off + 1], rgba[off + 2])))
                    if darkSlide {
                        busy[k] = (abs(lums[k] - bgLum) > 28.0 || sat > 36.0) ? 1.0 : 0.0
                    } else {
                        busy[k] = (lums[k] < 200.0 || sat > 24.0) ? 1.0 : 0.0
                    }
                }
                var scMap: [String: Double] = [:]
                for (name, x0, y0, x1, y1) in boxes {
                    scMap[name] = boxBusyFraction(busy: busy, gw: W, gh: H, x0: x0, y0: y0, x1: x1, y1: y1)
                }
                samples.append(CornerSampleOut(sec: clip.startSec + nextT, scores: scMap))
            }
            nextT += 1.0
        }
        reader.cancelReading()
    }

    let encoded = try JSONEncoder().encode(ScanBadgeOutput(samples: samples))
    try encoded.write(to: URL(fileURLWithPath: outPath))
}

// =========================================================================
// Main Entrypoint
// =========================================================================

let args = CommandLine.arguments
if args.count < 3 {
    fputs("Usage: kahamatic-helper <list-fonts|analyze-phase1|align-io-words|track-red-pen|scan-badge-corners> [in.json] <out.json>\n", stderr)
    exit(2)
}

do {
    let cmd = args[1]
    switch cmd {
    case "list-fonts":
        try cmdListFonts(outPath: args.last!)
    case "analyze-phase1":
        guard args.count >= 4 else { throw NSError(domain: "Kahamatic", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing input/output paths"]) }
        try cmdAnalyzePhase1(inPath: args[2], outPath: args[3])
    case "align-io-words":
        guard args.count >= 4 else { throw NSError(domain: "Kahamatic", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing input/output paths"]) }
        try cmdAlignIoWords(inPath: args[2], outPath: args[3])
    case "track-red-pen":
        guard args.count >= 4 else { throw NSError(domain: "Kahamatic", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing input/output paths"]) }
        try cmdTrackRedPen(inPath: args[2], outPath: args[3])
    case "scan-badge-corners":
        guard args.count >= 4 else { throw NSError(domain: "Kahamatic", code: 2, userInfo: [NSLocalizedDescriptionKey: "Missing input/output paths"]) }
        try cmdScanBadgeCorners(inPath: args[2], outPath: args[3])
    default:
        throw NSError(domain: "Kahamatic", code: 3, userInfo: [NSLocalizedDescriptionKey: "Unknown command: \(cmd)"])
    }
} catch {
    fputs("kahamatic-helper error: \(error)\n", stderr)
    exit(1)
}
