declare global {
  interface Window {
    __adobe_cep__?: {
      evalScript(script: string, callback?: (result: string) => void): void;
      getSystemPath(pathType: string): string;
      requestOpenExtension?(extensionId: string, params?: string): void;
      registerKeyEventsInterest?(keyEventsInterest: string): string;
    };
    cep_node?: {
      require<T = any>(mod: string): T;
    };
    require?: <T = any>(mod: string) => T;
  }
}

const rawReq: ((mod: string) => any) | null =
  typeof window !== "undefined"
    ? window.cep_node?.require || window.require || null
    : typeof require === "function"
      ? require
      : null;

export function isCepEnvironment(): boolean {
  return typeof window !== "undefined" && Boolean(window.__adobe_cep__) && Boolean(rawReq);
}

export function nodeRequire<T = any>(mod: string): T {
  const cleanMod = mod.replace(/^node:/, "");
  if (rawReq) {
    return rawReq(cleanMod) as T;
  }
  const proc = typeof process !== "undefined" ? (process as any) : null;
  if (proc && typeof proc.getBuiltinModule === "function") {
    const m = proc.getBuiltinModule(cleanMod);
    if (m) return m as T;
  }
  throw new Error(`Node module '${cleanMod}' requested outside CEP/Node environment`);
}

export function getExtensionRoot(): string {
  const path = nodeRequire<typeof import("node:path")>("path");
  if (typeof window !== "undefined" && window.__adobe_cep__) {
    return path.resolve(window.__adobe_cep__.getSystemPath("extension"));
  }
  return process.cwd();
}

export function getHelperBinaryPath(): string {
  const path = nodeRequire<typeof import("node:path")>("path");
  const fs = nodeRequire<typeof import("node:fs")>("fs");
  const p = path.join(getExtensionRoot(), "bin", "kahamatic-helper");
  if (!fs.existsSync(p)) {
    throw new Error(
      `Native macOS helper not found at ${p}. Rebuild via GitHub Actions or run 'npm run deploy:mac'.`
    );
  }
  return p;
}

export function evalJsx(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (typeof window === "undefined" || !window.__adobe_cep__) {
      reject(new Error("ExtendScript host is unavailable outside Adobe Premiere Pro."));
      return;
    }
    window.__adobe_cep__.evalScript(script, (res: string) => {
      if (typeof res === "string" && res.startsWith("EvalScript error")) {
        reject(new Error(res));
        return;
      }
      resolve(res ?? "");
    });
  });
}

async function ensureHostScriptLoaded(forceReload = false): Promise<void> {
  if (!forceReload) {
    try {
      const kind = await evalJsx("typeof $._Kahamatic");
      if (kind.trim() === "object") return;
    } catch {
      // Fall through and explicitly load hostscript.jsx
    }
  }
  const path = nodeRequire<typeof import("node:path")>("path");
  const jsxPath = path.join(getExtensionRoot(), "jsx", "hostscript.jsx").replace(/\\/g, "/");
  const loadedKind = await evalJsx(`$.evalFile(${JSON.stringify(jsxPath)}); typeof $._Kahamatic;`);
  if (loadedKind.trim() !== "object") {
    throw new Error(`Failed to initialize ExtendScript bridge at ${jsxPath}`);
  }
}

export async function callHostFn<T = any>(fnName: string, ...args: unknown[]): Promise<T> {
  const serialized = args.map((a) => JSON.stringify(a)).join(", ");
  const code = `$._Kahamatic.${fnName}(${serialized})`;
  await ensureHostScriptLoaded(false);

  let raw: string;
  try {
    raw = await evalJsx(code);
  } catch (err: any) {
    if (String(err?.message || err).includes("EvalScript error")) {
      await ensureHostScriptLoaded(true);
      raw = await evalJsx(code);
    } else {
      throw err;
    }
  }

  if (!raw) {
    throw new Error(`Host function $._Kahamatic.${fnName} returned empty output`);
  }
  if (raw.startsWith("ERROR:")) {
    throw new Error(raw.slice(6).trim());
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return raw as unknown as T;
  }
}

