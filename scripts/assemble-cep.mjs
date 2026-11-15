import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST_UI = path.join(ROOT, "dist");
const CEP_SRC = path.join(ROOT, "cep");
const OUT = path.join(ROOT, "dist-cep");

function validateEs3AsciiJsx(jsxPath) {
  const buf = fs.readFileSync(jsxPath);
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] > 0x7f) {
      throw new Error(`ExtendScript ES3 check failed: non-ASCII byte 0x${buf[i].toString(16)} at offset ${i} in ${jsxPath}`);
    }
  }
  const src = buf.toString("ascii");
  const forbidden = [
    { re: /\blet\s+[A-Za-z_$]/, name: "ES6 'let'" },
    { re: /\bconst\s+[A-Za-z_$]/, name: "ES6 'const'" },
    { re: /=>/, name: "ES6 arrow function '=>'" },
    { re: /`/, name: "ES6 template literal backtick" },
  ];
  for (const rule of forbidden) {
    const m = src.match(rule.re);
    if (m) {
      throw new Error(`ExtendScript ES3 check failed: found ${rule.name} (${m[0]}) in ${jsxPath}`);
    }
  }
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

function main() {
  if (!fs.existsSync(DIST_UI)) {
    throw new Error("dist/ does not exist. Run 'vite build' first.");
  }
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Copy compiled Vite UI into dist-cep/
  copyDir(DIST_UI, OUT);

  // 2. Copy static CEP assets (CSXS, .debug, jsx, templates, bin if present)
  copyDir(CEP_SRC, OUT);

  // 3. Validate index.html has file://-safe defer IIFE script and no type="module"
  const htmlPath = path.join(OUT, "index.html");
  let html = fs.readFileSync(htmlPath, "utf8");
  html = html
    .replace(/<script\s+type="module"\s+crossorigin\s+src="([^"]+)"\s*><\/script>/g, '<script defer src="$1"></script>')
    .replace(/<script\s+type="module"\s+src="([^"]+)"\s*><\/script>/g, '<script defer src="$1"></script>')
    .replace(/\s+crossorigin\b/g, "");
  if (html.includes('type="module"')) {
    throw new Error("dist-cep/index.html still contains type=\"module\", which fails under CEP file://!");
  }
  fs.writeFileSync(htmlPath, html, "utf8");

  // 4. Strictly validate ExtendScript JSX for ES3 & ASCII
  const jsxPath = path.join(OUT, "jsx", "hostscript.jsx");
  if (!fs.existsSync(jsxPath)) {
    throw new Error(`Missing required ExtendScript host file: ${jsxPath}`);
  }
  validateEs3AsciiJsx(jsxPath);

  // 5. Verify premiere_templates.json is present
  const tplPath = path.join(OUT, "templates", "premiere_templates.json");
  if (!fs.existsSync(tplPath)) {
    throw new Error(`Missing required Premiere templates JSON: ${tplPath}`);
  }

  console.log(`Assembled dist-cep/ successfully (ES3 JSX OK, file:// IIFE HTML OK, templates ${(fs.statSync(tplPath).size / 1024).toFixed(1)} KB).`);
}

main();
