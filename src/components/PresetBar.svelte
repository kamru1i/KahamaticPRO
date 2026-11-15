<script lang="ts">
  import type { PresetProfile } from "../lib/types";

  interface Props {
    presets: PresetProfile[];
    activePresetId: string;
    isModified: boolean;
    busy: boolean;
    onSelect: (id: string) => void;
    onSaveCustom: (name: string) => void;
    onDeleteCustom: (id: string) => void;
  }

  let {
    presets,
    activePresetId,
    isModified,
    busy,
    onSelect,
    onSaveCustom,
    onDeleteCustom,
  }: Props = $props();

  let creating = $state(false);
  let newName = $state("");

  let activePreset = $derived(presets.find((p) => p.id === activePresetId) || presets[0]);

  function submitNewPreset() {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onSaveCustom(trimmed);
    newName = "";
    creating = false;
  }
</script>

<div class="border-b border-zinc-800 bg-zinc-900/50 px-3 py-2">
  <div class="flex items-center gap-1.5">
    <span class="shrink-0 text-[11px] font-medium text-zinc-400">Preset</span>
    <div class="relative min-w-0 flex-1">
      <select
        value={activePresetId}
        disabled={busy}
        onchange={(e) => onSelect((e.currentTarget as HTMLSelectElement).value)}
        class="w-full truncate rounded border border-zinc-700 bg-zinc-950 px-2 py-1 text-xs font-medium text-zinc-100 outline-none focus:border-amber-500"
      >
        {#each presets as preset (preset.id)}
          <option value={preset.id}>
            {preset.isBuiltIn ? preset.name : `★ ${preset.name}`}
          </option>
        {/each}
      </select>
    </div>

    {#if isModified}
      <span class="h-2 w-2 shrink-0 rounded-full bg-amber-400" title="Preset parameters customized"></span>
    {/if}

    <button
      type="button"
      onclick={() => (creating = !creating)}
      disabled={busy}
      title="Save current settings as a custom preset"
      class="shrink-0 rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-45"
    >
      {creating ? "Cancel" : "+ Save"}
    </button>

    {#if activePreset && !activePreset.isBuiltIn}
      <button
        type="button"
        onclick={() => onDeleteCustom(activePreset.id)}
        disabled={busy}
        title="Delete custom preset"
        class="shrink-0 rounded border border-red-900/70 bg-red-950/40 px-2 py-1 text-[11px] text-red-300 hover:bg-red-900/50 disabled:opacity-45"
      >
        Del
      </button>
    {/if}
  </div>

  {#if creating}
    <div class="mt-1.5 flex items-center gap-1.5">
      <input
        type="text"
        bind:value={newName}
        placeholder="Custom preset name (e.g. Tech Review 4K)"
        onkeydown={(e) => e.key === "Enter" && submitNewPreset()}
        class="min-w-0 flex-1 rounded border border-amber-500/60 bg-zinc-950 px-2 py-1 text-xs text-zinc-100 outline-none"
      />
      <button
        type="button"
        onclick={submitNewPreset}
        disabled={!newName.trim()}
        class="rounded bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-45"
      >
        Save
      </button>
    </div>
  {/if}
</div>
