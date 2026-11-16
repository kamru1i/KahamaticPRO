<script lang="ts">
  import { onMount } from "svelte";
  import BackupBar from "./components/BackupBar.svelte";
  import BadgeTab from "./components/BadgeTab.svelte";
  import CameraTab from "./components/CameraTab.svelte";
  import CutTab from "./components/CutTab.svelte";
  import PresetBar from "./components/PresetBar.svelte";
  import SettingsDrawer from "./components/SettingsDrawer.svelte";
  import TextTab from "./components/TextTab.svelte";
  import { callHostFn, installCepKeyboardShortcuts, isCepEnvironment, spawnHelper } from "./lib/cep-node";
  import {
    BUILT_IN_PRESETS,
    getAllPresets,
    loadSettings,
    resolveActivePreset,
    saveSettings,
  } from "./lib/settings";
  import type {
    EaseStyle,
    KahamaticSettings,
    PresetProfile,
    ProjectContext,
  } from "./lib/types";
  import {
    checkForUpdates,
    getInstalledVersion,
    installSelfUpdate,
    type UpdateCheckResult,
  } from "./lib/updater";
  import {
    runAutoCameraWorkflow,
    runInsertKineticTextWorkflow,
    runManualIoCameraWorkflow,
    runPhase1CutWorkflow,
    runResetClipCameraWorkflow,
    runSmartBadgeWorkflow,
  } from "./lib/workflows";

  type TabId = "cut" | "text" | "camera" | "badge";

  const initialSettings = loadSettings();
  const appVersion = getInstalledVersion();

  let settings = $state<KahamaticSettings>(initialSettings);
  let workingPreset = $state<PresetProfile>(structuredClone(resolveActivePreset(initialSettings)));
  let ctx = $state<ProjectContext | null>(null);
  let activeTab = $state<TabId>("cut");
  let showBackup = $state(false);
  let showSettings = $state(false);
  let busy = $state(false);
  let progressPct = $state(0);
  let statusMsg = $state(isCepEnvironment() ? "Connecting to Premiere Pro..." : "Browser preview mode");
  let showLogs = $state(false);
  let logSeq = 0;
  let logs = $state<Array<{ id: number; time: string; msg: string; isError: boolean }>>([]);

  let fonts = $state<Array<{ postScript: string; displayName: string }>>([]);
  let loadingFonts = $state(false);

  let updateInfo = $state<UpdateCheckResult | null>(null);
  let checkingUpdate = $state(false);
  let installingUpdate = $state(false);

  let allPresets = $derived(getAllPresets(settings));
  let isPresetModified = $derived.by(() => {
    const base = resolveActivePreset(settings);
    return (
      JSON.stringify({
        cut: workingPreset.cut,
        text: workingPreset.text,
        camera: workingPreset.camera,
        badge: workingPreset.badge,
      }) !==
      JSON.stringify({
        cut: base.cut,
        text: base.text,
        camera: base.camera,
        badge: base.badge,
      })
    );
  });

  function pushLog(msg: string, isError = false) {
    const now = new Date();
    const time = now.toTimeString().slice(0, 8);
    logs = [{ id: ++logSeq, time, msg, isError }, ...logs].slice(0, 40);
    statusMsg = msg;
    if (isError) showLogs = true;
  }

  function updateProgress(pct: number, msg: string) {
    progressPct = Math.max(0, Math.min(100, pct));
    statusMsg = msg;
  }

  async function refreshContext(silent = false, lightweight = false) {
    if (!isCepEnvironment()) {
      if (!silent) pushLog("Open KahamaticPRO inside Adobe Premiere Pro to read the active sequence.");
      return;
    }
    try {
      const prevSeqId = ctx?.sequenceId || null;
      if (lightweight && ctx) {
        const lite = await callHostFn<ProjectContext>("getProjectContext", true);
        if (lite && lite.ok && lite.sequenceId === ctx.sequenceId && lite.v1ClipCount === ctx.v1Clips.length) {
          ctx = { ...lite, v1Clips: ctx.v1Clips };
          return;
        }
      }
      const next = await callHostFn<ProjectContext>("getProjectContext", false);
      if (!next || !next.ok) {
        if (ctx !== null) {
          ctx = null;
          if (silent && !busy) {
            statusMsg = next?.error || "Open a saved Premiere project & sequence.";
          }
        }
        if (!silent) pushLog(next?.error || "No active Premiere sequence open.", true);
        return;
      }
      ctx = next;
      if (!silent) {
        statusMsg = `Synced: ${next.sequenceName} (${next.frameWidth}x${next.frameHeight})`;
      } else if (prevSeqId !== next.sequenceId) {
        statusMsg = `Active: ${next.sequenceName} (${next.v1Clips.length} V1 clip${next.v1Clips.length === 1 ? "" : "s"})`;
      }
    } catch (e: any) {
      ctx = null;
      const errTxt = e?.message || String(e);
      if (!silent) {
        pushLog(`Context error: ${errTxt}`, true);
      } else if (statusMsg.startsWith("Connecting")) {
        statusMsg = `Bridge error: ${errTxt}`;
      }
    }
  }

  async function handleLoadFonts() {
    if (!isCepEnvironment()) {
      pushLog("Mac CoreText font scan works inside Premiere Pro on macOS.");
      return;
    }
    loadingFonts = true;
    try {
      const res = await spawnHelper<{ fonts: string[] }>("list-fonts", {});
      if (Array.isArray(res?.fonts)) {
        fonts = res.fonts.map((ps) => ({ postScript: ps, displayName: ps }));
        pushLog(`Loaded ${fonts.length} installed macOS font(s).`);
      }
    } catch (e: any) {
      pushLog(`Font scan failed: ${e?.message || e}`, true);
    } finally {
      loadingFonts = false;
    }
  }

  async function handleCheckUpdate(silent = false) {
    if (!settings.githubRepo.trim()) {
      if (!silent) pushLog("Set GitHub Repo (owner/repo) in Settings first.", true);
      return;
    }
    checkingUpdate = true;
    try {
      const res = await checkForUpdates(settings.githubRepo, settings.githubToken);
      updateInfo = res;
      if (res?.hasUpdate) {
        pushLog(`Update available: v${res.latestVersion}`);
      } else if (!silent) {
        pushLog(`Up to date (v${res?.currentVersion || appVersion}).`);
      }
    } catch (e: any) {
      if (!silent) pushLog(`Update check failed: ${e?.message || e}`, true);
    } finally {
      checkingUpdate = false;
    }
  }

  async function handleInstallUpdate() {
    if (!updateInfo?.hasUpdate || !updateInfo.downloadUrl) return;
    installingUpdate = true;
    progressPct = 35;
    statusMsg = `Downloading v${updateInfo.latestVersion}...`;
    try {
      await installSelfUpdate(updateInfo.downloadUrl, settings.githubToken);
      progressPct = 100;
      pushLog(`Installed v${updateInfo.latestVersion}. Reloading panel...`);
      setTimeout(() => {
        window.location.reload();
      }, 900);
    } catch (e: any) {
      progressPct = 0;
      pushLog(`Update install failed: ${e?.message || e}`, true);
    } finally {
      installingUpdate = false;
    }
  }

  function handleSaveSettings(next: KahamaticSettings) {
    settings = next;
    saveSettings(next);
  }

  function handleSelectPreset(id: string) {
    const nextSettings = { ...settings, activePresetId: id };
    handleSaveSettings(nextSettings);
    workingPreset = structuredClone(resolveActivePreset(nextSettings));
    pushLog(`Preset loaded: ${workingPreset.name}`);
  }

  function handleSaveCustomPreset(name: string) {
    const id = `custom-${Date.now()}`;
    const custom: PresetProfile = {
      ...structuredClone(workingPreset),
      id,
      name,
      isBuiltIn: false,
    };
    const nextSettings: KahamaticSettings = {
      ...settings,
      activePresetId: id,
      customPresets: [...settings.customPresets, custom],
    };
    handleSaveSettings(nextSettings);
    workingPreset = structuredClone(custom);
    pushLog(`Saved custom preset "${name}".`);
  }

  function handleDeleteCustomPreset(id: string) {
    const nextCustom = settings.customPresets.filter((p) => p.id !== id);
    const nextSettings: KahamaticSettings = {
      ...settings,
      activePresetId: BUILT_IN_PRESETS[0].id,
      customPresets: nextCustom,
    };
    handleSaveSettings(nextSettings);
    workingPreset = structuredClone(resolveActivePreset(nextSettings));
    pushLog("Deleted custom preset.");
  }

  async function withWorkflowLock(label: string, fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    progressPct = 5;
    statusMsg = label;
    try {
      await refreshContext(true);
      await fn();
      await refreshContext(true);
    } catch (e: any) {
      progressPct = 0;
      pushLog(e?.message || String(e), true);
    } finally {
      busy = false;
    }
  }

  async function onRunCut() {
    await withWorkflowLock("Starting Phase 1 cut pipeline...", async () => {
      if (!ctx) throw new Error("No active Premiere sequence open. Open/click a sequence on the timeline first.");
      if (workingPreset.cut.mode === "ai" && !settings.geminiApiKey.trim()) {
        showSettings = true;
        throw new Error("Please save your Gemini API Key in Settings first, or switch Mode to Silence Only.");
      }
      const res = await runPhase1CutWorkflow({
        ctx,
        cutConfig: workingPreset.cut,
        settings,
        onProgress: updateProgress,
      });
      pushLog(
        `Phase 1 done: ${res.razorCount} cuts (${res.silenceCount} silence, ${res.badTakeCount} bad takes)`
      );
    });
  }

  async function onInsertText(phraseText: string) {
    await withWorkflowLock("Inserting kinetic text...", async () => {
      if (!ctx) throw new Error("No active Premiere sequence open.");
      const res = await runInsertKineticTextWorkflow({
        ctx,
        phraseText,
        textConfig: workingPreset.text,
        onProgress: updateProgress,
      });
      pushLog(`Inserted ${res.wordsInserted} word(s) on V${res.tracksUsed.join(", V")}.`);
    });
  }

  async function onRunManualZoom(
    targetNormX: number,
    targetNormY: number,
    zoomScalePct: number,
    transitionSec: number,
    easeStyle: EaseStyle
  ) {
    await withWorkflowLock("Applying smooth I/O camera zoom...", async () => {
      if (!ctx) throw new Error("No active Premiere sequence open.");
      const res = await runManualIoCameraWorkflow({
        ctx,
        targetNormX,
        targetNormY,
        zoomScalePct,
        transitionSec,
        easeStyle,
        onProgress: updateProgress,
      });
      pushLog(`Applied smooth punch-in to ${res.clipsAnimated} clip(s).`);
    });
  }

  async function onRunAutoCamera() {
    await withWorkflowLock("Scanning video for auto camera focus...", async () => {
      if (!ctx) throw new Error("No active Premiere sequence open.");
      const res = await runAutoCameraWorkflow({
        ctx,
        cameraConfig: workingPreset.camera,
        onProgress: updateProgress,
      });
      pushLog(`Auto camera animated ${res.clipsAnimated} clip(s).`);
    });
  }

  async function onResetClipCamera() {
    await withWorkflowLock("Resetting clip camera transform...", async () => {
      if (!ctx) throw new Error("No active Premiere sequence open.");
      await runResetClipCameraWorkflow(ctx);
      progressPct = 100;
      pushLog("Reset Motion transform on active playhead clip.");
    });
  }

  async function onBrowseBadgePng() {
    if (!isCepEnvironment()) {
      pushLog("PNG file picker opens natively inside Premiere Pro.");
      return;
    }
    try {
      const picked = await callHostFn<{ cancelled: boolean; path: string }>("pickBadgePngFile");
      if (picked && !picked.cancelled && picked.path) {
        handleSaveSettings({ ...settings, badgeImagePath: picked.path });
        pushLog(`Badge PNG selected: ${picked.path.split(/[\\/]/).pop()}`);
      }
    } catch (e: any) {
      pushLog(`File picker error: ${e?.message || e}`, true);
    }
  }

  async function onRunBadge() {
    await withWorkflowLock("Placing smart badge track...", async () => {
      if (!ctx) throw new Error("No active Premiere sequence open.");
      const res = await runSmartBadgeWorkflow({
        ctx,
        pngPath: settings.badgeImagePath,
        badgeConfig: workingPreset.badge,
        onProgress: updateProgress,
      });
      pushLog(`Smart badge placed (${res.segmentsCount} seamless segment(s)).`);
    });
  }

  onMount(() => {
    const cleanupKeys = installCepKeyboardShortcuts();
    refreshContext(true);
    if (isCepEnvironment() && settings.githubRepo.trim()) {
      handleCheckUpdate(true);
    }
    if (!isCepEnvironment()) {
      return cleanupKeys;
    }
    const onFocus = () => {
      if (!busy) refreshContext(true, true);
    };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(() => {
      if (!busy && !document.hidden) {
        refreshContext(true, true);
      }
    }, 1800);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
      cleanupKeys();
    };
  });
