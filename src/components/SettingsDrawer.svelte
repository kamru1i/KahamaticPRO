<script lang="ts">
  import { testGeminiApiKey } from "../lib/gemini";
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

  let geminiApiKey = $state("");
  let geminiModel = $state("gemini-2.5-flash");
  let githubRepo = $state("");
  let githubToken = $state("");
  let showKey = $state(false);
  let testingKey = $state(false);
  let keyStatus = $state<{ ok: boolean; msg: string } | null>(null);
  let savedBanner = $state(false);

  const installedVersion = getInstalledVersion();

  $effect(() => {
    geminiApiKey = settings.geminiApiKey;
    geminiModel = settings.geminiModel || "gemini-2.5-flash";
    githubRepo = settings.githubRepo;
    githubToken = settings.githubToken;
  });

  function persistDraft() {
    onSave({
      ...settings,
      geminiApiKey: geminiApiKey.trim(),
      geminiModel: geminiModel.trim() || "gemini-2.5-flash",
      githubRepo: githubRepo.trim(),
      githubToken: githubToken.trim(),
    });
    savedBanner = true;
    setTimeout(() => {
      savedBanner = false;
    }, 1800);
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
      onclick={onClose}
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
    <div class="mb-2 flex gap-1.5">
      <input
        id="gemini-key-input"
        type={showKey ? "text" : "password"}
        bind:value={geminiApiKey}
        placeholder="AIza..."
        class="min-w-0 flex-1 rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-xs text-zinc-100 outline-none focus:border-amber-500"
      />
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

    <label class="mb-1 block text-[11px] text-zinc-400" for="gemini-model-select">Model</label>
    <select
      id="gemini-model-select"
      bind:value={geminiModel}
      class="w-full rounded border border-zinc-700 bg-zinc-950 px-2 py-1.5 text-xs text-zinc-100 outline-none focus:border-amber-500"
    >
      <option value="gemini-2.5-flash">gemini-2.5-flash (Fast, Recommended)</option>
      <option value="gemini-2.5-pro">gemini-2.5-pro (Higher Reasoning)</option>
      <option value="gemini-2.0-flash">gemini-2.0-flash (Legacy Fast)</option>
    </select>

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
