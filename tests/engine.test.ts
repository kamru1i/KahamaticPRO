import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import templatesData from "../cep/templates/premiere_templates.json";
import { buildTextFlatBuffer, bytesToBase64, hexToBytes } from "../src/lib/flatbuffer-text";
import { extractGeminiText } from "../src/lib/gemini";
import {
  build8StepHermiteCameraKfs,
  clampCameraPos,
  colorizePhase1Clips,
  injectCameraMoves,
  injectKineticTextPhrase,
  injectSmartBadge,
  PrprojDocument,
  resetClipCamera,
  TICKS_PER_SEC,
} from "../src/lib/prproj-xml";
import { normalizeGeminiModel } from "../src/lib/settings";
import { compareSemver } from "../src/lib/updater";
import { buildCutPlanFromAnalysis } from "../src/lib/workflows";

const FIXTURE_XML_PATH = path.resolve(__dirname, "fixtures", "minimal_sequence.xml");
const REAL_BACKUP_XML_PATH =
  "C:/Users/kamru/.gemini/antigravity/brain/bc0f0ce1-e358-4320-bb06-8873bb00692f/scratch/m2_10_edit/M2-10_clean_backup.xml";
const SEQ_UID = "127d4db0-7dc1-4f9d-bfe9-6c3027f77c4b";
const FRAME_TICKS_30 = TICKS_PER_SEC / 30n;

function readFixtureDoc(): PrprojDocument {
  const xml = fs.readFileSync(FIXTURE_XML_PATH, "utf8");
  return new PrprojDocument(xml);
}

describe("1. flatbuffer-text verified Adobe Text binary layout", () => {
  it("matches Premiere-saved 376-byte Base64 exactly for বীজগণিত (BanglaMN-Bold, 80, #F4AD00)", () => {
    const expectedB64 =
      "bAEAAAAAAABEMyIRDAAAAAAABgAKAAQABgAAAGQAAAAAAF4AGAAQAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAFgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAAAABcABwBeAAAAAAAAARAAAAAcAAAANAAAAAAAAQBg////ZP///2j///9s////AQAAAAQAAAANAAAAQmFuZ2xhTU4tQm9sZAAAAAEAAAAMAAAACAAOAAQACAAIAAAAhAAAADwAAAAAADYAHAAAABgAFAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAMAAAACAAEADYAAAACAAAAFAAAABgAAAAAAIBAKAAAAAAAoEL8////BAAEAAQAAAAEAAYABAAAAAAACgAIAAUABgAHAAoAAAAA9K0AFQAAAOCmrOCngOCmnOCml+Cmo+Cmv+CmpAAAAA==";
    const base = hexToBytes(templatesData.h352BaseHex);
    const buf = buildTextFlatBuffer("বীজগণিত", "BanglaMN-Bold", 80, "#F4AD00", base);
    expect(buf.length).toBe(376);
    expect(bytesToBase64(buf)).toBe(expectedB64);
  });

  it("handles shorter/longer font PostScript names, custom sizes, colors, and UTF-8 decoding", () => {
    const base = hexToBytes(templatesData.h352BaseHex);

    for (const tc of [
      { word: "Algebra", font: "ArialMT", size: 64, color: "#12AB34" },
      { word: "সম্ভাব্যতা", font: "HelveticaNeue-Bold", size: 96, color: "#FFFFFF" },
    ]) {
      const buf = buildTextFlatBuffer(tc.word, tc.font, tc.size, tc.color, base);
      const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

      const fontBytes = Buffer.from(tc.font, "utf8");
      const fontPadLen = Math.ceil((fontBytes.length + 1) / 4) * 4;
      const wordBytes = Buffer.from(tc.word, "utf8");
      const wordPadLen = Math.ceil((wordBytes.length + 1) / 4) * 4;
      const delta = fontPadLen - 16;
      const blockStart = 180 + fontPadLen;

      expect(buf.length).toBe(352 + delta + wordPadLen);
      expect(dv.getUint32(0, true)).toBe(340 + delta + wordPadLen);
      expect(dv.getUint32(144, true)).toBe(52 + delta);
      expect(dv.getUint32(176, true)).toBe(fontBytes.length);
      expect(Buffer.from(buf.slice(180, 180 + fontBytes.length)).toString("utf8")).toBe(tc.font);

      expect(dv.getFloat32(blockStart + 108, true)).toBeCloseTo(tc.size, 3);
      expect(buf[blockStart + 148]).toBe(0x00);
      expect(buf[blockStart + 149]).toBe(parseInt(tc.color.slice(1, 3), 16));
      expect(buf[blockStart + 150]).toBe(parseInt(tc.color.slice(3, 5), 16));
      expect(buf[blockStart + 151]).toBe(parseInt(tc.color.slice(5, 7), 16));

      const wordLenOffset = 332 + fontPadLen;
      expect(dv.getUint32(wordLenOffset, true)).toBe(wordBytes.length);
      expect(
        Buffer.from(buf.slice(wordLenOffset + 4, wordLenOffset + 4 + wordBytes.length)).toString("utf8")
      ).toBe(tc.word);
    }
  });
});