export function spawnHelper<T = any>(
  command: string,
  inputPayload: unknown,
  onProgress?: (msg: string) => void
): Promise<T> {
  const fs = nodeRequire<typeof import("node:fs")>("fs");
  const os = nodeRequire<typeof import("node:os")>("os");
  const path = nodeRequire<typeof import("node:path")>("path");
  const cp = nodeRequire<typeof import("node:child_process")>("child_process");

  const bin = getHelperBinaryPath();
  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = os.tmpdir();
  const inPath = path.join(tmpDir, `kahamatic_in_${stamp}.json`);
  const outPath = path.join(tmpDir, `kahamatic_out_${stamp}.json`);

  fs.writeFileSync(inPath, JSON.stringify(inputPayload), "utf8");

  return new Promise((resolve, reject) => {
    const child = cp.spawn(bin, [command, inPath, outPath], {
      env: process.env,
    });
    let stderr = "";
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      const s = chunk.toString("utf8");
      stdout += s;
      if (onProgress) {
        for (const line of s.split(/\r?\n/)) {
          if (line.trim()) onProgress(line.trim());
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      try {
        fs.rmSync(inPath, { force: true });
        fs.rmSync(outPath, { force: true });
      } catch {
        // ignore
      }
      reject(err);
    });
    child.on("close", (code) => {
      try {
        if (code !== 0) {
          reject(new Error(`Helper '${command}' exited with ${code}: ${stderr || stdout}`));
          return;
        }
        const raw = fs.readFileSync(outPath, "utf8");
        resolve(JSON.parse(raw) as T);
      } catch (e: any) {
        reject(new Error(`Failed to read helper output for '${command}': ${e?.message || e}`));
      } finally {
        try {
          fs.rmSync(inPath, { force: true });
          fs.rmSync(outPath, { force: true });
        } catch {
          // ignore
        }
      }
    });
  });
}

