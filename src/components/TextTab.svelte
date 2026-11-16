<script lang="ts">
  import type { GridPosition, KineticStyle, ProjectContext, TextPresetConfig } from "../lib/types";

  interface FontOption {
    postScript: string;
    displayName: string;
  }

  interface Props {
    ctx: ProjectContext | null;
    textConfig: TextPresetConfig;
    fonts: FontOption[];
    loadingFonts: boolean;
    busy: boolean;
    onChangeConfig: (next: TextPresetConfig) => void;
    onRefreshContext: () => Promise<void>;
    onLoadFonts: () => Promise<void>;
    onInsertText: (phrase: string) => Promise<void>;
  }

  let {
    ctx,
    textConfig,
    fonts,
    loadingFonts,
    busy,
    onChangeConfig,
    onRefreshContext,
    onLoadFonts,
    onInsertText,
  }: Props = $props();

  let phraseText = $state("");

  const DEFAULT_FONTS: FontOption[] = [
    { postScript: "BanglaMN-Bold", displayName: "Bangla MN Bold" },
    { postScript: "BanglaSangamMN-Bold", displayName: "Bangla Sangam MN Bold" },
    { postScript: "KohinoorBangla-Bold", displayName: "Kohinoor Bangla Bold" },
    { postScript: "Helvetica-Bold", displayName: "Helvetica Bold" },
    { postScript: "HelveticaNeue-Bold", displayName: "Helvetica Neue Bold" },
    { postScript: "Arial-BoldMT", displayName: "Arial Bold" },
  ];

  const STYLES: Array<{ id: KineticStyle; title: string; desc: string }> = [
    { id: "clean-rise", title: "Clean Rise", desc: "Smooth upward ease + fade" },
    { id: "pop-bounce", title: "Pop Bounce", desc: "108% overshoot scale punch" },
    { id: "kinetic-stack", title: "Kinetic Stack", desc: "Word-by-word multi-row stack" },
    { id: "slide-whip", title: "Slide Whip", desc: "Fast horizontal whip settle" },
  ];

  const GRID_CELLS: Exclude<GridPosition, "auto">[] = ["TL", "TC", "TR", "ML", "MC", "MR", "BL", "BC", "BR"];

  let mergedFonts = $derived.by(() => {
    const map = new Map<string, FontOption>();
    for (const f of DEFAULT_FONTS) map.set(f.postScript, f);
    for (const f of fonts) {
      if (!map.has(f.postScript)) map.set(f.postScript, f);
    }
    if (textConfig.fontPostScript && !map.has(textConfig.fontPostScript)) {
      map.set(textConfig.fontPostScript, {
        postScript: textConfig.fontPostScript,
        displayName: textConfig.fontPostScript,
      });
    }
    return Array.from(map.values());
  });

  let hasValidIo = $derived(
    Boolean(ctx && ctx.inSec !== null && ctx.outSec !== null && ctx.outSec > ctx.inSec)
  );
  let ioDur = $derived(
    ctx && ctx.inSec !== null && ctx.outSec !== null ? Math.max(0, ctx.outSec - ctx.inSec) : 0
  );

  function fmtSec(sec: number | null | undefined): string {
    if (sec === null || sec === undefined || Number.isNaN(sec)) return "--:--";
    const m = Math.floor(sec / 60);
    const s = (sec % 60).toFixed(2).padStart(5, "0");
    return `${String(m).padStart(2, "0")}:${s}`;
  }

  function update(patch: Partial<TextPresetConfig>) {
    onChangeConfig({ ...textConfig, ...patch });
  }
</script>

