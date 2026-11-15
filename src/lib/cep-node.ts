declare global {
  interface Window {
    __adobe_cep__?: {
      evalScript(script: string, callback?: (result: string) => void): void;
      getSystemPath(pathType: string): string;
      requestOpenExtension?(extensionId: string, params?: string): void;
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

export function callHostFn<T = any>(fnName: string, ...args: unknown[]): Promise<T> {
  const serialized = args.map((a) => JSON.stringify(a)).join(", ");
  const code = `$._Kahamatic.${fnName}(${serialized})`;
  return evalJsx(code).then((raw) => {
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
  });
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