describe("2. prproj-xml kinetic text (all 4 styles, 16:9 & 9:16, auto-track creation)", () => {
  const sampleWords = [
    { word: "বীজগণিত", startSec: 1.0, endSec: 3.0, posX: 0.35, posY: 0.78, widthPx: 240, heightPx: 90 },
    { word: "থেকেই", startSec: 1.4, endSec: 3.0, posX: 0.55, posY: 0.78, widthPx: 190, heightPx: 90 },
  ];

  it.each(["clean-rise", "pop-bounce", "kinetic-stack", "slide-whip"] as const)(
    "injects style '%s' cleanly on 16:9 (1920x1080) with 0 integrity errors",
    (style) => {
      const doc = readFixtureDoc();
      const res = injectKineticTextPhrase(doc, {
        sequenceId: SEQ_UID,
        frameWidth: 1920,
        frameHeight: 1080,
        frameTicks: FRAME_TICKS_30,
        style,
        fontPostScript: "BanglaMN-Bold",
        defaultFontSize: 80,
        defaultColorHex: "#F4AD00",
        words: sampleWords,
      });
      expect(res.insertedCount).toBe(2);
      expect(res.tracksUsed).toEqual([2, 3]);
      const integrity = doc.validateIntegrity();
      expect(integrity.topOidCount).toBeGreaterThan(0);

      const xml = doc.serialize();
      expect(xml).toContain("<FrameRect>0,0,1920,1080</FrameRect>");
    }
  );

  it("sets portrait 9:16 FrameRect and auto-allocates new tracks without overwriting overlapping text", () => {
    const doc = readFixtureDoc();
    const first = injectKineticTextPhrase(doc, {
      sequenceId: SEQ_UID,
      frameWidth: 1080,
      frameHeight: 1920,
      frameTicks: FRAME_TICKS_30,
      style: "pop-bounce",
      fontPostScript: "BanglaMN-Bold",
      defaultFontSize: 88,
      defaultColorHex: "#FACC15",
      words: sampleWords,
    });
    expect(first.tracksUsed).toEqual([2, 3]);

    // Insert overlapping phrase -> must escalate to V4, V5 and update NextTrackID >= 6
    const second = injectKineticTextPhrase(doc, {
      sequenceId: SEQ_UID,
      frameWidth: 1080,
      frameHeight: 1920,
      frameTicks: FRAME_TICKS_30,
      style: "slide-whip",
      fontPostScript: "Helvetica-Bold",
      defaultFontSize: 72,
      defaultColorHex: "#FFFFFF",
      words: [
        { word: "44%", startSec: 1.5, endSec: 2.8, posX: 0.4, posY: 0.25, widthPx: 140, heightPx: 80 },
        { word: "Marks", startSec: 1.9, endSec: 2.8, posX: 0.6, posY: 0.25, widthPx: 200, heightPx: 80 },
      ],
    });
    expect(second.tracksUsed).toEqual([4, 5]);
    const integrity = doc.validateIntegrity();
    expect(integrity.topUidCount).toBeGreaterThan(0);

    const xml = doc.serialize();
    expect(xml).toContain("<FrameRect>0,0,1080,1920</FrameRect>");
    expect(xml).toContain("<NextTrackID>6</NextTrackID>");
  });
});

