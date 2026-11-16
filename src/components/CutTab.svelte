<script lang="ts">
  import type {
    CutMode,
    CutPresetConfig,
    KahamaticSettings,
    LanguageHint,
    PacingPreset,
    ProjectContext,
  } from "../lib/types";

  interface Props {
    ctx: ProjectContext | null;
    cutConfig: CutPresetConfig;
    settings: KahamaticSettings;
    busy: boolean;
    onChangeConfig: (next: CutPresetConfig) => void;
    onOpenSettings: () => void;
    onRunCut: () => Promise<void>;
  }

  let { ctx, cutConfig, settings, busy, onChangeConfig, onOpenSettings, onRunCut }: Props = $props();

  let needsApiKey = $derived(cutConfig.mode === "ai" && !settings.geminiApiKey.trim());
  let missingV1 = $derived(Boolean(ctx && ctx.v1Clips.length === 0));

  function update(patch: Partial<CutPresetConfig>) {
    onChangeConfig({ ...cutConfig, ...patch });
  }

  function applyPacing(pacing: PacingPreset) {
    if (pacing === "natural") {
      update({ pacing: "natural", thresholdDb: -38, minPauseSec: 0.42, padSec: 0.08 });
    } else if (pacing === "tight") {
      update({ pacing: "tight", thresholdDb: -35, minPauseSec: 0.25, padSec: 0.05 });
    } else {
      update({ pacing: "custom" });
    }
  }
</script>

