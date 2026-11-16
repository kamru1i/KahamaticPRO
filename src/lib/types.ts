export type KineticStyle = "clean-rise" | "pop-bounce" | "kinetic-stack" | "slide-whip";
export type CornerChoice = "AUTO" | "BR" | "TL" | "TR" | "BL";
export type GridPosition = "auto" | "TL" | "TC" | "TR" | "ML" | "MC" | "MR" | "BL" | "BC" | "BR";
export type CutMode = "ai" | "silence";
export type LanguageHint = "bn" | "en" | "auto";
export type PacingPreset = "natural" | "tight" | "custom";
export type AutoTrackMode = "red-pen" | "motion";
export type EaseStyle = "smooth" | "snappy";

export interface CutPresetConfig {
  mode: CutMode;
  language: LanguageHint;
  pacing: PacingPreset;
  thresholdDb: number;
  minPauseSec: number;
  padSec: number;
  colorizeClips: boolean;
}

export interface TextPresetConfig {
  style: KineticStyle;
  fontPostScript: string;
  fontSize: number;
  colorHex: string;
  positionMode: GridPosition;
  lineGap: number;
  wordSpacingPx: number;
}

export interface CameraPresetConfig {
  zoomScalePct: number;
  transitionSec: number;
  autoTrackMode: AutoTrackMode;
  defaultEase: EaseStyle;
}

export interface BadgePresetConfig {
  cornerMode: CornerChoice;
  scalePct: number;
  opacityPct: number;
  marginNorm: number;
}

export interface PresetProfile {
  id: string;
  name: string;
  isBuiltIn: boolean;
  cut: CutPresetConfig;
  text: TextPresetConfig;
  camera: CameraPresetConfig;
  badge: BadgePresetConfig;
}

export interface KahamaticSettings {
  geminiApiKey: string;
  geminiModel: string;
  githubRepo: string;
  githubToken: string;
  activePresetId: string;
  customPresets: PresetProfile[];
  badgeImagePath: string;
}

export interface V1ClipInfo {
  idx: number;
  name: string;
  mediaPath: string;
  startTicks: string;
  endTicks: string;
  inTicks: string;
  outTicks: string;
  startSec: number;
  endSec: number;
  inSec: number;
  outSec: number;
}

export interface ProjectContext {
  ok: boolean;
  error?: string;
  projectPath: string;
  projectName: string;
  projectDir: string;
  sequenceId: string;
  sequenceName: string;
  frameWidth: number;
  frameHeight: number;
  fps: number;
  frameTicks: string;
  seqEndTicks: string;
  inTicks: string | null;
  outTicks: string | null;
  inSec: number | null;
  outSec: number | null;
  playheadTicks: string;
  playheadSec: number;
  videoTrackCount: number;
  audioTrackCount: number;
  v1ClipCount?: number;
  v1Clips: V1ClipInfo[];
}

export interface AudioPackManifestItem {
  seg_id: string;
  file_idx: number;
  src_start: number;
  src_end: number;
  tl_start: number;
  tl_end: number;
  dur: number;
  rms: number;
  peak_rms: number;
  micros: Array<{
    micro_idx: number;
    src_t: number;
    tl_t: number;
    gap_dur: number;
  }>;
}

export interface Phase1AnalyzeResult {
  fps: number;
  sequenceTotalFrames: number;
  silences: Array<{
    tl_start_frame: number;
    tl_end_frame: number;
    tl_start_sec: number;
    tl_end_sec: number;
    dur_sec: number;
  }>;
  segments: AudioPackManifestItem[];
  packs: Array<{
    pack_idx: number;
    m4a_path: string;
    dur_sec: number;
    segments: AudioPackManifestItem[];
  }>;
}

export interface Phase1CutPlanItem {
  seq_clip_idx: number;
  start_frame: number;
  end_frame: number;
  category: "KEEP" | "SILENCE" | "BAD_TAKE";
  clip_label: string;
  reason?: string;
}

export interface Phase1CutPlan {
  sequenceId: string;
  fps: number;
  razor_frames: number[];
  clips: Phase1CutPlanItem[];
}

export interface AlignedWordBox {
  word: string;
  startSec: number;
  endSec: number;
  posX: number;
  posY: number;
  fontSize?: number;
  colorHex?: string;
  widthPx: number;
  heightPx: number;
}

export interface CameraSegmentSpec {
  tlFrame: number;
  useClipBase?: boolean;
  scale?: number;
  posX?: number;
  posY?: number;
}

export interface CameraClipMove {
  clipIdx: number;
  segments: CameraSegmentSpec[];
}

export interface BadgeSegmentSpec {
  startTicks: number;
  endTicks: number;
  corner: "BR" | "TL" | "TR" | "BL";
  posX: number;
  posY: number;
}