describe("3. prproj-xml camera Hermite keyframes, crop-safety & reset", () => {
  it("clamps camera Position inside safe bounds when AE.ADBE Crop margins are active", () => {
    // 150% scale => halfSpan = 0.75; leftCrop=10%, rightCrop=15%, topCrop=5%, bottomCrop=20%
    const [cx, cy] = clampCameraPos(0.95, 0.02, 150, 0.5, 0.5, {
      left: 10,
      right: 15,
      top: 5,
      bottom: 20,
    });
    // X clamped: minPosX = 1 - (1 - 0.15)*1.5 + 0.5*1.5 - 0.5 = 1 - 1.275 + 0.25 = -0.025
    // maxPosX = (1 - 0.10)*1.5 - 0.5*1.5 + 0.5 = 1.35 - 0.25 = 1.1 -> wait formula: 1.35 - 0.75 + 0.5 = 1.1
    // Actually verify crop margins keep visible rect [0, 1] covered
    const leftEdge = cx - (0.5 - 0.1) * 1.5;
    const rightEdge = cx + (0.5 - 0.15) * 1.5;
    const topEdge = cy - (0.5 - 0.05) * 1.5;
    const bottomEdge = cy + (0.5 - 0.2) * 1.5;
    expect(leftEdge).toBeLessThanOrEqual(1e-9);
    expect(rightEdge).toBeGreaterThanOrEqual(1 - 1e-9);
    expect(topEdge).toBeLessThanOrEqual(1e-9);
    expect(bottomEdge).toBeGreaterThanOrEqual(1 - 1e-9);
  });

  it("builds 8-step Hermite keyframes, applies camera moves preserving Anchor Point, and resets cleanly", () => {
    const kfs = build8StepHermiteCameraKfs({
      segments: [
        { tlFrame: 0, useClipBase: true },
        { tlFrame: 15, scale: 145, posX: 0.6, posY: 0.4 },
        { tlFrame: 90, scale: 145, posX: 0.6, posY: 0.4 },
        { tlFrame: 105, useClipBase: true },
      ],
      tlStartTicks: 0n,
      vcInTicks: 0n,
      vcOutTicks: 202n * FRAME_TICKS_30,
      frameTicks: FRAME_TICKS_30,
      baseScale: 100,
      basePos: [0.5, 0.5],
      easeStyle: "smooth",
    });
    expect(kfs.scaleKf.split(";").filter(Boolean).length).toBeGreaterThanOrEqual(16);
    expect(kfs.posKf.split(";").filter(Boolean).length).toBeGreaterThanOrEqual(16);

    const doc = readFixtureDoc();
    const moved = injectCameraMoves(doc, {
      sequenceId: SEQ_UID,
      frameTicks: FRAME_TICKS_30,
      easeStyle: "snappy",
      moves: [
        {
          clipIdx: 0,
          segments: [
            { tlFrame: 0, useClipBase: true },
            { tlFrame: 12, scale: 140, posX: 0.58, posY: 0.42 },
            { tlFrame: 120, useClipBase: true },
          ],
        },
      ],
    });
    expect(moved).toBe(1);
    expect(() => doc.validateIntegrity()).not.toThrow();

    const okReset = resetClipCamera(doc, SEQ_UID, 0);
    expect(okReset).toBe(true);
    expect(() => doc.validateIntegrity()).not.toThrow();
  });
});