</script>

<div class="flex h-screen flex-col overflow-hidden bg-[#18181b] text-zinc-100 select-none">
  <!-- Header -->
  <header class="shrink-0 border-b border-zinc-800 bg-zinc-900/90 px-3 py-2">
    <div class="flex items-center justify-between gap-2">
      <div class="flex min-w-0 items-center gap-1.5">
        <div class="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-amber-500 text-xs font-black text-zinc-950">
          K
        </div>
        <span class="truncate text-sm font-bold tracking-tight text-zinc-100">Kahamatic</span>
        <span class="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-400">
          PRO
        </span>
        <span class="font-mono text-[10px] text-zinc-500">v{appVersion}</span>
      </div>

      <div class="flex shrink-0 items-center gap-1">
        {#if updateInfo?.hasUpdate}
          <button
            type="button"
            onclick={() => (showSettings = true)}
            class="animate-pulse rounded-full bg-emerald-500 px-2 py-0.5 text-[10px] font-bold text-zinc-950 hover:bg-emerald-400"
          >
            Update v{updateInfo.latestVersion}
          </button>
        {/if}

        <button
          type="button"
          disabled={busy}
          onclick={() => (showBackup = !showBackup)}
          class={`rounded border px-2 py-1 text-[11px] font-medium transition ${
            showBackup
              ? "border-amber-500 bg-amber-500/15 text-amber-300"
              : "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          }`}
        >
          Backup
        </button>

        <button
          type="button"
          disabled={busy}
          onclick={() => refreshContext(false)}
          title="Refresh timeline context & In/Out points"
          class="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-45"
        >
          ↻
        </button>

        <button
          type="button"
          onclick={() => (showSettings = !showSettings)}
          title="Settings & Auto-Updater"
          class={`rounded border px-2 py-1 text-[11px] transition ${
            showSettings
              ? "border-amber-500 bg-amber-500/15 text-amber-300"
              : "border-zinc-700 bg-zinc-800 text-zinc-200 hover:bg-zinc-700"
          }`}
        >
          ⚙
        </button>
      </div>
    </div>

    <!-- Active Sequence Strip -->
    <div class="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-zinc-400">
      {#if ctx}
        <span class="truncate font-medium text-zinc-300">
          {ctx.projectName} <span class="text-zinc-500">/</span> {ctx.sequenceName}
        </span>
        <span class="shrink-0 font-mono text-zinc-400">
          {ctx.frameWidth}×{ctx.frameHeight} • {ctx.fps}fps
        </span>
      {:else}
        <span class="truncate text-zinc-500">
          {isCepEnvironment() ? "Open a Premiere project & sequence to begin" : "Browser preview mode"}
        </span>
      {/if}
    </div>
  </header>

  {#if showBackup}
    <BackupBar {ctx} {busy} onClose={() => (showBackup = false)} onLog={pushLog} />
  {/if}

  {#if showSettings}
    <SettingsDrawer
      {settings}
      {updateInfo}
      {checkingUpdate}
      {installingUpdate}
      {busy}
      onSave={handleSaveSettings}
      onCheckUpdate={() => handleCheckUpdate(false)}
      onInstallUpdate={handleInstallUpdate}
      onClose={() => (showSettings = false)}
      onLog={pushLog}
    />
  {:else}
    <!-- Preset Selector -->
    <PresetBar
      presets={allPresets}
      activePresetId={settings.activePresetId}
      isModified={isPresetModified}
      {busy}
      onSelect={handleSelectPreset}
      onSaveCustom={handleSaveCustomPreset}
      onDeleteCustom={handleDeleteCustomPreset}
    />

    <!-- 4-Tab Bar -->
    <nav class="grid shrink-0 grid-cols-4 border-b border-zinc-800 bg-zinc-900/40 text-xs">
      {#each [
        { id: "cut", label: "Cut" },
        { id: "text", label: "Text I/O" },
        { id: "camera", label: "Camera" },
        { id: "badge", label: "Badge" },
      ] as tab (tab.id)}
        <button
          type="button"
          onclick={() => (activeTab = tab.id as TabId)}
          class={`border-b-2 py-2 text-center font-semibold transition ${
            activeTab === tab.id
              ? "border-amber-500 bg-zinc-900/80 text-amber-400"
              : "border-transparent text-zinc-400 hover:bg-zinc-900/40 hover:text-zinc-200"
          }`}
        >
          {tab.label}
        </button>
      {/each}
    </nav>

    <!-- Active Tab Workspace -->
    <main class="min-h-0 flex-1 overflow-y-auto">
      {#if activeTab === "cut"}
        <CutTab
          {ctx}
          cutConfig={workingPreset.cut}
          {settings}
          {busy}
          onChangeConfig={(next) => (workingPreset = { ...workingPreset, cut: next })}
          onOpenSettings={() => (showSettings = true)}
          {onRunCut}
        />
      {:else if activeTab === "text"}
        <TextTab
          {ctx}
          textConfig={workingPreset.text}
          {fonts}
          {loadingFonts}
          {busy}
          onChangeConfig={(next) => (workingPreset = { ...workingPreset, text: next })}
          onRefreshContext={() => refreshContext(false)}
          onLoadFonts={handleLoadFonts}
          {onInsertText}
        />
      {:else if activeTab === "camera"}
        <CameraTab
          {ctx}
          cameraConfig={workingPreset.camera}
          {busy}
          onChangeConfig={(next) => (workingPreset = { ...workingPreset, camera: next })}
          onRefreshContext={() => refreshContext(false)}
          {onRunManualZoom}
          {onRunAutoCamera}
          onResetClip={onResetClipCamera}
        />
      {:else}
        <BadgeTab
          {ctx}
          badgeConfig={workingPreset.badge}
          badgeImagePath={settings.badgeImagePath}
          {busy}
          onChangeConfig={(next) => (workingPreset = { ...workingPreset, badge: next })}
          onChangeBadgePath={(p) => handleSaveSettings({ ...settings, badgeImagePath: p })}
          onBrowsePng={onBrowseBadgePng}
          {onRunBadge}
        />
      {/if}
    </main>
  {/if}

  <!-- Footer Status & Activity Log -->
  <footer class="shrink-0 border-t border-zinc-800 bg-zinc-950/90 text-[11px]">
    {#if showLogs}
      <div class="max-h-28 space-y-1 overflow-y-auto border-b border-zinc-800 px-3 py-1.5">
        {#if logs.length === 0}
          <div class="text-zinc-500">No events yet.</div>
        {:else}
          {#each logs as entry (entry.id)}
            <div class="flex gap-1.5 font-mono text-[10px]">
              <span class="shrink-0 text-zinc-600">{entry.time}</span>
              <span class={entry.isError ? "text-red-400" : "text-zinc-300"}>{entry.msg}</span>
            </div>
          {/each}
        {/if}
      </div>
    {/if}

    <div class="relative h-1 w-full bg-zinc-900">
      <div
        style={`width: ${progressPct}%`}
        class={`h-full transition-all duration-300 ${
          busy ? "bg-amber-400" : progressPct === 100 ? "bg-emerald-500" : "bg-amber-500/70"
        }`}
      ></div>
    </div>

    <div class="flex items-center justify-between gap-2 px-3 py-1.5">
      <span class="min-w-0 flex-1 truncate text-zinc-300" title={statusMsg}>{statusMsg}</span>
      <button
        type="button"
        onclick={() => (showLogs = !showLogs)}
        class="shrink-0 text-[10px] font-medium text-zinc-400 hover:text-zinc-200"
      >
        {showLogs ? "Hide Logs" : `Logs (${logs.length})`}
      </button>
    </div>
  </footer>
</div>