export function runProcess(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const cp = nodeRequire<typeof import("node:child_process")>("child_process");
  return new Promise((resolve, reject) => {
    const child = cp.spawn(cmd, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
    child.stderr?.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

function isMacHost(): boolean {
  if (typeof process !== "undefined" && typeof process.platform === "string") {
    return process.platform === "darwin";
  }
  return typeof navigator !== "undefined" && /Mac/i.test(navigator.platform || navigator.userAgent || "");
}

export function readSystemClipboardText(): string {
  if (isCepEnvironment()) {
    try {
      const cp = nodeRequire<typeof import("node:child_process")>("child_process");
      const env = { ...process.env, LANG: process.env.LANG || "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
      if (isMacHost()) {
        return cp.execFileSync("/usr/bin/pbpaste", { encoding: "utf8", env });
      }
      if (process.platform === "win32") {
        return cp.execFileSync("powershell.exe", ["-NoProfile", "-Command", "Get-Clipboard -Raw"], {
          encoding: "utf8",
          env,
        });
      }
    } catch {
      // fall through
    }
  }
  return "";
}

export function writeSystemClipboardText(text: string): void {
  if (!isCepEnvironment()) return;
  try {
    const cp = nodeRequire<typeof import("node:child_process")>("child_process");
    const env = { ...process.env, LANG: process.env.LANG || "en_US.UTF-8", LC_ALL: "en_US.UTF-8" };
    if (isMacHost()) {
      cp.execFileSync("/usr/bin/pbcopy", { input: text, env });
    }
  } catch {
    // ignore
  }
}

export function installCepKeyboardShortcuts(): () => void {
  if (typeof window === "undefined") return () => {};

  const isMac = isMacHost();

  // Tell Premiere Pro not to swallow Cmd/Ctrl editing & clipboard keystrokes while panel is focused
  if (window.__adobe_cep__?.registerKeyEventsInterest) {
    try {
      const interests: Array<{
        keyCode: number;
        ctrlKey?: boolean;
        altKey?: boolean;
        shiftKey?: boolean;
        metaKey?: boolean;
      }> = [];

      if (isMac) {
        // Carbon Events.h virtual key codes: A=0, Z=6, X=7, C=8, V=9
        for (const keyCode of [0, 6, 7, 8, 9]) {
          interests.push({ keyCode, metaKey: true });
        }
        interests.push({ keyCode: 6, metaKey: true, shiftKey: true }); // Cmd+Shift+Z Redo

        // Editing/nav keys: Backspace=51, ForwardDelete=117, Left=123, Right=124, Down=125, Up=126, Return=36, Tab=48
        for (const keyCode of [51, 117, 123, 124, 125, 126, 36, 48]) {
          interests.push({ keyCode });
          interests.push({ keyCode, shiftKey: true });
          interests.push({ keyCode, altKey: true });
          interests.push({ keyCode, altKey: true, shiftKey: true });
          interests.push({ keyCode, metaKey: true });
          interests.push({ keyCode, metaKey: true, shiftKey: true });
        }
      } else {
        // Windows virtual key codes: A=65, C=67, V=86, X=88, Z=90
        for (const keyCode of [65, 67, 86, 88, 90]) {
          interests.push({ keyCode, ctrlKey: true });
        }
        interests.push({ keyCode: 90, ctrlKey: true, shiftKey: true });
      }

      window.__adobe_cep__.registerKeyEventsInterest(JSON.stringify(interests));
    } catch {
      // ignore on unsupported hosts
    }
  }

  if (!isCepEnvironment()) {
    return () => {};
  }

  const NON_TEXT_TYPES = new Set(["checkbox", "radio", "range", "color", "button", "file", "submit", "reset"]);

  const onKeyDown = (e: KeyboardEvent) => {
    const active = document.activeElement;
    if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
      return;
    }
    if (active instanceof HTMLInputElement && NON_TEXT_TYPES.has(active.type)) {
      return;
    }

    const isMod = isMac ? e.metaKey && !e.ctrlKey && !e.altKey : e.ctrlKey && !e.metaKey && !e.altKey;
    if (!isMod) return;

    const key = e.key.toLowerCase();
    const isPassword = active instanceof HTMLInputElement && active.type === "password";
    const isNumber = active instanceof HTMLInputElement && active.type === "number";

    if (key === "a") {
      e.preventDefault();
      e.stopPropagation();
      active.select();
      return;
    }

    if (key === "v") {
      if (active.readOnly || active.disabled) return;
      e.preventDefault();
      e.stopPropagation();
      const raw = readSystemClipboardText();
      if (!raw) return;

      if (isNumber) {
        active.value = raw.trim();
      } else {
        const clean = active instanceof HTMLInputElement ? raw.replace(/[\r\n]+/g, "") : raw.replace(/\r\n/g, "\n");
        const start = active.selectionStart ?? active.value.length;
        const end = active.selectionEnd ?? active.value.length;
        active.setRangeText(clean, start, end, "end");
      }
      active.dispatchEvent(new Event("input", { bubbles: true }));
      active.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    if (key === "c") {
      if (isPassword) return;
      e.preventDefault();
      e.stopPropagation();
      if (!isNumber) {
        const start = active.selectionStart ?? 0;
        const end = active.selectionEnd ?? 0;
        if (end > start) {
          writeSystemClipboardText(active.value.slice(start, end));
        }
      }
      return;
    }

    if (key === "x") {
      if (isPassword || active.readOnly || active.disabled || isNumber) return;
      e.preventDefault();
      e.stopPropagation();
      const start = active.selectionStart ?? 0;
      const end = active.selectionEnd ?? 0;
      if (end > start) {
        writeSystemClipboardText(active.value.slice(start, end));
        active.setRangeText("", start, end, "end");
        active.dispatchEvent(new Event("input", { bubbles: true }));
        active.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return;
    }

    if (key === "z") {
      e.preventDefault();
      e.stopPropagation();
      try {
        document.execCommand(e.shiftKey ? "redo" : "undo");
      } catch {
        // ignore
      }
    }
  };

  window.addEventListener("keydown", onKeyDown, true);
  return () => window.removeEventListener("keydown", onKeyDown, true);
}
