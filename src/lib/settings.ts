import { isCepEnvironment, nodeRequire } from "./cep-node";
import type { KahamaticSettings, PresetProfile } from "./types";

export const BUILT_IN_PRESETS: PresetProfile[] = [
  {
    id: "bullet-crash-course",
    name: "Bullet Crash Course (16:9)",
    isBuiltIn: true,
    cut: {
      mode: "ai",
      language: "bn",
      pacing: "natural",
      thresholdDb: -38,
      minPauseSec: 0.42,
      padSec: 0.08,
      colorizeClips: true,
    },
    text: {
      style: "clean-rise",
      fontPostScript: "BanglaMN-Bold",
      fontSize: 80,
      colorHex: "#F4AD00",
      positionMode: "auto",
      lineGap: 1.25,
      wordSpacingPx: 20,
    },
    camera: {
      zoomScalePct: 145,
      transitionSec: 0.433,
      autoTrackMode: "red-pen",
      defaultEase: "smooth",
    },
    badge: {
      cornerMode: "AUTO",
      scalePct: 18,
      opacityPct: 95,
      marginNorm: 0.04,
    },
  },
  {
    id: "reels-shorts-kinetic",
    name: "Reels / Shorts Kinetic (9:16)",
    isBuiltIn: true,
    cut: {
      mode: "ai",
      language: "auto",
      pacing: "tight",
      thresholdDb: -35,
      minPauseSec: 0.25,
      padSec: 0.05,
      colorizeClips: true,
    },
    text: {
      style: "pop-bounce",
      fontPostScript: "BanglaMN-Bold",
      fontSize: 88,
      colorHex: "#FACC15",
      positionMode: "BC",
      lineGap: 1.22,
      wordSpacingPx: 22,
    },
    camera: {
      zoomScalePct: 122,
      transitionSec: 0.3,
      autoTrackMode: "motion",
      defaultEase: "snappy",
    },
    badge: {
      cornerMode: "TR",
      scalePct: 22,
      opacityPct: 90,
      marginNorm: 0.05,
    },
  },
  {
    id: "talking-head-clean",
    name: "Talking Head Clean (YouTube)",
    isBuiltIn: true,
    cut: {
      mode: "silence",
      language: "auto",
      pacing: "natural",
      thresholdDb: -38,
      minPauseSec: 0.45,
      padSec: 0.09,
      colorizeClips: true,
    },
    text: {
      style: "slide-whip",
      fontPostScript: "Helvetica-Bold",
      fontSize: 72,
      colorHex: "#F59E0B",
      positionMode: "BL",
      lineGap: 1.2,
      wordSpacingPx: 18,
    },
    camera: {
      zoomScalePct: 118,
      transitionSec: 0.4,
      autoTrackMode: "motion",
      defaultEase: "smooth",
    },
    badge: {
      cornerMode: "BR",
      scalePct: 16,
      opacityPct: 90,
      marginNorm: 0.04,
    },
  },
];

export const DEFAULT_SETTINGS: KahamaticSettings = {
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  githubRepo: "",
  githubToken: "",
  activePresetId: BUILT_IN_PRESETS[0].id,
  customPresets: [],
  badgeImagePath: "",
};

const STORAGE_KEY = "kahamatic_pro_settings_v1";

export function getSettingsFilePath(): string {
  const os = nodeRequire<typeof import("node:os")>("os");
  const path = nodeRequire<typeof import("node:path")>("path");
  return path.join(os.homedir(), ".kahamatic-pro", "settings.json");
}

export function loadSettings(): KahamaticSettings {
  if (isCepEnvironment()) {
    try {
      const fs = nodeRequire<typeof import("node:fs")>("fs");
      const filePath = getSettingsFilePath();
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<KahamaticSettings>;
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          customPresets: Array.isArray(parsed.customPresets) ? parsed.customPresets : [],
        };
      }
    } catch {
      // fall through
    }
  } else if (typeof localStorage !== "undefined") {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<KahamaticSettings>;
        return {
          ...DEFAULT_SETTINGS,
          ...parsed,
          customPresets: Array.isArray(parsed.customPresets) ? parsed.customPresets : [],
        };
      }
    } catch {
      // ignore
    }
  }
  return structuredClone(DEFAULT_SETTINGS);
}

export function saveSettings(settings: KahamaticSettings): void {
  if (isCepEnvironment()) {
    const fs = nodeRequire<typeof import("node:fs")>("fs");
    const path = nodeRequire<typeof import("node:path")>("path");
    const filePath = getSettingsFilePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(settings, null, 2), { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tmp, filePath);
    return;
  }
  if (typeof localStorage !== "undefined") {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  }
}

export function getAllPresets(settings: KahamaticSettings): PresetProfile[] {
  return [...BUILT_IN_PRESETS, ...settings.customPresets];
}

export function resolveActivePreset(settings: KahamaticSettings): PresetProfile {
  const all = getAllPresets(settings);
  return all.find((p) => p.id === settings.activePresetId) || all[0];
}
