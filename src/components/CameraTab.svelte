<script lang="ts">
  import type { AutoTrackMode, CameraPresetConfig, EaseStyle, ProjectContext } from "../lib/types";

  interface Props {
    ctx: ProjectContext | null;
    cameraConfig: CameraPresetConfig;
    busy: boolean;
    onChangeConfig: (next: CameraPresetConfig) => void;
    onRefreshContext: () => Promise<void>;
    onRunManualZoom: (
      targetNormX: number,
      targetNormY: number,
      zoomScalePct: number,
      transitionSec: number,
      easeStyle: EaseStyle
    ) => Promise<void>;
    onRunAutoCamera: () => Promise<void>;
    onResetClip: () => Promise<void>;
  }

  let {
    ctx,
    cameraConfig,
    busy,
    onChangeConfig,
    onRefreshContext,
    onRunManualZoom,
    onRunAutoCamera,
    onResetClip,
  }: Props = $props();

  let subMode = $state<"manual" | "auto">("manual");
  let targetNormX = $state(0.5);
  let targetNormY = $state(0.5);
  let dragging = $state(false);
  let padEl = $state<HTMLDivElement | null>(null);

  let frameW = $derived(ctx?.frameWidth || 1920);
  let frameH = $derived(ctx?.frameHeight || 1080);
  let isPortrait = $derived(frameH > frameW);
  let hasValidIo = $derived(
    Boolean(ctx && ctx.inSec !== null && ctx.outSec !== null && ctx.outSec > ctx.inSec)
  );

  // Box size of simulated zoomed viewport inside Target Pad
  let boxW = $derived(Math.min(100, (100 / Math.max(105, cameraConfig.zoomScalePct)) * 100));
  let boxH = $derived(boxW);
  let boxLeft = $derived(Math.max(0, Math.min(100 - boxW, targetNormX * 100 - boxW / 2)));
  let boxTop = $derived(Math.max(0, Math.min(100 - boxH, targetNormY * 100 - boxH / 2)));

  function update(patch: Partial<CameraPresetConfig>) {
    onChangeConfig({ ...cameraConfig, ...patch });
  }

  function updatePointFromEvent(e: PointerEvent) {
    if (!padEl) return;
    const rect = padEl.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const x = Math.max(0.05, Math.min(0.95, (e.clientX - rect.left) / rect.width));
    const y = Math.max(0.05, Math.min(0.95, (e.clientY - rect.top) / rect.height));
    targetNormX = Number(x.toFixed(3));
    targetNormY = Number(y.toFixed(3));
  }
</script>