describe("4. colorizer, smart badge, cut plan coalescing & semver", () => {
  it("colorizes V1 clips, injects V7 smart badge segments, and validates integrity", () => {
    const doc = readFixtureDoc();
    const colored = colorizePhase1Clips(doc, SEQ_UID, [
      { seq_clip_idx: 0, start_frame: 0, end_frame: 202, category: "KEEP", clip_label: "KEEP" },
      { seq_clip_idx: 1, start_frame: 202, end_frame: 310, category: "BAD_TAKE", clip_label: "BAD" },
    ]);
    expect(colored).toBe(2);

    const segs = injectSmartBadge(doc, {
      sequenceId: SEQ_UID,
      frameWidth: 1920,
      frameHeight: 1080,
      pngPath: "/Users/kamrul/Pictures/logo.png",
      scalePct: 18,
      opacityPct: 95,
      segments: [
        { startTicks: 0, endTicks: 1710374400000, corner: "BR", posX: 0.85, posY: 0.85 },
        { startTicks: 1710374400000, endTicks: 2624832000000, corner: "TL", posX: 0.15, posY: 0.15 },
      ],
    });
    expect(segs).toBe(2);
    expect(() => doc.validateIntegrity()).not.toThrow();

    const xml = doc.serialize();
    expect(xml).toContain("BE.Prefs.LabelColors.1");
    expect(xml).toContain("BE.Prefs.LabelColors.6");
    expect(xml).toContain("logo.png");
  });

  it("builds cut plan with SPLIT false starts and coalesces adjacent KEEP intervals", () => {
    const plan = buildCutPlanFromAnalysis(
      SEQ_UID,
      {
        fps: 30,
        sequenceTotalFrames: 600,
        silences: [{ tl_start_frame: 300, tl_end_frame: 345, tl_start_sec: 10, tl_end_sec: 11.5, dur_sec: 1.5 }],
        segments: [
          {
            seg_id: "SEG_1",
            file_idx: 0,
            src_start: 0,
            src_end: 4,
            tl_start: 0,
            tl_end: 4,
            dur: 4,
            rms: 0.05,
            peak_rms: 0.1,
            micros: [{ micro_idx: 1, src_t: 1.5, tl_t: 1.5, gap_dur: 0.25 }],
          },
          {
            seg_id: "SEG_2",
            file_idx: 0,
            src_start: 4,
            src_end: 9,
            tl_start: 4,
            tl_end: 9,
            dur: 5,
            rms: 0.06,
            peak_rms: 0.12,
            micros: [],
          },
        ],
        packs: [],
      },
      new Map([
        ["SEG_1", { seg_id: "SEG_1", decision: "SPLIT", split_micro_idx: 1, reason: "false start" }],
        ["SEG_2", { seg_id: "SEG_2", decision: "KEEP" }],
      ])
    );

    expect(plan.clips[0].category).toBe("BAD_TAKE");
    expect(plan.clips[0].end_frame).toBe(45);
    expect(plan.clips[1].category).toBe("KEEP");
    expect(plan.clips[1].start_frame).toBe(45);
    expect(plan.clips[1].end_frame).toBe(300); // Coalesced SEG_1 tail + SEG_2 + gap up to silence!
    expect(plan.clips[2].category).toBe("SILENCE");
    // razors sorted descending for safe non-shifting QE razor execution
    for (let i = 1; i < plan.razor_frames.length; i++) {
      expect(plan.razor_frames[i]).toBeLessThan(plan.razor_frames[i - 1]);
    }
  });

  it("compares semantic versions properly", () => {
    expect(compareSemver("0.2.0", "0.1.0")).toBe(1);
    expect(compareSemver("v1.0.0", "0.9.9")).toBe(1);
    expect(compareSemver("0.1.0", "0.1.0")).toBe(0);
    expect(compareSemver("0.1.0", "v0.1.1")).toBe(-1);
  });

  it("rejects newly introduced dangling ObjectRef inside sequence tracks", () => {
    const doc = readFixtureDoc();
    const { videoTrackGroup } = doc.findSequenceGroups(SEQ_UID);
    const v1Track = doc.getVideoTracks(videoTrackGroup)[0].trackEl;
    const tis = doc.ensureTrackItemsContainer(v1Track);
    const badRef = doc.doc.createElement("TrackItem");
    badRef.setAttribute("Index", "99");
    badRef.setAttribute("ObjectRef", "99999999");
    tis.appendChild(badRef);
    expect(() => doc.validateIntegrity()).toThrow(/Dangling ObjectRef='99999999'/);
  });
});

