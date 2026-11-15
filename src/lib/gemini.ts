import { nodeRequire } from "./cep-node";
import type { AudioPackManifestItem, LanguageHint } from "./types";

export interface GeminiSegmentDecision {
  seg_id: string;
  decision: "KEEP" | "BAD_TAKE" | "SPLIT";
  split_micro_idx?: number;
  reason?: string;
}

function postGeminiJson(
  model: string,
  apiKey: string,
  bodyObj: unknown,
  timeoutMs = 120000
): Promise<any> {
  const https = nodeRequire<typeof import("node:https")>("https");
  const cleanModel = (model || "gemini-2.5-flash").trim();
  const payload = JSON.stringify(bodyObj);

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "generativelanguage.googleapis.com",
        path: `/v1beta/models/${encodeURIComponent(cleanModel)}:generateContent?key=${encodeURIComponent(apiKey.trim())}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
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
    req.write(payload);
    req.end();
  });
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

export async function testGeminiApiKey(apiKey: string, model = "gemini-2.5-flash"): Promise<string> {
  if (!apiKey.trim()) {
    throw new Error("Gemini API Key is empty.");
  }
  const resp = await postGeminiJson(
    model,
    apiKey,
    {
      contents: [{ role: "user", parts: [{ text: "Reply with exact word OK." }] }],
      generationConfig: { temperature: 0, maxOutputTokens: 16 },
    },
    20000
  );
  const txt = resp?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return txt.trim() || "OK";
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

  const rawText = resp?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
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