<div class="flex flex-col gap-2.5 p-3 text-xs">
  <!-- Mode Toggle -->
  <div class="grid grid-cols-2 gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
    <button
      type="button"
      disabled={busy}
      onclick={() => (subMode = "manual")}
      class={`rounded-md py-1.5 text-[11px] font-semibold transition ${
        subMode === "manual" ? "bg-amber-500 text-zinc-950" : "text-zinc-300 hover:bg-zinc-800"
      }`}
    >
      Manual I/O Zoom
    </button>
    <button
      type="button"
      disabled={busy}
      onclick={() => (subMode = "auto")}
      class={`rounded-md py-1.5 text-[11px] font-semibold transition ${
        subMode === "auto" ? "bg-amber-500 text-zinc-950" : "text-zinc-300 hover:bg-zinc-800"
      }`}
    >
      Auto Slide Tracker
    </button>
  </div>

  {#if subMode === "manual"}
    <!-- I/O Bar -->
    <div class="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5">
      <div class="text-[11px]">
        {#if hasValidIo}
          <span class="font-mono text-emerald-400">
            I/O: {ctx?.inSec?.toFixed(2)}s → {ctx?.outSec?.toFixed(2)}s
          </span>
        {:else}
          <span class="text-amber-300">Set I/O range for zoom punch-in</span>
        {/if}
      </div>
      <button
        type="button"
        disabled={busy}
        onclick={onRefreshContext}
        class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700"
      >
        Grab I/O
      </button>
    </div>

    <!-- Interactive Target Pad -->
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
      <div class="mb-1.5 flex items-center justify-between text-[11px]">
        <span class="text-zinc-300">
          Target Pad <span class="font-mono text-zinc-500">({frameW}×{frameH})</span>
        </span>
        <button
          type="button"
          onclick={() => {
            targetNormX = 0.5;
            targetNormY = 0.5;
          }}
          class="font-mono text-[10px] text-amber-400 hover:text-amber-300"
        >
          ({Math.round(targetNormX * 100)}%, {Math.round(targetNormY * 100)}%) Reset
        </button>
      </div>

      <div class="flex justify-center">
        <div
          bind:this={padEl}
          role="slider"
          tabindex="0"
          aria-label="Camera zoom target pad"
          aria-valuenow={Math.round(targetNormX * 100)}
          style={`aspect-ratio: ${frameW} / ${frameH}; max-height: ${isPortrait ? "190px" : "155px"};`}
          onpointerdown={(e) => {
            dragging = true;
            (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
            updatePointFromEvent(e);
          }}
          onpointermove={(e) => dragging && updatePointFromEvent(e)}
          onpointerup={() => (dragging = false)}
          onpointercancel={() => (dragging = false)}
          class="relative w-full cursor-crosshair select-none overflow-hidden rounded border border-zinc-700 bg-zinc-950"
        >
          <!-- Rule of thirds grid -->
          <div class="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-zinc-800/80"></div>
          <div class="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-zinc-800/80"></div>
          <div class="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-zinc-800/80"></div>
          <div class="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-zinc-800/80"></div>

          <!-- Crop viewport preview -->
          <div
            style={`left: ${boxLeft}%; top: ${boxTop}%; width: ${boxW}%; height: ${boxH}%;`}
            class="pointer-events-none absolute border border-amber-400/70 bg-amber-500/10"
          ></div>

          <!-- Target crosshair -->
          <div
            style={`left: ${targetNormX * 100}%; top: ${targetNormY * 100}%;`}
            class="pointer-events-none absolute -translate-x-1/2 -translate-y-1/2"
          >
            <div class="h-3.5 w-3.5 rounded-full border-2 border-amber-400 bg-amber-500/40 shadow"></div>
          </div>
        </div>
      </div>
    </div>
  {:else}
    <!-- Auto Tracker Mode Selector -->
    <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
      <span class="mb-1.5 block text-[11px] font-medium text-zinc-400">Visual Detection Mode</span>
      <div class="grid grid-cols-2 gap-1.5">
        {#each [
          { id: "red-pen", title: "Red Pen / Ink", desc: "Tracks active handwriting" },
          { id: "motion", title: "Slide / Motion", desc: "Follows high-contrast delta" },
        ] as m (m.id)}
          <button
            type="button"
            disabled={busy}
            onclick={() => update({ autoTrackMode: m.id as AutoTrackMode })}
            class={`rounded border p-2 text-left transition ${
              cameraConfig.autoTrackMode === m.id
                ? "border-amber-500 bg-amber-500/15 text-amber-300"
                : "border-zinc-800 bg-zinc-950 text-zinc-300 hover:border-zinc-700"
            }`}
          >
            <div class="text-[11px] font-semibold">{m.title}</div>
            <div class="text-[10px] text-zinc-400">{m.desc}</div>
          </button>
        {/each}
      </div>
    </div>
  {/if}

  <!-- Shared Camera Sliders -->
  <div class="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
    <div class="grid grid-cols-2 gap-2.5">
      <div>
        <div class="mb-0.5 flex justify-between text-[11px]">
          <span class="text-zinc-300">Zoom Scale</span>
          <span class="font-mono text-amber-400">{cameraConfig.zoomScalePct}%</span>
        </div>
        <input
          type="range"
          min="108"
          max="220"
          step="1"
          disabled={busy}
          value={cameraConfig.zoomScalePct}
          oninput={(e) =>
            update({ zoomScalePct: Number((e.currentTarget as HTMLInputElement).value) })
          }
          class="h-1.5 w-full cursor-pointer accent-amber-500"
        />
      </div>

      <div>
        <div class="mb-0.5 flex justify-between text-[11px]">
          <span class="text-zinc-300">Ramp Time</span>
          <span class="font-mono text-amber-400">{cameraConfig.transitionSec.toFixed(2)}s</span>
        </div>
        <input
          type="range"
          min="0.15"
          max="1.0"
          step="0.01"
          disabled={busy}
          value={cameraConfig.transitionSec}
          oninput={(e) =>
            update({ transitionSec: Number((e.currentTarget as HTMLInputElement).value) })
          }
          class="h-1.5 w-full cursor-pointer accent-amber-500"
        />
      </div>
    </div>

    <div class="flex items-center justify-between pt-0.5">
      <span class="text-[11px] text-zinc-400">Hermite Ease Curve</span>
      <div class="flex gap-1 rounded border border-zinc-800 bg-zinc-950 p-0.5">
        {#each ["smooth", "snappy"] as ease (ease)}
          <button
            type="button"
            disabled={busy}
            onclick={() => update({ defaultEase: ease as EaseStyle })}
            class={`rounded px-2.5 py-0.5 text-[11px] font-medium capitalize ${
              cameraConfig.defaultEase === ease
                ? "bg-zinc-700 text-amber-300"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {ease}
          </button>
        {/each}
      </div>
    </div>
  </div>

  <!-- Action Buttons -->
  <div class="flex gap-2">
    {#if subMode === "manual"}
      <button
        type="button"
        disabled={busy || !ctx || !hasValidIo}
        onclick={() =>
          onRunManualZoom(
            targetNormX,
            targetNormY,
            cameraConfig.zoomScalePct,
            cameraConfig.transitionSec,
            cameraConfig.defaultEase
          )
        }
        class="flex-1 rounded-lg bg-amber-500 px-3 py-2.5 text-xs font-bold text-zinc-950 shadow transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Keyframing..." : "Apply Punch-In"}
      </button>
    {:else}
      <button
        type="button"
        disabled={busy || !ctx || ctx.v1Clips.length === 0}
        onclick={onRunAutoCamera}
        class="flex-1 rounded-lg bg-amber-500 px-3 py-2.5 text-xs font-bold text-zinc-950 shadow transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy ? "Scanning Footage..." : "Run Auto Camera"}
      </button>
    {/if}

    <button
      type="button"
      disabled={busy || !ctx}
      onclick={onResetClip}
      title="Reset Motion Scale & Position at current playhead clip"
      class="shrink-0 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2.5 text-xs font-semibold text-zinc-200 hover:bg-zinc-700 disabled:opacity-40"
    >
      Reset Clip
    </button>
  </div>
</div>
