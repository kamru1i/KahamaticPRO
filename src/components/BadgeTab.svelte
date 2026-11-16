<script lang="ts">
  import type { BadgePresetConfig, CornerChoice, ProjectContext } from "../lib/types";

  interface Props {
    ctx: ProjectContext | null;
    badgeConfig: BadgePresetConfig;
    badgeImagePath: string;
    busy: boolean;
    onChangeConfig: (next: BadgePresetConfig) => void;
    onChangeBadgePath: (nextPath: string) => void;
    onBrowsePng: () => Promise<void>;
    onRunBadge: () => Promise<void>;
  }

  let {
    ctx,
    badgeConfig,
    badgeImagePath,
    busy,
    onChangeConfig,
    onChangeBadgePath,
    onBrowsePng,
    onRunBadge,
  }: Props = $props();

  let previewError = $state(false);

  $effect(() => {
    badgeImagePath;
    previewError = false;
  });

  const CORNERS: Array<{ id: CornerChoice; label: string }> = [
    { id: "AUTO", label: "AUTO" },
    { id: "BR", label: "BR" },
    { id: "TL", label: "TL" },
    { id: "TR", label: "TR" },
    { id: "BL", label: "BL" },
  ];

  let previewSrc = $derived(
    badgeImagePath.trim().startsWith("/") ? `file://${encodeURI(badgeImagePath.trim())}` : ""
  );

  function update(patch: Partial<BadgePresetConfig>) {
    onChangeConfig({ ...badgeConfig, ...patch });
  }
</script>

<div class="flex flex-col gap-3 p-3 text-xs">
  <!-- PNG Selector -->
  <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
    <div class="mb-1.5 flex items-center justify-between">
      <span class="text-[11px] font-medium text-zinc-300">Badge / Watermark PNG</span>
      <span class="text-[10px] text-zinc-500">Top Free Track (V7)</span>
    </div>

    <div class="flex items-center gap-1.5">
      <input
        type="text"
        disabled={busy}
        value={badgeImagePath}
        oninput={(e) => onChangeBadgePath((e.currentTarget as HTMLInputElement).value)}
        placeholder="/Users/you/Pictures/badge.png"
        class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-100 outline-none focus:border-amber-500"
      />
      <button
        type="button"
        disabled={busy}
        onclick={onBrowsePng}
        class="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1.5 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-45"
      >
        Browse PNG
      </button>
    </div>

    {#if previewSrc && !previewError}
      <div class="mt-2 flex items-center gap-2 rounded border border-zinc-800 bg-zinc-950/90 p-1.5">
        <img
          src={previewSrc}
          alt="Selected badge preview"
          onerror={() => (previewError = true)}
          class="h-9 max-w-[110px] rounded bg-zinc-900 object-contain p-0.5"
        />
        <div class="min-w-0 flex-1 truncate text-[10px] text-zinc-400">
          {badgeImagePath.split("/").pop()}
        </div>
      </div>
    {/if}
  </div>

  <!-- Corner Choice -->
  <div>
    <div class="mb-1 flex items-center justify-between">
      <span class="text-[11px] font-medium text-zinc-400">Corner Placement</span>
      <span class="text-[10px] text-zinc-500">
        {badgeConfig.cornerMode === "AUTO" ? "Avoids ink & V2-V6 text" : `Fixed ${badgeConfig.cornerMode}`}
      </span>
    </div>
    <div class="grid grid-cols-5 gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1">
      {#each CORNERS as c (c.id)}
        <button
          type="button"
          disabled={busy}
          onclick={() => update({ cornerMode: c.id })}
          class={`rounded py-1.5 text-[11px] font-semibold transition ${
            badgeConfig.cornerMode === c.id
              ? "bg-amber-500 text-zinc-950"
              : "text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
          }`}
        >
          {c.label}
        </button>
      {/each}
    </div>
  </div>

  <!-- Scale, Opacity, Margin -->
  <div class="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/60 p-2.5">
    <div class="grid grid-cols-2 gap-2.5">
      <div>
        <div class="mb-0.5 flex justify-between text-[11px]">
          <span class="text-zinc-300">Scale</span>
          <span class="font-mono text-amber-400">{badgeConfig.scalePct}%</span>
        </div>
        <input
          type="range"
          min="6"
          max="40"
          step="1"
          disabled={busy}
          value={badgeConfig.scalePct}
          oninput={(e) => update({ scalePct: Number((e.currentTarget as HTMLInputElement).value) })}
          class="h-1.5 w-full cursor-pointer accent-amber-500"
        />
      </div>

      <div>
        <div class="mb-0.5 flex justify-between text-[11px]">
          <span class="text-zinc-300">Opacity</span>
          <span class="font-mono text-amber-400">{badgeConfig.opacityPct}%</span>
        </div>
        <input
          type="range"
          min="20"
          max="100"
          step="1"
          disabled={busy}
          value={badgeConfig.opacityPct}
          oninput={(e) =>
            update({ opacityPct: Number((e.currentTarget as HTMLInputElement).value) })
          }
          class="h-1.5 w-full cursor-pointer accent-amber-500"
        />
      </div>
    </div>

    <div>
      <div class="mb-0.5 flex justify-between text-[11px]">
        <span class="text-zinc-300">Safe Margin</span>
        <span class="font-mono text-amber-400">{Math.round(badgeConfig.marginNorm * 100)}%</span>
      </div>
      <input
        type="range"
        min="0.01"
        max="0.12"
        step="0.005"
        disabled={busy}
        value={badgeConfig.marginNorm}
        oninput={(e) =>
          update({ marginNorm: Number((e.currentTarget as HTMLInputElement).value) })
        }
        class="h-1.5 w-full cursor-pointer accent-amber-500"
      />
    </div>
  </div>

  <button
    type="button"
    disabled={busy}
    onclick={onRunBadge}
    class="w-full rounded-lg bg-amber-500 px-3 py-2.5 text-xs font-bold text-zinc-950 shadow transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
  >
    {busy ? "Scanning & Placing Badge..." : "Apply Smart Badge Track"}
  </button>
</div>
