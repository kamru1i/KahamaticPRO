import { nodeRequire } from "./cep-node";
import type { AudioPackManifestItem, LanguageHint } from "./types";

export interface GeminiSegmentDecision {
  seg_id: string;
  decision: "KEEP" | "BAD_TAKE" | "SPLIT";
  split_micro_idx?: number;
  reason?: string;
}

export function extractGeminiText(resp: any): string {
  const parts = resp?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts) || parts.length === 0) return "";
  const answer = parts
    .filter((p: any) => !p?.thought && typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("");
  if (answer.trim()) return answer.trim();
  const fallback = parts
    .filter((p: any) => typeof p?.text === "string")
    .map((p: any) => p.text)
    .join("");
  return fallback.trim();
}

function stripJsonFence(raw: string): string {
  const t = raw.trim();
  const m = t.match(/^```(?:json)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
  return m ? m[1].trim() : t;
}

function requestGeminiJson(
  method: "GET" | "POST",
  pathStr: string,
  apiKey: string,
  bodyObj?: unknown,
  timeoutMs = 120000
): Promise<any> {
  const https = nodeRequire<typeof import("node:https")>("https");
  const payload = bodyObj !== undefined ? JSON.stringify(bodyObj) : "";
  const headers: Record<string, string | number> = {
    "x-goog-api-key": apiKey.trim(),
  };
  if (method === "POST") {
    headers["Content-Type"] = "application/json";
    headers["Content-Length"] = Buffer.byteLength(payload);
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: pathStr,
        method,
        headers,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if ((res.statusCode ?? 500) >= 400) {
            reject(new Error(`Gemini HTTP ${res.statusCode}: ${text.slice(0, 400)}`));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e: any) {
            reject(new Error(`Invalid Gemini JSON response: ${e?.message || e}`));
          }
        });
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`Gemini request timed out after ${timeoutMs}ms`));
    });
    req.on("error", reject);
    if (method === "POST") {
      req.write(payload);
    }
    req.end();
  });
}

function postGeminiJson(
  model: string,
  apiKey: string,
  bodyObj: unknown,
  timeoutMs = 120000
): Promise<any> {
  const cleanModel = (model || "gemini-4-hydrogen").trim().replace(/^models\//, "");
  return requestGeminiJson(
    "POST",
    `/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent`,
    apiKey,
    bodyObj,
    timeoutMs
  );
}

async function withRetry<T>(fn: () => Promise<T>, maxAttempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      const msg = String(err?.message || err);
      const retryable = msg.includes("429") || msg.includes("503") || msg.includes("timed out");
      if (!retryable || attempt === maxAttempts) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr;
}

export async function listGeminiModels(apiKey: string): Promise<string[]> {
  if (!apiKey.trim()) {
    throw new Error("Enter your Gemini API Key first.");
  }
  const resp = await requestGeminiJson("GET", "/v1beta/models?pageSize=100", apiKey, undefined, 20000);
  const rawModels: any[] = Array.isArray(resp?.models) ? resp.models : [];
  const ids = rawModels
    .filter(
      (m) =>
        Array.isArray(m?.supportedGenerationMethods) &&
        m.supportedGenerationMethods.includes("generateContent")
    )
    .map((m) => String(m.name || "").replace(/^models\//, ""))
    .filter((id) => id.startsWith("gemini-"));

  const priority = ["gemini-4-hydrogen", "gemini-3.8-flash", "gemini-4-carbon", "gemini-4-argon"];
  const unique = Array.from(new Set(ids));
  unique.sort((a, b) => {
    const ia = priority.indexOf(a);
    const ib = priority.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return b.localeCompare(a);
  });
  return unique;
}

export async function testGeminiApiKey(apiKey: string, model = "gemini-4-hydrogen"): Promise<string> {
  if (!apiKey.trim()) {
    throw new Error("Gemini API Key is empty.");
  }
  const resp = await postGeminiJson(
    model,
    apiKey,
    {
      contents: [{ role: "user", parts: [{ text: "Reply with exact word OK." }] }],
      generationConfig: { temperature: 0 },
    },
    20000
  );
  return extractGeminiText(resp) || "OK";
}

export async function classifyAudioPackWithGemini(params: {
  apiKey: string;
  model: string;
  m4aPath: string;
  segments: AudioPackManifestItem[];
  languageHint: LanguageHint;
}): Promise<GeminiSegmentDecision[]> {
  const fs = nodeRequire<typeof import("node:fs")>("fs");
  const audioB64 = fs.readFileSync(params.m4aPath).toString("base64");

  const langLabel =
    params.languageHint === "bn"
      ? "Bengali with mixed English/technical terms"
      : params.languageHint === "en"
        ? "English"
        : "Bangla / English / Bilingual auto-detect";

  const slimManifest = params.segments.map((s) => ({
    seg_id: s.seg_id,
    dur: Number(s.dur.toFixed(2)),
    micros: s.micros.map((m) => ({
      micro_idx: m.micro_idx,
      gap_dur: Number(m.gap_dur.toFixed(2)),
      offset_sec: Number((m.tl_t - s.tl_start).toFixed(2)),
    })),
  }));

  const prompt = [
    `You are editing a raw spoken video lecture/monologue (${langLabel}).`,
    `This compact audio pack contains consecutive speech segments separated by brief 880Hz sine-wave beeps.`,
    `The ordered manifest of segments in this exact audio pack is:`,
    JSON.stringify(slimManifest),
    ``,
    `Classify EVERY seg_id in the manifest:`,
    `- "BAD_TAKE": false starts, aborted fragments, clear stumbles/fumbles, verbal slips followed by a clean re-recording in a later segment, or explicit retake markers ("sorry", "abar boli", etc.).`,
    `- "SPLIT": when the FIRST half of a segment is a false start/bad take and the SECOND half after one of its listed micro_idx pauses is clean (provide split_micro_idx).`,
    `- "KEEP": clean spoken content that moves the explanation forward.`,
    ``,
    `Be conservative when unsure: only mark BAD_TAKE/SPLIT when you are clearly confident the speaker restarted or stumbled.`,
    `Return JSON strictly matching: { "decisions": [ { "seg_id": "...", "decision": "KEEP"|"BAD_TAKE"|"SPLIT", "split_micro_idx": 0, "reason": "short note" } ] }.`,
  ].join("\n");

  const resp = await withRetry(() =>
    postGeminiJson(params.model, params.apiKey, {
      contents: [
        {
          role: "user",
          parts: [
            { inlineData: { mimeType: "audio/mp4", data: audioB64 } },
            { text: prompt },
          ],
        },
      ],
      generationConfig: {
        temperature: 0.1,
        responseMimeType: "application/json",
      },
    })
  );

  const rawText = stripJsonFence(extractGeminiText(resp)) || "{}";
  const parsed = JSON.parse(rawText);
  const decisions = Array.isArray(parsed?.decisions) ? parsed.decisions : [];
  return decisions.map((d: any) => ({
    seg_id: String(d.seg_id || ""),
    decision:
      d.decision === "BAD_TAKE" || d.decision === "SPLIT" ? d.decision : "KEEP",
    split_micro_idx: typeof d.split_micro_idx === "number" ? d.split_micro_idx : undefined,
    reason: typeof d.reason === "string" ? d.reason : "",
  }));
}