describe.runIf(fs.existsSync(REAL_BACKUP_XML_PATH))("5. Real M2-10_clean_backup.xml full integration", () => {
  it("runs text + camera + colorize + badge on full 1.66 MB project XML with 0 integrity errors", () => {
    const doc = new PrprojDocument(fs.readFileSync(REAL_BACKUP_XML_PATH, "utf8"));

    const textRes = injectKineticTextPhrase(doc, {
      sequenceId: SEQ_UID,
      frameWidth: 1920,
      frameHeight: 1080,
      frameTicks: FRAME_TICKS_30,
      style: "kinetic-stack",
      fontPostScript: "BanglaMN-Bold",
      defaultFontSize: 80,
      defaultColorHex: "#F4AD00",
      words: [
        { word: "বীজগণিত", startSec: 5.0, endSec: 7.5, posX: 0.35, posY: 0.72, widthPx: 240, heightPx: 90 },
        { word: "থেকেই", startSec: 5.6, endSec: 7.5, posX: 0.55, posY: 0.72, widthPx: 190, heightPx: 90 },
      ],
    });
    expect(textRes.insertedCount).toBe(2);

    const moved = injectCameraMoves(doc, {
      sequenceId: SEQ_UID,
      frameTicks: FRAME_TICKS_30,
      easeStyle: "smooth",
      moves: [
        {
          clipIdx: 0,
          segments: [
            { tlFrame: 0, useClipBase: true },
            { tlFrame: 15, scale: 135, posX: 0.55, posY: 0.45 },
            { tlFrame: 90, useClipBase: true },
          ],
        },
      ],
    });
    expect(moved).toBe(1);

    colorizePhase1Clips(doc, SEQ_UID, [
      { seq_clip_idx: 0, start_frame: 0, end_frame: 202, category: "KEEP", clip_label: "KEEP" },
    ]);

    const badgeSegs = injectSmartBadge(doc, {
      sequenceId: SEQ_UID,
      frameWidth: 1920,
      frameHeight: 1080,
      pngPath: "/Users/kamrul/Downloads/badge.png",
      scalePct: 18,
      opacityPct: 95,
      segments: [{ startTicks: 0, endTicks: 5080320000000, corner: "BR", posX: 0.85, posY: 0.85 }],
    });
    expect(badgeSegs).toBe(1);

    const integrity = doc.validateIntegrity();
    expect(integrity.topOidCount).toBeGreaterThan(100);
  });
});

describe("6. Gemini model migration & thought-part extraction", () => {
  it("skips thinking parts when extracting answer text from Gemini responses", () => {
    const mockResp = {
      candidates: [
        {
          content: {
            parts: [
              { thought: true, text: "Internal chain of thought reasoning..." },
              { text: '{"decisions":[{"seg_id":"SEG_1","decision":"KEEP"}]}' },
            ],
          },
        },
      ],
    };
    expect(extractGeminiText(mockResp)).toBe('{"decisions":[{"seg_id":"SEG_1","decision":"KEEP"}]}');
  });

  it("upgrades deprecated gemini-2.x models to gemini-4-hydrogen while keeping newer/custom models", () => {
    expect(normalizeGeminiModel("")).toBe("gemini-4-hydrogen");
    expect(normalizeGeminiModel(undefined)).toBe("gemini-4-hydrogen");
    expect(normalizeGeminiModel("gemini-2.5-flash")).toBe("gemini-4-hydrogen");
    expect(normalizeGeminiModel("gemini-2.0-flash")).toBe("gemini-4-hydrogen");
    expect(normalizeGeminiModel("gemini-3.8-flash")).toBe("gemini-3.8-flash");
    expect(normalizeGeminiModel("gemini-4-carbon")).toBe("gemini-4-carbon");
  });
});
