<script lang="ts">
  import { isCepEnvironment, readSystemClipboardText } from "../lib/cep-node";
  import { listGeminiModels, testGeminiApiKey } from "../lib/gemini";
  import type { KahamaticSettings } from "../lib/types";
  import { getInstalledVersion, type UpdateCheckResult } from "../lib/updater";

  interface Props {
    settings: KahamaticSettings;
    updateInfo: UpdateCheckResult | null;
    checkingUpdate: boolean;
    installingUpdate: boolean;
    busy: boolean;
    onSave: (next: KahamaticSettings) => void;
    onCheckUpdate: () => Promise<void>;
    onInstallUpdate: () => Promise<void>;
    onClose: () => void;
    onLog: (msg: string, isError?: boolean) => void;
  }

  let {
    settings,
    updateInfo,
    checkingUpdate,
    installingUpdate,
    busy,
    onSave,
    onCheckUpdate,
    onInstallUpdate,
    onClose,
    onLog,
  }: Props = $props();

  const CURATED_MODELS: Array<{ id: string; label: string }> = [
    { id: "gemini-4-hydrogen", label: "gemini-4-hydrogen (Latest, Recommended)" },
    { id: "gemini-3.8-flash", label: "gemini-3.8-flash (Fast & Low Cost)" },
    { id: "gemini-4-carbon", label: "gemini-4-carbon (Frontier Pro)" },
    { id: "gemini-4-argon", label: "gemini-4-argon (Deep Reasoning)" },
  ];

  let geminiApiKey = $state("");
  let geminiModel = $state("gemini-4-hydrogen");
  let fetchedModels = $state<string[]>([]);
  let loadingModels = $state(false);
  let customModelMode = $state(false);
  let githubRepo = $state("");
  let githubToken = $state("");
  let showKey = $state(false);
  let testingKey = $state(false);
  let keyStatus = $state<{ ok: boolean; msg: string } | null>(null);
  let savedBanner = $state(false);

  const installedVersion = getInstalledVersion();

  let modelOptions = $derived.by(() => {
    const map = new Map<string, string>();
    for (const m of CURATED_MODELS) map.set(m.id, m.label);
    for (const id of fetchedModels) {
      if (!map.has(id)) map.set(id, id);
    }
    const cur = geminiModel.trim();
    if (cur && !map.has(cur)) map.set(cur, `${cur} (Custom)`);
    return Array.from(map.entries()).map(([id, label]) => ({ id, label }));
  });

  $effect(() => {
    geminiApiKey = settings.geminiApiKey;
    geminiModel = settings.geminiModel || "gemini-4-hydrogen";
    githubRepo = settings.githubRepo;
    githubToken = settings.githubToken;
  });

  function persistDraft() {
    onSave({
      ...settings,
      geminiApiKey: geminiApiKey.trim(),
      geminiModel: geminiModel.trim() || "gemini-4-hydrogen",
      githubRepo: githubRepo.trim(),
      githubToken: githubToken.trim(),
    });
    savedBanner = true;
    setTimeout(() => {
      savedBanner = false;
    }, 1800);
  }

  async function handlePasteKey() {
    try {
      let clip = "";
      if (isCepEnvironment()) {
        clip = readSystemClipboardText();
      } else if (typeof navigator !== "undefined" && navigator.clipboard?.readText) {
        clip = await navigator.clipboard.readText();
      }
      const clean = clip.trim();
      if (!clean) {
        keyStatus = { ok: false, msg: "Clipboard is empty." };
        return;
      }
      geminiApiKey = clean;
      keyStatus = null;
    } catch (e: any) {
      keyStatus = { ok: false, msg: `Clipboard read failed: ${e?.message || e}` };
    }
  }

  async function handleLoadModels() {
    if (!geminiApiKey.trim()) {
      keyStatus = { ok: false, msg: "Enter your Gemini API Key first to load models." };
      return;
    }
    loadingModels = true;
    try {
      const models = await listGeminiModels(geminiApiKey);
      fetchedModels = models;
      if (models.length > 0 && !models.includes(geminiModel)) {
        geminiModel = models[0];
      }
      keyStatus = { ok: true, msg: `Loaded ${models.length} active Gemini model(s) for this key.` };
      onLog(`Loaded ${models.length} Gemini model(s).`);
    } catch (e: any) {
      const msg = e?.message || String(e);
      keyStatus = { ok: false, msg };
      onLog(`Failed to load Gemini models: ${msg}`, true);
    } finally {
      loadingModels = false;
    }
  }

  async function handleTestGemini() {
    if (!geminiApiKey.trim()) {
      keyStatus = { ok: false, msg: "Enter your Gemini API Key first." };
      return;
    }
    testingKey = true;
    keyStatus = null;
    try {
      const reply = await testGeminiApiKey(geminiApiKey, geminiModel);
      keyStatus = { ok: true, msg: `Connected (${geminiModel}): ${reply.slice(0, 48)}` };
      onLog(`Gemini API key verified (${geminiModel}).`);
      persistDraft();
    } catch (e: any) {
      const msg = e?.message || String(e);
      keyStatus = { ok: false, msg };
      onLog(`Gemini key check failed: ${msg}`, true);
    } finally {
      testingKey = false;
    }
  }
