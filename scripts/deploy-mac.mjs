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

  // Reload open KahamaticPRO CEP panel automatically via DevTools port 8947 if running
  const reloadPy = [
    "import json, urllib.request, socket, base64, struct",
    "try:",
    "    pages = json.loads(urllib.request.urlopen('http://127.0.0.1:8947/json', timeout=1).read().decode())",
    "    for p in pages:",
    "        if 'com.kahamatic.pro' in p.get('url', '') and p.get('webSocketDebuggerUrl'):",
    "            path = '/' + p['webSocketDebuggerUrl'].split('/', 3)[3]",
    "            s = socket.create_connection(('127.0.0.1', 8947), timeout=2)",
    "            k = base64.b64encode(b'kahamatic-reload').decode()",
    "            s.sendall(f'GET {path} HTTP/1.1\\r\\nHost: 127.0.0.1:8947\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Key: {k}\\r\\nSec-WebSocket-Version: 13\\r\\n\\r\\n'.encode())",
    "            buf = b''",
    "            while b'\\r\\n\\r\\n' not in buf: buf += s.recv(1024)",
    "            data = json.dumps({'id': 1, 'method': 'Page.reload', 'params': {'ignoreCache': True}}).encode()",
    "            mask = b'\\x12\\x34\\x56\\x78'",
    "            masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))",
    "            n = len(data)",
    "            hdr = bytearray([0x81, 0x80 | (n if n < 126 else 126)]) + (b'' if n < 126 else struct.pack('!H', n))",
    "            s.sendall(bytes(hdr) + mask + masked)",
    "            print('Reloaded live KahamaticPRO panel via CDP port 8947.')",
    "            break",
    "except Exception:",
    "    pass",
  ].join("\n");
  spawnSync("ssh", [MAC_HOST, "python3 -"], { input: reloadPy, stdio: ["pipe", "inherit", "inherit"] });

  console.log("Deployed KahamaticPRO to Mac successfully! Re-open Window > Extensions > KahamaticPRO in Premiere Pro.");
}

main();
