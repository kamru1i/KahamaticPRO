const utf8Enc = new TextEncoder();

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
  }
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(b64, "base64"));
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

export function parseHexRgb(hexColor: string): [number, number, number] {
  const clean = hexColor.replace(/^#/, "").trim();
  if (!/^[0-9a-fA-F]{6}$/.test(clean)) {
    return [244, 173, 0];
  }
  return [
    parseInt(clean.slice(0, 2), 16),
    parseInt(clean.slice(2, 4), 16),
    parseInt(clean.slice(4, 6), 16),
  ];
}

/**
 * Generates an Adobe Premiere Pro AE.ADBE Text `Source Text` FlatBuffer binary payload.
 * Preserves exact byte-for-byte parity with native Premiere FlatBuffers (M2-03/M2-10 h352)
 * while supporting arbitrary PostScript fonts, float32 font size, RGB hex colors, and UTF-8 text.
 */
export function buildTextFlatBuffer(
  word: string,
  fontPostScript: string,
  fontSize: number,
  hexColor: string,
  baseHeader352: Uint8Array
): Uint8Array {
  if (baseHeader352.length !== 352) {
    throw new Error(`Expected 352-byte base header, got ${baseHeader352.length}`);
  }
  const safeFont = fontPostScript.trim() || "BanglaMN-Bold";
  const fontUtf8 = utf8Enc.encode(safeFont);
  const fontPadLen = Math.floor((fontUtf8.length + 4) / 4) * 4;
  const delta = fontPadLen - 16;

  const wordUtf8 = utf8Enc.encode(word);
  const wordPadLen = Math.floor((wordUtf8.length + 4) / 4) * 4;

  const totalLen = 352 + delta + wordPadLen;
  const out = new Uint8Array(totalLen);
  const view = new DataView(out.buffer);

  // 1. Copy prefix bytes [0..176] and update root container size + style-run table offset
  out.set(baseHeader352.subarray(0, 176), 0);
  view.setUint32(0, 340 + delta + wordPadLen, true);
  view.setUint32(144, 52 + delta, true);

  // 2. Write PostScript font string (length + UTF-8 + 4-byte aligned zero padding)
  view.setUint32(176, fontUtf8.length, true);
  out.set(fontUtf8, 180);

  // 3. Copy style-run block baseHeader352[196..348] (152 bytes) at 180 + fontPadLen
  const blockStart = 180 + fontPadLen;
  out.set(baseHeader352.subarray(196, 348), blockStart);

  // 4. Write float32 fontSize at blockStart + 108 (offset 304 when delta == 0)
  const clampedSize = Math.max(8, Math.min(400, Number.isFinite(fontSize) ? fontSize : 80));
  view.setFloat32(blockStart + 108, clampedSize, true);

  // 5. Write RGB bytes [0x00, R, G, B] at blockStart + 148 (offset 344 when delta == 0)
  const [r, g, b] = parseHexRgb(hexColor);
  out[blockStart + 148] = 0x00;
  out[blockStart + 149] = r;
  out[blockStart + 150] = g;
  out[blockStart + 151] = b;

  // 6. Write UTF-8 word length + null-padded UTF-8 string
  const wordLenOff = 332 + fontPadLen;
  view.setUint32(wordLenOff, wordUtf8.length, true);
  out.set(wordUtf8, wordLenOff + 4);

  return out;
}
