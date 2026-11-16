import { callHostFn, nodeRequire, spawnHelper } from "./cep-node";
import { classifyAudioPackWithGemini, type GeminiSegmentDecision } from "./gemini";
import {
  colorizePhase1Clips,
  injectCameraMoves,
  injectKineticTextPhrase,
  injectSmartBadge,
  loadPrprojFromBuffer,
  PrprojDocument,
  resetClipCamera,
  savePrprojAtomic,
} from "./prproj-xml";
import type {
  AlignedWordBox,
  BadgePresetConfig,
  BadgeSegmentSpec,
  CameraClipMove,
  CameraPresetConfig,
  CameraSegmentSpec,
  CornerChoice,
  CutPresetConfig,
  KahamaticSettings,
  Phase1AnalyzeResult,
  Phase1CutPlan,
  Phase1CutPlanItem,
  ProjectContext,
  TextPresetConfig,
} from "./types";

export function suggestNextBackupLabel(ctx: ProjectContext): string {
  try {
    const fs = nodeRequire<typeof import("node:fs")>("fs");
    const path = nodeRequire<typeof import("node:path")>("path");
    const base = path.basename(ctx.projectPath, ".prproj");
    const files = fs.readdirSync(ctx.projectDir);
    let maxN = 0;
    const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${escaped}[._-]v(\\d+)\\.prproj$`, "i");
    for (const f of files) {
      const m = f.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > maxN) maxN = n;
      }
    }
    return `v${maxN + 1}`;
  } catch {
    return "v1";
  }
}

export async function createNamedBackup(
  ctx: ProjectContext,
  versionName: string
): Promise<{ backupPath: string; fileName: string }> {
  const fs = nodeRequire<typeof import("node:fs")>("fs");
  const path = nodeRequire<typeof import("node:path")>("path");

  const cleanLabel = versionName.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!cleanLabel) {
    throw new Error("Backup version name cannot be empty.");
  }
  const base = path.basename(ctx.projectPath, ".prproj");
  const fileName = `${base}_${cleanLabel}.prproj`;
  const backupPath = path.join(ctx.projectDir, fileName);

  if (fs.existsSync(backupPath)) {
    throw new Error(`Backup "${fileName}" already exists in project folder. Use a new name.`);
  }

  await callHostFn("saveCurrentProject", ctx.projectPath);
  fs.copyFileSync(ctx.projectPath, backupPath);
  return { backupPath, fileName };
}

export async function applyXmlEditAndHotSwap<T>(
  ctx: ProjectContext,
  mutateFn: (doc: PrprojDocument) => T,
  restorePlayheadTicks?: string
): Promise<T> {
  const fs = nodeRequire<typeof import("node:fs")>("fs");

  await callHostFn("saveCurrentProject", ctx.projectPath);
  const rawBuf = fs.readFileSync(ctx.projectPath);
  const doc = loadPrprojFromBuffer(rawBuf);
  const res = mutateFn(doc);
  const stagingPath = savePrprojAtomic(doc, ctx.projectDir);

  try {
    await callHostFn(
      "hotSwapEditedProject",
      ctx.projectPath,
      stagingPath,
      ctx.sequenceId,
      restorePlayheadTicks ?? ctx.playheadTicks
    );
  } finally {
    try {
      fs.rmSync(stagingPath, { force: true });
    } catch {
      // ignore cleanup error
    }
  }
  return res;
}

export function buildCutPlanFromAnalysis(
  sequenceId: string,
  analysis: Phase1AnalyzeResult,
  decisions: Map<string, GeminiSegmentDecision>
): Phase1CutPlan {
  const fps = analysis.fps;
  const totalFrames = analysis.sequenceTotalFrames;

  const intervals: Array<{
    startFrame: number;
    endFrame: number;
    category: "KEEP" | "SILENCE" | "BAD_TAKE";
    tag: string;
    reason?: string;
  }> = [];

  for (const sil of analysis.silences) {
    if (sil.tl_end_frame > sil.tl_start_frame) {
      intervals.push({
        startFrame: sil.tl_start_frame,
        endFrame: sil.tl_end_frame,
        category: "SILENCE",
        tag: "SILENCE",
      });
    }
  }

  for (const seg of analysis.segments) {
    const sf = Math.max(0, Math.round(seg.tl_start * fps));
    const ef = Math.min(totalFrames, Math.round(seg.tl_end * fps));
    if (ef <= sf) continue;

    const dec = decisions.get(seg.seg_id);
    if (!dec || dec.decision === "KEEP") {
      intervals.push({
        startFrame: sf,
        endFrame: ef,
        category: "KEEP",
        tag: seg.seg_id,
      });
    } else if (dec.decision === "BAD_TAKE") {
      intervals.push({
        startFrame: sf,
        endFrame: ef,
        category: "BAD_TAKE",
        tag: "BAD TAKE",
        reason: dec.reason,
      });
    } else if (dec.decision === "SPLIT") {
      const micro = seg.micros.find((m) => m.micro_idx === dec.split_micro_idx) ?? seg.micros[0];
      const splitFrame = micro ? Math.round(micro.tl_t * fps) : -1;
      if (splitFrame > sf + 3 && splitFrame < ef - 3) {
        intervals.push({
          startFrame: sf,
          endFrame: splitFrame,
          category: "BAD_TAKE",
          tag: "BAD TAKE",
          reason: dec.reason || "split false start",
        });
        intervals.push({
          startFrame: splitFrame,
          endFrame: ef,
          category: "KEEP",
          tag: seg.seg_id,
        });
      } else {
        intervals.push({
          startFrame: sf,
          endFrame: ef,
          category: "BAD_TAKE",
          tag: "BAD TAKE",
          reason: dec.reason,
        });
      }
    }
  }

  // Fill any unallocated frame gaps with KEEP and clamp sorted non-overlapping ranges
  intervals.sort((a, b) => a.startFrame - b.startFrame || a.endFrame - b.endFrame);
  const fullClips: Phase1CutPlanItem[] = [];
  let cursor = 0;

  for (const iv of intervals) {
    const st = Math.max(cursor, iv.startFrame);
    const en = Math.min(totalFrames, iv.endFrame);
    if (en <= st) continue;
    if (st > cursor) {
      fullClips.push({
        seq_clip_idx: fullClips.length,
        start_frame: cursor,
        end_frame: st,
        category: "KEEP",
        clip_label: `KEEP - SEG_${fullClips.length + 1}`,
      });
    }
    const label =
      iv.category === "KEEP"
        ? `KEEP - ${iv.tag}`
        : `REMOVE [${iv.tag}] (${((en - st) / fps).toFixed(2)}s)`;
    fullClips.push({
      seq_clip_idx: fullClips.length,
      start_frame: st,
      end_frame: en,
      category: iv.category,
      clip_label: label,
      reason: iv.reason,
    });
    cursor = en;
  }

  if (cursor < totalFrames) {
    fullClips.push({
      seq_clip_idx: fullClips.length,
      start_frame: cursor,
      end_frame: totalFrames,
      category: "KEEP",
      clip_label: `KEEP - END`,
    });
  }

  // Coalesce adjacent KEEP intervals so we do not make redundant cuts
  const merged: Phase1CutPlanItem[] = [];
  for (const item of fullClips) {
    const prev = merged[merged.length - 1];
    if (prev && prev.category === "KEEP" && item.category === "KEEP" && prev.end_frame === item.start_frame) {
      prev.end_frame = item.end_frame;
    } else {
      merged.push({ ...item, seq_clip_idx: merged.length });
    }
  }

  const razorSet = new Set<number>();
  for (const c of merged) {
    if (c.start_frame > 0 && c.start_frame < totalFrames) razorSet.add(c.start_frame);
  }
  const razor_frames = Array.from(razorSet).sort((a, b) => b - a);

  return {
    sequenceId,
    fps,
    razor_frames,
    clips: merged,
  };
}

export async function runPhase1CutWorkflow(params: {
  ctx: ProjectContext;
  cutConfig: CutPresetConfig;
  settings: KahamaticSettings;
  onProgress: (pct: number, msg: string) => void;
}): Promise<{ razorCount: number; silenceCount: number; badTakeCount: number }> {
  const { ctx, cutConfig, settings, onProgress } = params;
  if (ctx.v1Clips.length === 0) {
    throw new Error("Active sequence V1 track has no video clips.");
  }
  if (cutConfig.mode === "ai" && !settings.geminiApiKey.trim()) {
    throw new Error("Gemini API Key is required for AI Bad-Take detection. Add it in Settings or switch to Silence Only mode.");
  }

  const fs = nodeRequire<typeof import("node:fs")>("fs");
  const os = nodeRequire<typeof import("node:os")>("os");
  const path = nodeRequire<typeof import("node:path")>("path");
  const tmpWorkDir = path.join(os.tmpdir(), `kahamatic_p1_${Date.now()}`);
  fs.mkdirSync(tmpWorkDir, { recursive: true });

  try {
    onProgress(12, "Extracting audio waveforms via Apple M4 vDSP engine...");
    const analysis = await spawnHelper<Phase1AnalyzeResult>(
      "analyze-phase1",
      {
        clips: ctx.v1Clips,
        fps: ctx.fps,
        thresholdDb: cutConfig.thresholdDb,
        minPauseSec: cutConfig.minPauseSec,
        padSec: cutConfig.padSec,
        packAudio: cutConfig.mode === "ai",
        tempDir: tmpWorkDir,
      },
      (line) => onProgress(25, line)
    );

    const decisionMap = new Map<string, GeminiSegmentDecision>();
    if (cutConfig.mode === "ai" && analysis.packs.length > 0) {
      onProgress(40, `Analyzing ${analysis.packs.length} audio pack(s) with Gemini AI...`);
      const concurrency = 3;
      let done = 0;
      for (let i = 0; i < analysis.packs.length; i += concurrency) {
        const chunk = analysis.packs.slice(i, i + concurrency);
        const batchResults = await Promise.all(
          chunk.map((pack) =>
            classifyAudioPackWithGemini({
              apiKey: settings.geminiApiKey,
              model: settings.geminiModel,
              m4aPath: pack.m4a_path,
              segments: pack.segments,
              languageHint: cutConfig.language,
            })
          )
        );
        for (const decList of batchResults) {
          for (const d of decList) decisionMap.set(d.seg_id, d);
        }
        done += chunk.length;
        onProgress(40 + Math.round((done / analysis.packs.length) * 35), `Gemini analyzed ${done}/${analysis.packs.length} pack(s)...`);
      }
    }

    onProgress(78, "Building non-destructive cut plan...");
    const plan = buildCutPlanFromAnalysis(ctx.sequenceId, analysis, decisionMap);
    const silenceCount = plan.clips.filter((c) => c.category === "SILENCE").length;
    const badTakeCount = plan.clips.filter((c) => c.category === "BAD_TAKE").length;

    onProgress(85, `Placing ${plan.razor_frames.length} razor cuts in Premiere Pro...`);
    await callHostFn("applyPhase1RazorAndNames", JSON.stringify(plan));

    if (cutConfig.colorizeClips && plan.clips.length > 0) {
      onProgress(93, "Color-coding KEEP / SILENCE / BAD TAKE clips on timeline...");
      // Refresh project context after cuts so indices align
      const updatedCtx = await callHostFn<ProjectContext>("getProjectContext");
      const alignedItems = updatedCtx.v1Clips.map((c, idx) => {
        const matched =
          plan.clips.find((p) => Math.abs(p.start_frame - Math.round(c.startSec * updatedCtx.fps)) <= 1) ||
          plan.clips[idx];
        return {
          seq_clip_idx: idx,
          start_frame: Math.round(c.startSec * updatedCtx.fps),
          end_frame: Math.round(c.endSec * updatedCtx.fps),
          category: matched?.category || "KEEP",
          clip_label: matched?.clip_label || c.name,
        } satisfies Phase1CutPlanItem;
      });
      await applyXmlEditAndHotSwap(
        updatedCtx,
        (doc) => colorizePhase1Clips(doc, updatedCtx.sequenceId, alignedItems),
        "0"
      );
    }

    onProgress(100, "Phase 1 cuts applied!");
    return {
      razorCount: plan.razor_frames.length,
      silenceCount,
      badTakeCount,
    };
  } finally {
    try {
      fs.rmSync(tmpWorkDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}

export async function runInsertKineticTextWorkflow(params: {
  ctx: ProjectContext;
  phraseText: string;
  textConfig: TextPresetConfig;
  onProgress: (pct: number, msg: string) => void;
}): Promise<{ wordsInserted: number; tracksUsed: number[] }> {
  const { ctx, phraseText, textConfig, onProgress } = params;
  const words = phraseText.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    throw new Error("Enter at least 1 keyword or phrase in the text box.");
  }
  if (ctx.inSec === null || ctx.outSec === null || ctx.outSec <= ctx.inSec) {
    throw new Error("Set valid In (I) and Out (O) points on the Premiere timeline first.");
  }

  const fs = nodeRequire<typeof import("node:fs")>("fs");
  const os = nodeRequire<typeof import("node:os")>("os");
  const path = nodeRequire<typeof import("node:path")>("path");

  let framePngPath: string | null = null;
  try {
    if (textConfig.positionMode === "auto" && ctx.inTicks && ctx.outTicks) {
      onProgress(20, "Capturing frame for collision-free placement...");
      try {
        const midTicks = ((BigInt(ctx.inTicks) + BigInt(ctx.outTicks)) / 2n).toString();
        const base = path.join(os.tmpdir(), `kahamatic_frame_${Date.now()}`);
        const exported = await callHostFn<string>("exportFrameAtTicks", midTicks, base, ctx.sequenceId);
        if (exported && fs.existsSync(exported)) {
          framePngPath = exported;
        }
      } catch {
        framePngPath = null;
      }
    }

    onProgress(50, `Aligning ${words.length} words & computing ${textConfig.style} layout...`);
    const aligned = await spawnHelper<{ words: AlignedWordBox[]; usedPosMode: string }>("align-io-words", {
      clips: ctx.v1Clips,
      inSec: ctx.inSec,
      outSec: ctx.outSec,
      fps: ctx.fps,
      words,
      style: textConfig.style,
      fontPostScript: textConfig.fontPostScript,
      fontSize: textConfig.fontSize,
      colorHex: textConfig.colorHex,
      positionMode: textConfig.positionMode,
      lineGap: textConfig.lineGap,
      wordSpacingPx: textConfig.wordSpacingPx,
      frameWidth: ctx.frameWidth,
      frameHeight: ctx.frameHeight,
      framePngPath,
    });

    onProgress(78, "Injecting animated graphic tracks & reloading sequence...");
    const result = await applyXmlEditAndHotSwap(
      ctx,
      (doc) =>
        injectKineticTextPhrase(doc, {
          sequenceId: ctx.sequenceId,
          frameWidth: ctx.frameWidth,
          frameHeight: ctx.frameHeight,
          frameTicks: BigInt(ctx.frameTicks),
          style: textConfig.style,
          fontPostScript: textConfig.fontPostScript,
          defaultFontSize: textConfig.fontSize,
          defaultColorHex: textConfig.colorHex,
          words: aligned.words,
        }),
      ctx.inTicks || ctx.playheadTicks
    );

    onProgress(100, `Inserted ${result.insertedCount} animated word clips on V${result.tracksUsed.join(",V")}.`);
    return { wordsInserted: result.insertedCount, tracksUsed: result.tracksUsed };
  } finally {
    if (framePngPath) {
      try {
        fs.rmSync(framePngPath, { force: true });
      } catch {
        // ignore
      }
    }
  }
}

export async function runAutoCameraWorkflow(params: {
  ctx: ProjectContext;
  cameraConfig: CameraPresetConfig;
  onProgress: (pct: number, msg: string) => void;
}): Promise<{ clipsAnimated: number }> {
  const { ctx, cameraConfig, onProgress } = params;
  onProgress(15, `Scanning V1 footage (${cameraConfig.autoTrackMode}) via CoreGraphics...`);
  const res = await spawnHelper<{ moves: CameraClipMove[] }>(
    "track-red-pen",
    {
      clips: ctx.v1Clips,
      fps: ctx.fps,
      zoomScalePct: cameraConfig.zoomScalePct,
      transitionSec: cameraConfig.transitionSec,
      trackMode: cameraConfig.autoTrackMode,
    },
    (line) => onProgress(45, line)
  );

  if (res.moves.length === 0) {
    onProgress(100, "No zoom/pan regions detected.");
    return { clipsAnimated: 0 };
  }

  onProgress(75, `Writing crop-safe Hermite keyframes to ${res.moves.length} clip(s)...`);
  const applied = await applyXmlEditAndHotSwap(ctx, (doc) =>
    injectCameraMoves(doc, {
      sequenceId: ctx.sequenceId,
      frameTicks: BigInt(ctx.frameTicks),
      moves: res.moves,
      easeStyle: cameraConfig.defaultEase,
    })
  );

  onProgress(100, `Applied smooth camera animation to ${applied} clip(s).`);
  return { clipsAnimated: applied };
}

export async function runManualIoCameraWorkflow(params: {
  ctx: ProjectContext;
  targetNormX: number;
  targetNormY: number;
  zoomScalePct: number;
  transitionSec: number;
  easeStyle: "smooth" | "snappy";
  onProgress: (pct: number, msg: string) => void;
}): Promise<{ clipsAnimated: number }> {
  const { ctx, targetNormX, targetNormY, zoomScalePct, transitionSec, easeStyle, onProgress } = params;
  if (ctx.inSec === null || ctx.outSec === null || ctx.outSec <= ctx.inSec) {
    throw new Error("Set valid In (I) and Out (O) points for the zoom range first.");
  }

  const fps = ctx.fps;
  const inFrame = Math.round(ctx.inSec * fps);
  const outFrame = Math.round(ctx.outSec * fps);
  const rampFrames = Math.max(4, Math.round(transitionSec * fps));

  // Center the selected target point (targetNormX, targetNormY) smoothly inside viewport:
  // Pixel P on source maps to 0.5 + (P - 0.5)*1 + offset -> Position needed is 0.5 - (target - 0.5) * scale + basePos offset
  const scaleFactor = zoomScalePct / 100.0;
  const targetPosX = 0.5 + (0.5 - targetNormX) * scaleFactor;
  const targetPosY = 0.5 + (0.5 - targetNormY) * scaleFactor;

  const moves: CameraClipMove[] = [];
  for (const clip of ctx.v1Clips) {
    const cs = Math.round(clip.startSec * fps);
    const ce = Math.round(clip.endSec * fps);
    const ovStart = Math.max(cs, inFrame);
    const ovEnd = Math.min(ce, outFrame);
    if (ovEnd - ovStart < 6) continue;

    const segs: CameraSegmentSpec[] = [];
    const zoomInEnd = Math.min(ovEnd - 2, ovStart + rampFrames);
    const zoomOutStart = Math.max(zoomInEnd + 1, ovEnd - rampFrames);

    if (ovStart > cs) {
      segs.push({ tlFrame: cs, useClipBase: true });
      segs.push({ tlFrame: ovStart, useClipBase: true });
    } else {
      segs.push({ tlFrame: cs, scale: zoomScalePct, posX: targetPosX, posY: targetPosY });
    }

    if (ovStart === cs) {
      // Already zoomed at clip entry or short ramp
    } else if (zoomInEnd > ovStart) {
      segs.push({ tlFrame: zoomInEnd, scale: zoomScalePct, posX: targetPosX, posY: targetPosY });
    }

    if (zoomOutStart > (segs[segs.length - 1]?.tlFrame ?? cs)) {
      segs.push({ tlFrame: zoomOutStart, scale: zoomScalePct, posX: targetPosX, posY: targetPosY });
    }

    if (ovEnd < ce) {
      segs.push({ tlFrame: ovEnd, useClipBase: true });
      segs.push({ tlFrame: ce, useClipBase: true });
    } else if (ce > (segs[segs.length - 1]?.tlFrame ?? cs)) {
      segs.push({ tlFrame: ce, scale: zoomScalePct, posX: targetPosX, posY: targetPosY });
    }

    if (segs.length >= 2) {
      moves.push({ clipIdx: clip.idx, segments: segs });
    }
  }

  if (moves.length === 0) {
    throw new Error("No V1 clip overlaps the selected In/Out range.");
  }

  onProgress(60, `Keyframing smooth punch-in (${zoomScalePct}%) across ${moves.length} clip(s)...`);
  const applied = await applyXmlEditAndHotSwap(
    ctx,
    (doc) =>
      injectCameraMoves(doc, {
        sequenceId: ctx.sequenceId,
        frameTicks: BigInt(ctx.frameTicks),
        moves,
        easeStyle,
      }),
    ctx.inTicks || ctx.playheadTicks
  );
  onProgress(100, `Applied smooth I/O zoom on ${applied} clip(s).`);
  return { clipsAnimated: applied };
}

export async function runResetClipCameraWorkflow(ctx: ProjectContext): Promise<boolean> {
  const ph = ctx.playheadSec;
  const clip = ctx.v1Clips.find((c) => ph >= c.startSec && ph < c.endSec);
  if (!clip) {
    throw new Error("Move the playhead onto a V1 clip to reset its camera keyframes.");
  }
  return applyXmlEditAndHotSwap(ctx, (doc) => resetClipCamera(doc, ctx.sequenceId, clip.idx));
}

export async function runSmartBadgeWorkflow(params: {
  ctx: ProjectContext;
  pngPath: string;
  badgeConfig: BadgePresetConfig;
  onProgress: (pct: number, msg: string) => void;
}): Promise<{ segmentsCount: number }> {
  const { ctx, pngPath, badgeConfig, onProgress } = params;
  const fs = nodeRequire<typeof import("node:fs")>("fs");
  if (!pngPath.trim() || !fs.existsSync(pngPath.trim())) {
    throw new Error("Select a valid PNG badge/logo file on your Mac first.");
  }

  const endTicks = Number(ctx.seqEndTicks);
  const frameTicks = Number(ctx.frameTicks);
  const margin = badgeConfig.marginNorm;
  const halfW = (badgeConfig.scalePct / 100) * 0.65;
  const halfH = (badgeConfig.scalePct / 100) * 0.16;

  const cornerPos: Record<"BR" | "TL" | "TR" | "BL", [number, number]> = {
    BR: [1 - margin - halfW * 0.5, 1 - margin - halfH],
    TL: [margin + halfW * 0.5, margin + halfH],
    TR: [1 - margin - halfW * 0.5, margin + halfH],
    BL: [margin + halfW * 0.5, 1 - margin - halfH],
  };

  let segments: BadgeSegmentSpec[];
  if (badgeConfig.cornerMode !== "AUTO") {
    const c = badgeConfig.cornerMode;
    segments = [
      {
        startTicks: 0,
        endTicks,
        corner: c,
        posX: cornerPos[c][0],
        posY: cornerPos[c][1],
      },
    ];
  } else {
    onProgress(30, "Scanning frame corners for busyness & text collisions...");
    const scan = await spawnHelper<{
      samples: Array<{ sec: number; scores: Record<"BR" | "TL" | "TR" | "BL", number> }>;
    }>("scan-badge-corners", {
      clips: ctx.v1Clips,
      fps: ctx.fps,
      scalePct: badgeConfig.scalePct,
      marginNorm: margin,
    });

    // Build coarse corner schedule preferring BR -> TL -> BL -> TR and coalescing short spans < 2.5s
    const rawSegs: Array<{ startSec: number; endSec: number; corner: "BR" | "TL" | "TR" | "BL" }> = [];
    const order: Array<"BR" | "TL" | "BL" | "TR"> = ["BR", "TL", "BL", "TR"];
    for (let i = 0; i < scan.samples.length; i++) {
      const s = scan.samples[i];
      const nextSec = i + 1 < scan.samples.length ? scan.samples[i + 1].sec : ctx.v1Clips[ctx.v1Clips.length - 1].endSec;
      let best: "BR" | "TL" | "TR" | "BL" = "BR";
      let bestScore = Infinity;
      for (const c of order) {
        const sc = s.scores[c] ?? 0;
        if (sc + 0.03 < bestScore) {
          bestScore = sc;
          best = c;
        }
      }
      const prev = rawSegs[rawSegs.length - 1];
      if (prev && prev.corner === best) {
        prev.endSec = nextSec;
      } else {
        rawSegs.push({ startSec: s.sec, endSec: nextSec, corner: best });
      }
    }

    // Absorb tiny flicker segments (< 2.5s) into longest neighbor
    const cleanSegs = [...rawSegs];
    let changed = true;
    while (changed && cleanSegs.length > 1) {
      changed = false;
      for (let i = 0; i < cleanSegs.length; i++) {
        if (cleanSegs[i].endSec - cleanSegs[i].startSec < 2.5) {
          if (i > 0) {
            cleanSegs[i - 1].endSec = cleanSegs[i].endSec;
            cleanSegs.splice(i, 1);
          } else {
            cleanSegs[1].startSec = cleanSegs[0].startSec;
            cleanSegs.splice(0, 1);
          }
          changed = true;
          break;
        }
      }
    }

    // Convert to exact seamless frame ticks ending at ctx.seqEndTicks
    segments = [];
    let prevEnd = 0;
    for (let i = 0; i < cleanSegs.length; i++) {
      const st = prevEnd;
      const en =
        i === cleanSegs.length - 1
          ? endTicks
          : Math.min(endTicks, Math.round(cleanSegs[i].endSec * ctx.fps) * frameTicks);
      if (en <= st) continue;
      const c = cleanSegs[i].corner;
      const prevSeg = segments[segments.length - 1];
      if (prevSeg && prevSeg.corner === c) {
        prevSeg.endTicks = en;
      } else {
        segments.push({
          startTicks: st,
          endTicks: en,
          corner: c,
          posX: cornerPos[c][0],
          posY: cornerPos[c][1],
        });
      }
      prevEnd = en;
    }
    if (segments.length === 0) {
      segments.push({ startTicks: 0, endTicks, corner: "BR", posX: cornerPos.BR[0], posY: cornerPos.BR[1] });
    }
  }

  onProgress(78, `Injecting ${segments.length} seamless badge segment(s)...`);
  const inserted = await applyXmlEditAndHotSwap(ctx, (doc) => {
    // Filter AUTO corners against existing text graphics on V2..V6 when present in XML
    let finalSegs = segments;
    if (badgeConfig.cornerMode === "AUTO") {
      const { videoTrackGroup } = doc.findSequenceGroups(ctx.sequenceId);
      const tracks = doc.getVideoTracks(videoTrackGroup);
      const textBoxes: Array<{ st: number; en: number; x: number; y: number }> = [];
      for (let ti = 1; ti < Math.min(tracks.length, 6); ti++) {
        for (const iv of doc.getTrackItemIntervals(tracks[ti].trackEl)) {
          const chRef = iv.itemEl.getElementsByTagName("Components")[0]?.getAttribute("ObjectRef") || "";
          const ch = doc.oid.get(chRef);
          if (!ch) continue;
          const comps = ch.getElementsByTagName("Component");
          for (let ci = 0; ci < comps.length; ci++) {
            const c = doc.oid.get(comps[ci].getAttribute("ObjectRef") || "");
            if (c && c.getElementsByTagName("MatchName")[0]?.textContent?.trim() === "AE.ADBE Text") {
              const pRefs = c.getElementsByTagName("Param");
              const p2 = pRefs[2] ? doc.oid.get(pRefs[2].getAttribute("ObjectRef") || "") : undefined;
              const sk = p2?.getElementsByTagName("StartKeyframe")[0]?.textContent?.trim() || "";
              const m = sk.match(/^[^,]+,([0-9.eE+-]+):([0-9.eE+-]+),/);
              if (m) {
                textBoxes.push({ st: Number(iv.start), en: Number(iv.end), x: parseFloat(m[1]), y: parseFloat(m[2]) });
              }
            }
          }
        }
      }
      if (textBoxes.length > 0) {
        const altOrder: Array<"BR" | "TL" | "BL" | "TR"> = ["BR", "TL", "BL", "TR"];
        finalSegs = segments.map((seg) => {
          const hitsCorner = (c: "BR" | "TL" | "TR" | "BL") => {
            const [cx, cy] = cornerPos[c];
            return textBoxes.some(
              (tb) => seg.startTicks < tb.en && seg.endTicks > tb.st && Math.abs(tb.x - cx) < 0.28 && Math.abs(tb.y - cy) < 0.16
            );
          };
          if (!hitsCorner(seg.corner)) return seg;
          const clean = altOrder.find((c) => !hitsCorner(c));
          if (!clean) return seg;
          return { ...seg, corner: clean, posX: cornerPos[clean][0], posY: cornerPos[clean][1] };
        });
      }
    }
    return injectSmartBadge(doc, {
      sequenceId: ctx.sequenceId,
      frameWidth: ctx.frameWidth,
      frameHeight: ctx.frameHeight,
      pngPath: pngPath.trim(),
      scalePct: badgeConfig.scalePct,
      opacityPct: badgeConfig.opacityPct,
      segments: finalSegs,
    });
  });

  onProgress(100, `Applied ${inserted} seamless badge segment(s).`);
  return { segmentsCount: inserted };
}
