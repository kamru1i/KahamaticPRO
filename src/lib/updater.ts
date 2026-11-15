import { getExtensionRoot, isCepEnvironment, nodeRequire, runProcess } from "./cep-node";

export interface UpdateCheckResult {
  currentVersion: string;
  latestVersion: string;
  hasUpdate: boolean;
  downloadUrl: string;
  notes: string;
}

export function getInstalledVersion(): string {
  if (isCepEnvironment()) {
    try {
      const fs = nodeRequire<typeof import("node:fs")>("fs");
      const path = nodeRequire<typeof import("node:path")>("path");
      const manifestPath = path.join(getExtensionRoot(), "CSXS", "manifest.xml");
      const xml = fs.readFileSync(manifestPath, "utf8");
      const m = xml.match(/ExtensionBundleVersion="([^"]+)"/);
      if (m) return m[1];
    } catch {
      // fallback
    }
  }
  return "0.1.0";
}

export function compareSemver(a: string, b: string): number {
  const pa = a.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/i, "").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) return 1;
    if (da < db) return -1;
  }
  return 0;
}

function httpsGetBuffer(urlStr: string, headers: Record<string, string>, redirectsLeft = 5): Promise<Buffer> {
  const https = nodeRequire<typeof import("node:https")>("https");
  const u = new URL(urlStr);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: "GET",
        headers: {
          "User-Agent": "KahamaticPRO-Updater",
          ...headers,
        },
        timeout: 30000,
      },
      (res) => {
        const code = res.statusCode ?? 500;
        if (code >= 300 && code < 400 && res.headers.location && redirectsLeft > 0) {
          res.resume();
          const nextUrl = new URL(res.headers.location, urlStr).toString();
          const nextHeaders = { ...headers };
          // Strip Authorization header when redirected to GitHub S3 object storage
          if (new URL(nextUrl).hostname !== "api.github.com" && new URL(nextUrl).hostname !== "github.com") {
            delete nextHeaders.Authorization;
          }
          httpsGetBuffer(nextUrl, nextHeaders, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const buf = Buffer.concat(chunks);
          if (code >= 400) {
            reject(new Error(`HTTP ${code} from ${u.hostname}: ${buf.toString("utf8").slice(0, 200)}`));
            return;
          }
          resolve(buf);
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("Download timed out")));
    req.on("error", reject);
    req.end();
  });
}

function buildGithubHeaders(token: string, accept = "application/vnd.github+json"): Record<string, string> {
  const h: Record<string, string> = { Accept: accept };
  if (token.trim()) {
    h.Authorization = `Bearer ${token.trim()}`;
  }
  return h;
}

export async function checkForUpdates(githubRepo: string, githubToken = ""): Promise<UpdateCheckResult | null> {
  const repo = githubRepo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
  if (!repo || !repo.includes("/")) return null;

  const currentVersion = getInstalledVersion();
  const buf = await httpsGetBuffer(
    `https://api.github.com/repos/${repo}/releases/latest`,
    buildGithubHeaders(githubToken)
  );
  const rel = JSON.parse(buf.toString("utf8"));
  const latestTag = String(rel.tag_name || "").replace(/^v/i, "");
  if (!latestTag) return null;

  const assets: any[] = Array.isArray(rel.assets) ? rel.assets : [];
  const updateAsset =
    assets.find((a) => a.name === "KahamaticPRO-update.zip") ||
    assets.find((a) => String(a.name).endsWith("-update.zip"));

  if (!updateAsset) return null;

  // Use API asset URL when token is provided (required for private repo downloads)
  const downloadUrl = githubToken.trim()
    ? String(updateAsset.url)
    : String(updateAsset.browser_download_url);

  return {
    currentVersion,
    latestVersion: latestTag,
    hasUpdate: compareSemver(latestTag, currentVersion) > 0,
    downloadUrl,
    notes: String(rel.body || "").trim(),
  };
}

export async function installSelfUpdate(downloadUrl: string, githubToken = ""): Promise<void> {
  const fs = nodeRequire<typeof import("node:fs")>("fs");
  const os = nodeRequire<typeof import("node:os")>("os");
  const path = nodeRequire<typeof import("node:path")>("path");

  const extRoot = getExtensionRoot();
  const stamp = Date.now();
  const zipPath = path.join(os.tmpdir(), `kahamatic_update_${stamp}.zip`);
  const unpackDir = path.join(os.tmpdir(), `kahamatic_unpack_${stamp}`);

  try {
    const headers = buildGithubHeaders(
      githubToken,
      downloadUrl.includes("api.github.com") ? "application/octet-stream" : "*/*"
    );
    const zipBuf = await httpsGetBuffer(downloadUrl, headers);
    fs.writeFileSync(zipPath, zipBuf);
    fs.mkdirSync(unpackDir, { recursive: true });

    const unzipRes = await runProcess("/usr/bin/ditto", ["-x", "-k", zipPath, unpackDir]);
    if (unzipRes.code !== 0) {
      throw new Error(`ditto failed: ${unzipRes.stderr || unzipRes.stdout}`);
    }

    // Determine source root inside unpackDir (handles either flat zip or nested single folder)
    const entries = fs.readdirSync(unpackDir).filter((n) => !n.startsWith("."));
    let srcDir = unpackDir;
    if (entries.length === 1) {
      const candidate = path.join(unpackDir, entries[0]);
      if (fs.existsSync(path.join(candidate, "CSXS", "manifest.xml"))) {
        srcDir = candidate;
      }
    }
    if (!fs.existsSync(path.join(srcDir, "CSXS", "manifest.xml"))) {
      throw new Error("Update archive is missing CSXS/manifest.xml");
    }

    const cpRes = await runProcess("/usr/bin/ditto", [srcDir, extRoot]);
    if (cpRes.code !== 0) {
      throw new Error(`Failed copying update files: ${cpRes.stderr || cpRes.stdout}`);
    }

    const helperPath = path.join(extRoot, "bin", "kahamatic-helper");
    if (fs.existsSync(helperPath)) {
      fs.chmodSync(helperPath, 0o755);
      await runProcess("/usr/bin/xattr", ["-c", helperPath]).catch(() => {});
      await runProcess("/usr/bin/codesign", ["--force", "--sign", "-", helperPath]).catch(() => {});
    }
  } finally {
    fs.rmSync(zipPath, { force: true });
    fs.rmSync(unpackDir, { recursive: true, force: true });
  }
}