<div class="flex flex-col gap-2.5 p-3 text-xs">
  <!-- I/O Range Bar -->
  <div class="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-2.5 py-1.5">
    <div class="min-w-0">
      {#if hasValidIo}
        <div class="font-mono text-[11px] text-emerald-400">
          I: {fmtSec(ctx?.inSec)} → O: {fmtSec(ctx?.outSec)}
          <span class="text-zinc-400">({ioDur.toFixed(2)}s)</span>
        </div>
      {:else}
        <div class="text-[11px] text-amber-300">Mark In (I) & Out (O) on Premiere timeline</div>
      {/if}
    </div>
    <button
      type="button"
      disabled={busy}
      onclick={onRefreshContext}
      class="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-45"
    >
      Grab I/O
    </button>
  </div>

  <!-- Phrase Box -->
  <div>
    <div class="mb-1 flex items-center justify-between">
      <label class="text-[11px] font-medium text-zinc-400" for="kinetic-phrase-box">
        Keyword / Phrase (Bangla or English)
      </label>
      <span class="text-[10px] text-zinc-500">
        {phraseText.trim() ? `${phraseText.trim().split(/\s+/).length} word(s)` : "Auto-splits to track layers"}
      </span>
    </div>
    <textarea
      id="kinetic-phrase-box"
      rows="3"
      disabled={busy}
      bind:value={phraseText}
      placeholder="e.g. বীজগণিত থেকেই প্রায় ৪৪%"
      class="w-full resize-y rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100 outline-none placeholder:text-zinc-600 focus:border-amber-500"
    ></textarea>
  </div>

  <!-- 4 Kinetic Styles -->
  <div>
    <span class="mb-1 block text-[11px] font-medium text-zinc-400">Kinetic Style</span>
    <div class="grid grid-cols-2 gap-1.5">
      {#each STYLES as st (st.id)}
        <button
          type="button"
          disabled={busy}
          onclick={() => update({ style: st.id })}
          class={`rounded-lg border px-2 py-1.5 text-left transition ${
            textConfig.style === st.id
              ? "border-amber-500 bg-amber-500/15 text-amber-300"
              : "border-zinc-800 bg-zinc-900/60 text-zinc-300 hover:border-zinc-700"
          }`}
        >
          <div class="text-[11px] font-semibold">{st.title}</div>
          <div class="truncate text-[10px] text-zinc-400">{st.desc}</div>
        </button>
      {/each}
    </div>
  </div>

  <!-- Font / Size / Color -->
  <div class="grid grid-cols-12 gap-1.5">
    <div class="col-span-6">
      <div class="mb-1 flex items-center justify-between">
        <span class="text-[11px] text-zinc-400">Font</span>
        <button
          type="button"
          disabled={loadingFonts || busy}
          onclick={onLoadFonts}
          class="text-[10px] text-amber-400 hover:text-amber-300 disabled:opacity-50"
        >
          {loadingFonts ? "Scanning..." : "Scan Mac"}
        </button>
      </div>
      <select
        value={textConfig.fontPostScript}
        disabled={busy}
        onchange={(e) => update({ fontPostScript: (e.currentTarget as HTMLSelectElement).value })}
        class="w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1.5 text-[11px] text-zinc-100 outline-none focus:border-amber-500"
      >
        {#each mergedFonts as f (f.postScript)}
          <option value={f.postScript}>{f.displayName}</option>
        {/each}
      </select>
    </div>

    <div class="col-span-3">
      <label class="mb-1 block text-[11px] text-zinc-400" for="text-font-size">Size</label>
      <input
        id="text-font-size"
        type="number"
        min="24"
        max="180"
        disabled={busy}
        value={textConfig.fontSize}
        oninput={(e) => update({ fontSize: Math.max(20, Number((e.currentTarget as HTMLInputElement).value) || 80) })}
        class="w-full rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1.5 text-center font-mono text-[11px] text-zinc-100 outline-none focus:border-amber-500"
      />
    </div>

    <div class="col-span-3">
      <label class="mb-1 block text-[11px] text-zinc-400" for="text-color-input">Color</label>
      <div class="flex items-center gap-1 rounded border border-zinc-700 bg-zinc-950 px-1 py-1">
        <input
          id="text-color-input"
          type="color"
          disabled={busy}
          value={textConfig.colorHex}
          oninput={(e) => update({ colorHex: (e.currentTarget as HTMLInputElement).value.toUpperCase() })}
          class="h-5 w-5 shrink-0 cursor-pointer border-0 bg-transparent p-0"
        />
        <span class="truncate font-mono text-[10px] text-zinc-300">{textConfig.colorHex}</span>
      </div>
    </div>
  </div>

  <!-- Auto Placement vs 3x3 Grid -->
  <div class="rounded-lg border border-zinc-800 bg-zinc-900/60 p-2">
    <div class="mb-2 flex items-center justify-between gap-2">
      <span class="text-[11px] font-medium text-zinc-300">Placement</span>
      <button
        type="button"
        disabled={busy}
        onclick={() => update({ positionMode: textConfig.positionMode === "auto" ? "BC" : "auto" })}
        class={`rounded-full border px-2.5 py-0.5 text-[10px] font-semibold transition ${
          textConfig.positionMode === "auto"
            ? "border-amber-500 bg-amber-500 text-zinc-950"
            : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
        }`}
      >
        {textConfig.positionMode === "auto" ? "Auto Empty-Space Scan ✓" : "Use Auto Scan"}
      </button>
    </div>

    <div class="flex items-center gap-3">
      <div class="grid grid-cols-3 gap-1">
        {#each GRID_CELLS as cell (cell)}
          <button
            type="button"
            disabled={busy}
            onclick={() => update({ positionMode: cell })}
            class={`h-6 w-9 rounded border text-[10px] font-mono transition ${
              textConfig.positionMode === cell
                ? "border-amber-500 bg-amber-500 font-bold text-zinc-950"
                : "border-zinc-700 bg-zinc-950 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            }`}
          >
            {cell}
          </button>
        {/each}
      </div>

      <div class="flex flex-1 flex-col gap-1.5 text-[10px]">
        <div class="flex items-center justify-between gap-1">
          <span class="text-zinc-400">Line Gap</span>
          <input
            type="number"
            min="0.9"
            max="2.0"
            step="0.05"
            disabled={busy}
            value={textConfig.lineGap}
            oninput={(e) =>
              update({ lineGap: Math.max(0.9, Number((e.currentTarget as HTMLInputElement).value) || 1.25) })
            }
            class="w-14 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-zinc-200"
          />
        </div>
        <div class="flex items-center justify-between gap-1">
          <span class="text-zinc-400">Word Space</span>
          <input
            type="number"
            min="4"
            max="80"
            step="2"
            disabled={busy}
            value={textConfig.wordSpacingPx}
            oninput={(e) =>
              update({ wordSpacingPx: Math.max(4, Number((e.currentTarget as HTMLInputElement).value) || 20) })
            }
            class="w-14 rounded border border-zinc-700 bg-zinc-950 px-1.5 py-0.5 text-right font-mono text-zinc-200"
          />
        </div>
      </div>
    </div>
  </div>

  <button
    type="button"
    disabled={busy}
    onclick={() => onInsertText(phraseText)}
    class="w-full rounded-lg bg-amber-500 px-3 py-2.5 text-xs font-bold text-zinc-950 shadow transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-40"
  >
    {busy ? "Aligning & Injecting Text..." : "Insert Animated Text"}
  </button>
</div>