<div class="flex flex-col gap-3 p-3 text-xs">
  <!-- Mode Selector -->
  <div>
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[11px] font-medium text-zinc-400">Cut Detection Mode</span>
      <span class="text-[10px] text-zinc-500">
        {ctx ? `V1: ${ctx.v1Clips.length} clip(s)` : "No sequence"}
      </span>
    </div>
    <div class="grid grid-cols-2 gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
      {#each [
        { id: "ai", title: "AI + Silence", sub: "Gemini Bad Takes" },
        { id: "silence", title: "Silence Only", sub: "Offline vDSP" },
      ] as opt (opt.id)}
        <button
          type="button"
          disabled={busy}
          onclick={() => update({ mode: opt.id as CutMode })}
          class={`rounded-md px-2 py-1.5 text-left transition ${
            cutConfig.mode === opt.id
              ? "bg-amber-500 text-zinc-950 shadow-sm"
              : "text-zinc-300 hover:bg-zinc-800/80"
          }`}
        >
          <div class="text-[11px] font-semibold leading-tight">{opt.title}</div>
          <div class={`text-[10px] ${cutConfig.mode === opt.id ? "text-zinc-900" : "text-zinc-500"}`}>
            {opt.sub}
          </div>
        </button>
      {/each}
    </div>
  </div>

  {#if needsApiKey}
    <div class="flex items-center justify-between gap-2 rounded-lg border border-amber-600/50 bg-amber-950/40 px-2.5 py-2 text-[11px] text-amber-200">
      <span>Gemini API Key missing for AI Bad-Take detection.</span>
      <button
        type="button"
        onclick={onOpenSettings}
        class="shrink-0 rounded bg-amber-500 px-2 py-0.5 font-semibold text-zinc-950 hover:bg-amber-400"
      >
        Set Key
      </button>
    </div>
  {/if}

  <!-- Language & Pacing -->
  <div class="grid grid-cols-2 gap-2">
    <div>
      <span class="mb-1 block text-[11px] font-medium text-zinc-400">Spoken Language</span>
      <div class="grid grid-cols-3 gap-1 rounded border border-zinc-800 bg-zinc-950 p-0.5">
        {#each [
          { id: "bn", label: "BN" },
          { id: "en", label: "EN" },
          { id: "auto", label: "Auto" },
        ] as lang (lang.id)}
          <button
            type="button"
            disabled={busy}
            onclick={() => update({ language: lang.id as LanguageHint })}
            class={`rounded py-1 text-[11px] font-medium transition ${
              cutConfig.language === lang.id
                ? "bg-zinc-700 text-amber-300"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {lang.label}
          </button>
        {/each}
      </div>
    </div>

    <div>
      <span class="mb-1 block text-[11px] font-medium text-zinc-400">Pacing</span>
      <div class="grid grid-cols-3 gap-1 rounded border border-zinc-800 bg-zinc-950 p-0.5">
        {#each [
          { id: "natural", label: "Natural" },
          { id: "tight", label: "Tight" },
          { id: "custom", label: "Custom" },
        ] as p (p.id)}
          <button
            type="button"
            disabled={busy}
            onclick={() => applyPacing(p.id as PacingPreset)}
            class={`rounded py-1 text-[11px] font-medium transition ${
              cutConfig.pacing === p.id
                ? "bg-zinc-700 text-amber-300"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {p.label}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <!-- DSP Sliders -->
  <div class="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
    <div>
      <div class="mb-0.5 flex justify-between text-[11px]">
        <span class="text-zinc-300">Silence Threshold</span>
        <span class="font-mono text-amber-400">{cutConfig.thresholdDb} dB</span>
      </div>
      <input
        type="range"
        min="-50"
        max="-24"
        step="1"
        disabled={busy}
        value={cutConfig.thresholdDb}
        oninput={(e) =>
          update({ pacing: "custom", thresholdDb: Number((e.currentTarget as HTMLInputElement).value) })
        }
        class="h-1.5 w-full cursor-pointer accent-amber-500"
      />
    </div>

    <div class="grid grid-cols-2 gap-2.5">
      <div>
        <div class="mb-0.5 flex justify-between text-[11px]">
          <span class="text-zinc-300">Min Pause</span>
          <span class="font-mono text-amber-400">{cutConfig.minPauseSec.toFixed(2)}s</span>
        </div>
        <input
          type="range"
          min="0.15"
          max="1.0"
          step="0.01"
          disabled={busy}
          value={cutConfig.minPauseSec}
          oninput={(e) =>
            update({ pacing: "custom", minPauseSec: Number((e.currentTarget as HTMLInputElement).value) })
          }
          class="h-1.5 w-full cursor-pointer accent-amber-500"
        />
      </div>

      <div>
        <div class="mb-0.5 flex justify-between text-[11px]">
          <span class="text-zinc-300">Edge Pad</span>
          <span class="font-mono text-amber-400">{cutConfig.padSec.toFixed(2)}s</span>
        </div>
        <input
          type="range"
          min="0.02"
          max="0.20"
          step="0.01"
          disabled={busy}
          value={cutConfig.padSec}
          oninput={(e) =>
            update({ pacing: "custom", padSec: Number((e.currentTarget as HTMLInputElement).value) })
          }
          class="h-1.5 w-full cursor-pointer accent-amber-500"
        />
      </div>
    </div>
  </div>

  <!-- Clip Color Labeling -->
  <label class="flex cursor-pointer items-center justify-between rounded-lg border border-zinc-800 bg-zinc-900/50 px-2.5 py-2">
    <div>
      <div class="font-medium text-zinc-200">Colorize Timeline Clips</div>
      <div class="text-[10px] text-zinc-400">KEEP = Green • SILENCE = Cyan • BAD TAKE = Red</div>
    </div>
    <input
      type="checkbox"
      disabled={busy}
      checked={cutConfig.colorizeClips}
      onchange={(e) => update({ colorizeClips: (e.currentTarget as HTMLInputElement).checked })}
      class="h-4 w-4 accent-amber-500"
    />
  </label>

  {#if missingV1}
    <div class="rounded-lg border border-zinc-700 bg-zinc-900/70 px-2.5 py-1.5 text-[11px] text-zinc-300">
      Place your main video clip on Video Track 1 (<code class="text-amber-300">V1</code>) of the timeline.
    </div>
  {/if}

  <button
    type="button"
    disabled={busy}
    onclick={onRunCut}
    class="w-full rounded-lg bg-amber-500 px-3 py-2.5 text-xs font-bold text-zinc-950 shadow transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
  >
    {busy ? "Processing Phase 1..." : "Analyze Audio & Place Cuts"}
  </button>
</div>