</script>

<div class="flex flex-1 flex-col gap-3 overflow-y-auto p-3 text-xs">
  <div class="flex items-center justify-between border-b border-zinc-800 pb-2">
    <div>
      <h2 class="text-sm font-semibold text-zinc-100">Settings & Auto-Updater</h2>
      <p class="text-[11px] text-zinc-400">Saved in <code class="text-zinc-300">~/.kahamatic-pro/settings.json</code></p>
    </div>
    <button
      type="button"
      onclick={() => {
        persistDraft();
        onClose();
      }}
      class="rounded border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700"
    >
      Back
    </button>
  </div>

  <!-- Gemini API Card -->
  <section class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5">
    <div class="mb-2 flex items-center justify-between">
      <span class="font-semibold text-amber-400">Gemini AI Configuration</span>
      <span class="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">Phase 1 Bad Takes</span>
    </div>

    <label class="mb-1 block text-[11px] text-zinc-400" for="gemini-key-input">Gemini API Key</label>
    <div class="mb-2 flex gap-1">
      <input
        id="gemini-key-input"
        type={showKey ? "text" : "password"}
        bind:value={geminiApiKey}
        placeholder="AIza..."
        class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500"
      />
      <button
        type="button"
        onclick={handlePasteKey}
        disabled={testingKey || busy}
        title="Paste API key from clipboard"
        class="rounded border border-zinc-700 bg-zinc-800 px-2 text-[11px] text-zinc-200 hover:bg-zinc-700 disabled:opacity-50"
      >
        Paste
      </button>
      <button
        type="button"
        onclick={() => (showKey = !showKey)}
        class="rounded border border-zinc-700 bg-zinc-800 px-2 text-[11px] text-zinc-300 hover:bg-zinc-700"
      >
        {showKey ? "Hide" : "Show"}
      </button>
      <button
        type="button"
        onclick={handleTestGemini}
        disabled={testingKey || busy}
        class="rounded bg-zinc-700 px-2.5 text-[11px] font-medium text-zinc-100 hover:bg-zinc-600 disabled:opacity-50"
      >
        {testingKey ? "Testing..." : "Test"}
      </button>
    </div>

    <div class="mb-1 flex items-center justify-between gap-2">
      <label class="text-[11px] text-zinc-400" for="gemini-model-select">Model</label>
      <div class="flex items-center gap-2">
        <button
          type="button"
          onclick={handleLoadModels}
          disabled={loadingModels || testingKey || busy}
          class="text-[10px] font-medium text-amber-400 hover:text-amber-300 disabled:opacity-45"
        >
          {loadingModels ? "Loading..." : "Load Models"}
        </button>
        <button
          type="button"
          onclick={() => (customModelMode = !customModelMode)}
          class="text-[10px] text-zinc-400 hover:text-zinc-200"
        >
          {customModelMode ? "Use List" : "Custom ID"}
        </button>
      </div>
    </div>

    {#if customModelMode}
      <input
        id="gemini-model-select"
        type="text"
        bind:value={geminiModel}
        placeholder="e.g. gemini-4-hydrogen"
        class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500"
      />
    {:else}
      <select
        id="gemini-model-select"
        bind:value={geminiModel}
        onchange={() => persistDraft()}
        class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500"
      >
        {#each modelOptions as m (m.id)}
          <option value={m.id}>{m.label}</option>
        {/each}
      </select>
    {/if}

    {#if keyStatus}
      <div
        class={`mt-2 rounded border px-2 py-1 text-[11px] ${
          keyStatus.ok
            ? "border-emerald-700/60 bg-emerald-950/50 text-emerald-300"
            : "border-red-700/60 bg-red-950/50 text-red-300"
        }`}
      >
        {keyStatus.msg}
      </div>
    {/if}
  </section>

  <!-- GitHub Releases Auto-Updater -->
  <section class="rounded-lg border border-zinc-800 bg-zinc-900/70 p-2.5">
    <div class="mb-2 flex items-center justify-between">
      <span class="font-semibold text-amber-400">GitHub Auto-Updater</span>
      <span class="font-mono text-[11px] text-zinc-400">v{installedVersion}</span>
    </div>

    <label class="mb-1 block text-[11px] text-zinc-400" for="gh-repo-input">GitHub Repository (owner/repo)</label>
    <input
      id="gh-repo-input"
      type="text"
      bind:value={githubRepo}
      placeholder="username/KahamaticPRO"
      class="mb-2 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500"
    />

    <label class="mb-1 block text-[11px] text-zinc-400" for="gh-token-input">
      GitHub Token <span class="text-zinc-500">(optional, only for private repos)</span>
    </label>
    <input
      id="gh-token-input"
      type="password"
      bind:value={githubToken}
      placeholder="ghp_... or github_pat_..."
      class="mb-2.5 w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500"
    />

    <div class="flex items-center gap-2">
      <button
        type="button"
        onclick={async () => {
          persistDraft();
          await onCheckUpdate();
        }}
        disabled={checkingUpdate || installingUpdate || !githubRepo.trim()}
        class="rounded border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-[11px] font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-45"
      >
        {checkingUpdate ? "Checking..." : "Check for Updates"}
      </button>

      {#if updateInfo?.hasUpdate}
        <button
          type="button"
          onclick={onInstallUpdate}
          disabled={installingUpdate}
          class="flex-1 rounded bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-50"
        >
          {installingUpdate ? "Installing..." : `Install v${updateInfo.latestVersion} & Reload`}
        </button>
      {:else if updateInfo}
        <span class="text-[11px] text-emerald-400">Up to date (v{updateInfo.currentVersion})</span>
      {/if}
    </div>

    {#if updateInfo?.hasUpdate && updateInfo.notes}
      <div class="mt-2 max-h-24 overflow-y-auto whitespace-pre-wrap rounded border border-zinc-800 bg-zinc-950 p-2 text-[11px] text-zinc-300">
        {updateInfo.notes}
      </div>
    {/if}
  </section>

  <div class="flex items-center justify-between pt-1">
    {#if savedBanner}
      <span class="text-[11px] font-medium text-emerald-400">Settings saved ✓</span>
    {:else}
      <span class="text-[11px] text-zinc-500">Preserved across updates</span>
    {/if}

    <button
      type="button"
      onclick={persistDraft}
      class="rounded bg-amber-500 px-4 py-1.5 text-xs font-semibold text-zinc-950 hover:bg-amber-400"
    >
      Save Settings
    </button>
  </div>
</div>
