<script lang="ts">
  import type { ProjectContext } from "../lib/types";
  import { createNamedBackup, suggestNextBackupLabel } from "../lib/workflows";

  interface Props {
    ctx: ProjectContext | null;
    busy: boolean;
    onClose: () => void;
    onLog: (msg: string, isError?: boolean) => void;
  }

  let { ctx, busy, onClose, onLog }: Props = $props();

  let versionName = $state("v1");
  let saving = $state(false);
  let lastSavedFile = $state<string | null>(null);
  let errMsg = $state<string | null>(null);

  $effect(() => {
    if (ctx) {
      versionName = suggestNextBackupLabel(ctx);
      errMsg = null;
    }
  });

  let cleanPreview = $derived.by(() => {
    const clean = versionName.trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
    const base = ctx?.projectName ? ctx.projectName.replace(/\.prproj$/i, "") : "Project";
    return clean ? `${base}_${clean}.prproj` : "";
  });

  async function handleSaveBackup() {
    if (!ctx) {
      errMsg = "No active Premiere Pro project detected.";
      return;
    }
    saving = true;
    errMsg = null;
    lastSavedFile = null;
    try {
      const res = await createNamedBackup(ctx, versionName);
      lastSavedFile = res.fileName;
      onLog(`Backup saved: ${res.fileName} (stayed on active project)`);
      versionName = suggestNextBackupLabel(ctx);
    } catch (e: any) {
      const msg = e?.message || String(e);
      errMsg = msg;
      onLog(`Backup failed: ${msg}`, true);
    } finally {
      saving = false;
    }
  }
</script>

<div class="border-b border-zinc-700/80 bg-zinc-900/95 px-3 py-2.5 text-xs">
  <div class="mb-1.5 flex items-center justify-between">
    <span class="font-semibold text-amber-400">Named Version Backup</span>
    <button
      type="button"
      onclick={onClose}
      class="rounded px-1.5 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
    >
      Close
    </button>
  </div>

  <div class="flex items-center gap-1.5">
    <input
      type="text"
      bind:value={versionName}
      placeholder="e.g. v1, before_cuts"
      disabled={saving || busy}
      onkeydown={(e) => e.key === "Enter" && handleSaveBackup()}
      class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500"
    />
    <button
      type="button"
      onclick={handleSaveBackup}
      disabled={!ctx || saving || busy || !cleanPreview}
      class="shrink-0 rounded bg-amber-500 px-3 py-1.5 text-xs font-semibold text-zinc-950 transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-45"
    >
      {saving ? "Saving..." : "Save Copy"}
    </button>
  </div>

  {#if cleanPreview}
    <div class="mt-1.5 truncate text-[11px] text-zinc-400" title={ctx?.projectDir || ""}>
      Will save <span class="font-mono text-zinc-200">{cleanPreview}</span> in project folder
    </div>
  {/if}

  {#if lastSavedFile}
    <div class="mt-1.5 rounded border border-emerald-700/60 bg-emerald-950/50 px-2 py-1 text-[11px] text-emerald-300">
      Saved <span class="font-mono">{lastSavedFile}</span> — active project unchanged.
    </div>
  {/if}

  {#if errMsg}
    <div class="mt-1.5 rounded border border-red-700/60 bg-red-950/50 px-2 py-1 text-[11px] text-red-300">
      {errMsg}
    </div>
  {/if}
</div>
