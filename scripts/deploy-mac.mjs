import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_CEP = path.join(ROOT, "dist-cep");
const SWIFT_SRC = path.join(ROOT, "native", "KahamaticHelper.swift");
const MAC_HOST = process.env.KAHAMATIC_MAC_HOST || "kamrul@192.168.0.106";

function runOrThrow(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (res.status !== 0) {
    throw new Error(`Command failed (${cmd} ${args.join(" ")}): exit ${res.status}`);
  }
  return res;
}

function main() {
  if (!fs.existsSync(DIST_CEP)) {
    throw new Error("dist-cep/ missing. Run 'npm run build' first.");
  }
  if (!fs.existsSync(SWIFT_SRC)) {
    throw new Error(`Missing native Swift source: ${SWIFT_SRC}`);
  }

  console.log(`[1/4] Verifying SSH connectivity to ${MAC_HOST}...`);
  runOrThrow("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", MAC_HOST, "echo SSH_OK"]);

  console.log("[2/4] Archiving & streaming dist-cep/ over SSH (tar | ssh)...");
  const tarRes = spawnSync("tar", ["-cf", "-", "-C", DIST_CEP, "."], {
    maxBuffer: 64 * 1024 * 1024,
  });
  if (tarRes.status !== 0 || !tarRes.stdout || tarRes.stdout.length === 0) {
    const errText = tarRes.stderr ? tarRes.stderr.toString("utf8") : "";
    throw new Error(`Local tar failed (exit ${tarRes.status}): ${errText}`);
  }

  runOrThrow(
    "ssh",
    [
      MAC_HOST,
      'OLD_EXT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.kahamatik.pro" && EXT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.kahamatic.pro" && rm -rf "$OLD_EXT" "$EXT" && mkdir -p "$EXT/bin" "$EXT/native" && tar -xf - -C "$EXT"',
    ],
    {
      input: tarRes.stdout,
      stdio: ["pipe", "inherit", "inherit"],
    }
  );

  console.log("[3/4] Streaming native/KahamaticHelper.swift to Mac...");
  const swiftBytes = fs.readFileSync(SWIFT_SRC);
  runOrThrow(
    "ssh",
    [
      MAC_HOST,
      'EXT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.kahamatic.pro" && cat > "$EXT/native/KahamaticHelper.swift"',
    ],
    {
      input: swiftBytes,
      stdio: ["pipe", "inherit", "inherit"],
    }
  );

  console.log("[4/4] Enabling CSXS PlayerDebugMode, compiling swiftc -O, signing, and verifying...");
  runOrThrow("ssh", [
    MAC_HOST,
    [
      'EXT="$HOME/Library/Application Support/Adobe/CEP/extensions/com.kahamatic.pro"',
      'for v in 9 10 11 12 13 14; do defaults write com.adobe.CSXS.$v PlayerDebugMode 1 >/dev/null 2>&1 || true; done',
      'swiftc -O "$EXT/native/KahamaticHelper.swift" -o "$EXT/bin/kahamatic-helper"',
      'chmod 755 "$EXT/bin/kahamatic-helper"',
      'xattr -c "$EXT/bin/kahamatic-helper" || true',
      'codesign --force --sign - "$EXT/bin/kahamatic-helper"',
      '"$EXT/bin/kahamatic-helper" list-fonts /tmp/_kahamatic_deploy_check.json',
      "rm -f /tmp/_kahamatic_deploy_check.json",
    ].join(" && "),
  ]);

  console.log("Deployed KahamaticPRO to Mac successfully! Re-open Window > Extensions > KahamaticPRO in Premiere Pro.");
}

main();
