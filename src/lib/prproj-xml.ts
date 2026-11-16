import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import templatesData from "../../cep/templates/premiere_templates.json";
import { nodeRequire } from "./cep-node";
import { buildTextFlatBuffer, bytesToBase64, hexToBytes } from "./flatbuffer-text";
import type {
  AlignedWordBox,
  BadgeSegmentSpec,
  CameraClipMove,
  CameraSegmentSpec,
  KineticStyle,
  Phase1CutPlanItem,
} from "./types";

export const TICKS_PER_SEC = 254016000000n;
export const SYNTHETIC_ORIGIN = 914457600000000n;

export interface PremiereTemplates {
  h352BaseHex: string;
  emptyVideoTrack: string;
  text: {
    trackItem: string;
    componentChain: string;
    geom2: string;
    geom2Params: string[];
    dropShadow: string;
    dropShadowParams: string[];
    textComp: string;
    textParams: string[];
    subClip: string;
    videoClip: string;
    videoMediaSource: string;
    masterClip: string;
    loggingInfo: string;
    audioClipChannelGroups: string;
    masterClipItem: string;
    media: string;
    videoStream: string;
  };
  badge: {
    trackItem: string;
    componentChain: string;
    opacity: string;
    opacityParams: string[];
    motion: string;
    motionParams: string[];
    subClip: string;
    videoClip: string;
    videoMediaSource: string;
    masterClip: string;
    loggingInfo: string;
    audioClipChannelGroups: string;
    masterClipItem: string;
    markers: string;
    media: string;
    videoStream: string;
    clipProjectItem: string;
  };
}

const TEMPLATES = templatesData as PremiereTemplates;
const BASE_H352_BYTES = hexToBytes(TEMPLATES.h352BaseHex);

// Element node helpers over @xmldom/xmldom
function isElement(n: Node | null | undefined): n is Element {
  return Boolean(n && n.nodeType === 1);
}

function childElements(el: Element, tagName?: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (isElement(c) && (!tagName || c.tagName === tagName)) {
      out.push(c);
    }
  }
  return out;
}

function findFirstDescendant(el: Element, tagName: string): Element | null {
  const list = el.getElementsByTagName(tagName);
  return list.length > 0 ? list[0] : null;
}

function findByPath(el: Element, ...tags: string[]): Element | null {
  let cur: Element | null = el;
  for (let idx = 0; idx < tags.length; idx++) {
    if (!cur) return null;
    const tag = tags[idx];
    const direct = childElements(cur, tag);
    if (direct.length > 0) {
      cur = direct[0];
    } else {
      cur = findFirstDescendant(cur, tag);
    }
  }
  return cur;
}

function getText(el: Element | null, tagName?: string): string {
  if (!el) return "";
  const target = tagName ? findFirstDescendant(el, tagName) : el;
  return (target?.textContent ?? "").trim();
}

function setText(el: Element, value: string): void {
  el.textContent = value;
}

function stripBinaryHash(el: Element): void {
  if (el.hasAttribute("BinaryHash")) {
    el.removeAttribute("BinaryHash");
  }
  for (let i = 0; i < el.childNodes.length; i++) {
    const c = el.childNodes[i];
    if (isElement(c)) stripBinaryHash(c);
  }
}

export function fmtKfNum(v: number): string {
  if (Math.abs(v) < 1e-12) return "0";
  if (Math.abs(v - Math.round(v)) < 1e-9) return `${Math.round(v)}.`;
  return String(v);
}

export function secToFrameTicks(sec: number, frameTicks: bigint): bigint {
  const fpsApprox = Number(TICKS_PER_SEC) / Number(frameTicks);
  const frames = BigInt(Math.round(sec * fpsApprox));
  return frames * frameTicks;
}

export function frameToTicks(frame: number, frameTicks: bigint): bigint {
  return BigInt(frame) * frameTicks;
}

export class PrprojDocument {
  public readonly doc: Document;
  public readonly root: Element;
  public readonly oid = new Map<string, Element>();
  public readonly uid = new Map<string, Element>();
  private maxOid = 0;
  private readonly newElements: Element[] = [];
  private readonly addedTopSet = new Set<Element>();
  private readonly baselineDangling = new Set<string>();
  private readonly parser = new DOMParser();

  constructor(xmlString: string) {
    this.doc = this.parser.parseFromString(xmlString, "text/xml");
    this.root = this.doc.documentElement;
    for (let i = 0; i < this.root.childNodes.length; i++) {
      const node = this.root.childNodes[i];
      if (!isElement(node)) continue;
      const o = node.getAttribute("ObjectID");
      if (o) {
        this.oid.set(o, node);
        const n = parseInt(o, 10);
        if (Number.isFinite(n) && n > this.maxOid) this.maxOid = n;
      }
      const u = node.getAttribute("ObjectUID");
      if (u) {
        this.uid.set(u, node);
      }
    }

    const collectBaselineDangling = (el: Element): void => {
      const refId = el.getAttribute("ObjectRef");
      if (refId && !this.oid.has(refId)) {
        this.baselineDangling.add(`ref:${el.tagName}:${refId}`);
      }
      const urefId = el.getAttribute("ObjectURef");
      if (urefId && !this.uid.has(urefId)) {
        this.baselineDangling.add(`uref:${el.tagName}:${urefId}`);
      }
      for (let i = 0; i < el.childNodes.length; i++) {
        const c = el.childNodes[i];
        if (isElement(c)) collectBaselineDangling(c);
      }
    };
    collectBaselineDangling(this.root);
  }

  allocOid(): string {
    this.maxOid += 1;
    const s = String(this.maxOid);
    return s;
  }

  newUid(): string {
    const crypto = nodeRequire<typeof import("node:crypto")>("crypto");
    while (true) {
      const u = crypto.randomUUID();
      if (!this.uid.has(u)) {
        return u;
      }
    }
  }

  importXml(xmlSnippet: string): Element {
    const frag = this.parser.parseFromString(xmlSnippet, "text/xml").documentElement;
    return this.doc.importNode(frag, true) as Element;
  }

  registerTopElement(el: Element): void {
    const o = el.getAttribute("ObjectID");
    if (o) {
      this.oid.set(o, el);
      const n = parseInt(o, 10);
      if (Number.isFinite(n) && n > this.maxOid) this.maxOid = n;
    }
    const u = el.getAttribute("ObjectUID");
    if (u) {
      this.uid.set(u, el);
    }
    this.addedTopSet.add(el);
    this.newElements.push(el);
  }

  flushNewElements(): void {
    for (const el of this.newElements) {
      this.root.appendChild(el);
    }
    this.newElements.length = 0;
  }

  findSequenceGroups(sequenceUid: string): {
    sequence: Element;
    videoTrackGroup: Element;
    audioTrackGroup: Element | null;
  } {
    let seq = this.uid.get(sequenceUid);
    if (!seq) {
      for (const el of this.uid.values()) {
        if (el.tagName === "Sequence") {
          seq = el;
          break;
        }
      }
    }
    if (!seq) {
      throw new Error(`Target Sequence ObjectUID='${sequenceUid}' not found in .prproj XML`);
    }
    const tgs = findFirstDescendant(seq, "TrackGroups");
    if (!tgs) throw new Error("Sequence is missing TrackGroups");
    let vtg: Element | null = null;
    let atg: Element | null = null;
    const refs = tgs.getElementsByTagName("Second");
    for (let i = 0; i < refs.length; i++) {
      const refId = refs[i].getAttribute("ObjectRef");
      if (!refId) continue;
      const grp = this.oid.get(refId);
      if (!grp) continue;
      if (grp.tagName === "VideoTrackGroup" && !vtg) vtg = grp;
      if (grp.tagName === "AudioTrackGroup" && !atg) atg = grp;
    }
    if (!vtg) {
      throw new Error(`VideoTrackGroup not found under Sequence ${sequenceUid}`);
    }
    return { sequence: seq, videoTrackGroup: vtg, audioTrackGroup: atg };
  }

  getVideoTracks(videoTrackGroup: Element): Array<{ trackNum: number; trackRefEl: Element; trackEl: Element }> {
    const tracksEl = findByPath(videoTrackGroup, "TrackGroup", "Tracks") || findFirstDescendant(videoTrackGroup, "Tracks");
    if (!tracksEl) throw new Error("VideoTrackGroup missing Tracks element");
    const refs = childElements(tracksEl, "Track");
    return refs.map((refEl, idx) => {
      const uref = refEl.getAttribute("ObjectURef") || "";
      const trEl = this.uid.get(uref);
      if (!trEl) throw new Error(`Dangling VideoTrack ObjectURef='${uref}'`);
      return { trackNum: idx + 1, trackRefEl: refEl, trackEl: trEl };
    });
  }

  ensureVideoTrackCount(videoTrackGroup: Element, desiredCount: number): Element[] {
    const tracksParent =
      findByPath(videoTrackGroup, "TrackGroup", "Tracks") || findFirstDescendant(videoTrackGroup, "Tracks");
    if (!tracksParent) throw new Error("Missing Tracks container in VideoTrackGroup");
    const nextTrackIdEl = findFirstDescendant(videoTrackGroup, "NextTrackID");

    const existing = this.getVideoTracks(videoTrackGroup);
    while (existing.length < desiredCount) {
      const nextNum = existing.length + 1;
      const newTrack = this.importXml(TEMPLATES.emptyVideoTrack);
      const newUid = this.newUid();
      newTrack.setAttribute("ObjectUID", newUid);

      const idEl = findByPath(newTrack, "Track", "ID");
      if (idEl) setText(idEl, String(nextNum));
      const idxEl = findByPath(newTrack, "Track", "Index");
      if (idxEl) setText(idxEl, String(nextNum - 1));
      const ciIdx = findByPath(newTrack, "ClipItems", "Index");
      if (ciIdx) setText(ciIdx, String(nextNum - 1));
      const tiIdx = findByPath(newTrack, "TransitionItems", "Index");
      if (tiIdx) setText(tiIdx, String(nextNum - 1));

      this.registerTopElement(newTrack);
      const refEl = this.doc.createElement("Track");
      refEl.setAttribute("Index", String(nextNum - 1));
      refEl.setAttribute("ObjectURef", newUid);
      tracksParent.appendChild(refEl);
      existing.push({ trackNum: nextNum, trackRefEl: refEl, trackEl: newTrack });
    }

    if (nextTrackIdEl) {
      const curNext = parseInt(getText(nextTrackIdEl) || "1", 10);
      if (curNext <= desiredCount) {
        setText(nextTrackIdEl, String(desiredCount + 1));
      }
    }
    return existing.map((t) => t.trackEl);
  }

  ensureTrackItemsContainer(trackEl: Element): Element {
    const ci = findFirstDescendant(trackEl, "ClipItems");
    if (!ci) throw new Error("VideoTrack missing ClipItems element");
    let tis = childElements(ci, "TrackItems")[0] || null;
    if (!tis) {
      tis = this.doc.createElement("TrackItems");
      tis.setAttribute("Version", "1");
      if (ci.firstChild) {
        ci.insertBefore(tis, ci.firstChild);
      } else {
        ci.appendChild(tis);
      }
    }
    return tis;
  }

  getTrackItemIntervals(trackEl: Element): Array<{ start: bigint; end: bigint; itemEl: Element }> {
    const tis = findFirstDescendant(trackEl, "TrackItems");
    if (!tis) return [];
    const refs = childElements(tis, "TrackItem");
    const out: Array<{ start: bigint; end: bigint; itemEl: Element }> = [];
    for (const r of refs) {
      const refId = r.getAttribute("ObjectRef") || "";
      const itemEl = this.oid.get(refId);
      if (!itemEl) continue;
      const ti =
        findByPath(itemEl, "ClipTrackItem", "TrackItem") ||
        findByPath(itemEl, "TransitionTrackItem", "TrackItem") ||
        findFirstDescendant(itemEl, "TrackItem");
      if (!ti) continue;
      const start = BigInt(getText(ti, "Start") || "0");
      const end = BigInt(getText(ti, "End") || "0");
      out.push({ start, end, itemEl });
    }
    return out;
  }

  setParamStatic(paramEl: Element, startKfText: string): void {
    const tv = findFirstDescendant(paramEl, "IsTimeVarying");
    if (tv) setText(tv, "false");
    const kf = findFirstDescendant(paramEl, "Keyframes");
    if (kf && kf.parentNode) {
      kf.parentNode.removeChild(kf);
    }
    let sk = findFirstDescendant(paramEl, "StartKeyframe");
    if (!sk) {
      sk = this.doc.createElement("StartKeyframe");
      paramEl.appendChild(sk);
    }
    setText(sk, startKfText);
  }

  setParamTimeVarying(paramEl: Element, keyframesText: string): void {
    let tv = findFirstDescendant(paramEl, "IsTimeVarying");
    if (!tv) {
      tv = this.doc.createElement("IsTimeVarying");
      const nameEl = findFirstDescendant(paramEl, "Name");
      if (nameEl && nameEl.nextSibling) {
        paramEl.insertBefore(tv, nameEl.nextSibling);
      } else {
        paramEl.appendChild(tv);
      }
    }
    setText(tv, "true");

    let kf = findFirstDescendant(paramEl, "Keyframes");
    if (!kf) {
      kf = this.doc.createElement("Keyframes");
      const sk = findFirstDescendant(paramEl, "StartKeyframe");
      if (sk && sk.nextSibling) {
        paramEl.insertBefore(kf, sk.nextSibling);
      } else {
        paramEl.appendChild(kf);
      }
    }
    setText(kf, keyframesText);
  }

  validateIntegrity(): { topOidCount: number; topUidCount: number } {
    this.flushNewElements();
    const seenOids = new Set<string>();
    const seenUids = new Set<string>();

    for (let i = 0; i < this.root.childNodes.length; i++) {
      const node = this.root.childNodes[i];
      if (!isElement(node)) continue;
      const o = node.getAttribute("ObjectID");
      if (o) {
        if (seenOids.has(o)) throw new Error(`Duplicate top-level ObjectID='${o}'`);
        seenOids.add(o);
      }
      const u = node.getAttribute("ObjectUID");
      if (u) {
        if (seenUids.has(u)) throw new Error(`Duplicate top-level ObjectUID='${u}'`);
        seenUids.add(u);
      }
    }

    const verifyRefs = (el: Element, insideAddedTop: boolean): void => {
      const refId = el.getAttribute("ObjectRef");
      if (refId && !seenOids.has(refId)) {
        if (insideAddedTop || !this.baselineDangling.has(`ref:${el.tagName}:${refId}`)) {
          throw new Error(`Dangling ObjectRef='${refId}' in <${el.tagName}>`);
        }
      }
      const urefId = el.getAttribute("ObjectURef");
      if (urefId && !seenUids.has(urefId)) {
        if (insideAddedTop || !this.baselineDangling.has(`uref:${el.tagName}:${urefId}`)) {
          throw new Error(`Dangling ObjectURef='${urefId}' in <${el.tagName}>`);
        }
      }
      for (let i = 0; i < el.childNodes.length; i++) {
        const c = el.childNodes[i];
        if (isElement(c)) {
          const childInsideAdded = insideAddedTop || (el === this.root && this.addedTopSet.has(c));
          verifyRefs(c, childInsideAdded);
        }
      }
    };
    verifyRefs(this.root, false);

    return { topOidCount: seenOids.size, topUidCount: seenUids.size };
  }

  serialize(): string {
    this.flushNewElements();
    const raw = new XMLSerializer().serializeToString(this.doc);
    if (raw.startsWith("<?xml")) return raw;
    return `<?xml version="1.0" encoding="UTF-8" ?>\n${raw}`;
  }
}

// =========================================================================
// 1. Universal Multi-Style Kinetic Text Injector
// =========================================================================

export interface InjectKineticTextOptions {
  sequenceId: string;
  frameWidth: number;
  frameHeight: number;
  frameTicks: bigint;
  style: KineticStyle;
  fontPostScript: string;
  defaultFontSize: number;
  defaultColorHex: string;
  words: AlignedWordBox[];
  minTrackNum?: number; // Default 2 (V2)
}

export function allocateFreeTracksForPhrase(
  doc: PrprojDocument,
  videoTrackGroup: Element,
  wordIntervals: Array<{ start: bigint; end: bigint }>,
  minTrackNum = 2
): number[] {
  const existingTracks = doc.getVideoTracks(videoTrackGroup);
  const trackOccupancy = new Map<number, Array<{ start: bigint; end: bigint }>>();
  for (const t of existingTracks) {
    trackOccupancy.set(
      t.trackNum,
      doc.getTrackItemIntervals(t.trackEl).map((iv) => ({ start: iv.start, end: iv.end }))
    );
  }

  const assigned: number[] = [];
  for (const w of wordIntervals) {
    let candidate = Math.max(2, minTrackNum);
    while (true) {
      const occ = trackOccupancy.get(candidate) || [];
      const overlaps = occ.some((iv) => w.start < iv.end && w.end > iv.start);
      if (!overlaps) {
        occ.push({ start: w.start, end: w.end });
        trackOccupancy.set(candidate, occ);
        assigned.push(candidate);
        break;
      }
      candidate += 1;
    }
  }
  const maxNeeded = Math.max(...assigned, existingTracks.length);
  doc.ensureVideoTrackCount(videoTrackGroup, maxNeeded);
  return assigned;
}

function build8StepScalarKf(
  timesTicks: bigint[],
  values: number[],
  ticksPerSecNum = Number(TICKS_PER_SEC)
): string {
  const parts: string[] = [];
  const n = timesTicks.length;
  for (let i = 0; i < n; i++) {
    const ti = timesTicks[i];
    const si = values[i];
    const inS = i > 0 ? (si - values[i - 1]) / (Number(ti - timesTicks[i - 1]) / ticksPerSecNum) : 0;
    const outS = i + 1 < n ? (values[i + 1] - si) / (Number(timesTicks[i + 1] - ti) / ticksPerSecNum) : 0;
    parts.push(`${ti},${fmtKfNum(si)},0,0,${fmtKfNum(inS)},0.16666666666666666,${fmtKfNum(outS)},0.16666666666666666`);
  }
  return parts.join(";") + ";";
}

function buildLinearSlidePosKf(
  tStart: bigint,
  tEnd: bigint,
  p0: [number, number],
  p1: [number, number],
  steps = 8
): string {
  const ptsT: bigint[] = [];
  const ptsP: Array<[number, number]> = [];
  const dt = Number(tEnd - tStart);
  for (let k = 0; k <= steps; k++) {
    const u = k / steps;
    // Cubic ease-out: 1 - (1-u)^3 for crisp whip stop
    const e = 1 - Math.pow(1 - u, 3);
    ptsT.push(tStart + BigInt(Math.round(dt * u)));
    ptsP.push([p0[0] + (p1[0] - p0[0]) * e, p0[1] + (p1[1] - p0[1]) * e]);
  }
  const ticksPerSecNum = Number(TICKS_PER_SEC);
  const parts: string[] = [];
  for (let i = 0; i < ptsT.length; i++) {
    const [xi, yi] = ptsP[i];
    const inSpd =
      i > 0
        ? Math.hypot(xi - ptsP[i - 1][0], yi - ptsP[i - 1][1]) /
          (Number(ptsT[i] - ptsT[i - 1]) / ticksPerSecNum)
        : 0;
    const outSpd =
      i + 1 < ptsT.length
        ? Math.hypot(ptsP[i + 1][0] - xi, ptsP[i + 1][1] - yi) /
          (Number(ptsT[i + 1] - ptsT[i]) / ticksPerSecNum)
        : 0;
    parts.push(
      `${ptsT[i]},${fmtKfNum(xi)}:${fmtKfNum(yi)},0,0,${fmtKfNum(inSpd)},0.16666666666666666,${fmtKfNum(outSpd)},0.16666666666666666,5,4,0,0,0,0`
    );
  }
  return parts.join(";") + ";";
}

export function injectKineticTextPhrase(
  doc: PrprojDocument,
  opts: InjectKineticTextOptions
): { insertedCount: number; tracksUsed: number[] } {
  if (opts.words.length === 0) {
    return { insertedCount: 0, tracksUsed: [] };
  }
  const { videoTrackGroup } = doc.findSequenceGroups(opts.sequenceId);

  const intervals = opts.words.map((w) => {
    const st = secToFrameTicks(w.startSec, opts.frameTicks);
    const en = secToFrameTicks(w.endSec, opts.frameTicks);
    if (en <= st) throw new Error(`Word '${w.word}' has non-positive frame duration`);
    return { start: st, end: en };
  });

  const assignedTracks = allocateFreeTracksForPhrase(
    doc,
    videoTrackGroup,
    intervals,
    opts.minTrackNum ?? 2
  );
  const allTracks = doc.getVideoTracks(videoTrackGroup);
  const frameRectStr = `0,0,${opts.frameWidth},${opts.frameHeight}`;

  const txtT = TEMPLATES.text;
  const crypto = nodeRequire<typeof import("node:crypto")>("crypto");

  for (let idx = 0; idx < opts.words.length; idx++) {
    const w = opts.words[idx];
    const stTicks = intervals[idx].start;
    const enTicks = intervals[idx].end;
    const durTicks = enTicks - stTicks;
    const trkNum = assignedTracks[idx];
    const trackEl = allTracks[trkNum - 1].trackEl;
    const trackItemsList = doc.ensureTrackItemsContainer(trackEl);
    const nextItemIndex = childElements(trackItemsList, "TrackItem").length;

    const fontSize = w.fontSize ?? opts.defaultFontSize;
    const colorHex = w.colorHex ?? opts.defaultColorHex;
    const rawH352 = buildTextFlatBuffer(
      w.word,
      opts.fontPostScript,
      fontSize,
      colorHex,
      BASE_H352_BYTES
    );
    const b64H352 = bytesToBase64(rawH352);
    const bhRand = crypto.randomBytes(10).toString("hex");
    const lenHex = (rawH352.length + 12).toString(16).padStart(8, "0");
    const bhStr = `${bhRand.slice(0, 8)}-${bhRand.slice(8, 12)}-${bhRand.slice(12, 16)}-${bhRand.slice(16, 20)}-${crypto.randomBytes(2).toString("hex")}${lenHex}`;

    // 1. AE.ADBE Geometry2 keyframes based on chosen kinetic style
    const g2El = doc.importXml(txtT.geom2);
    const g2Oid = doc.allocOid();
    g2El.setAttribute("ObjectID", g2Oid);
    const g2RefNodes = g2El.getElementsByTagName("Param");
    const g2ParamEls: Element[] = [];

    const maxAnimTicks = durTicks - 2n * opts.frameTicks;
    const clampAnimTicks = (frames: number) => {
      const target = BigInt(frames) * opts.frameTicks;
      const minT = 4n * opts.frameTicks;
      if (maxAnimTicks < minT) return durTicks > 2n * opts.frameTicks ? durTicks - opts.frameTicks : durTicks;
      return target <= maxAnimTicks ? target : maxAnimTicks;
    };

    for (let pidx = 0; pidx < txtT.geom2Params.length; pidx++) {
      const pe = doc.importXml(txtT.geom2Params[pidx]);
      const pOid = doc.allocOid();
      pe.setAttribute("ObjectID", pOid);
      g2RefNodes[pidx].setAttribute("ObjectRef", pOid);

      if (opts.style === "clean-rise") {
        const riseTicks = clampAnimTicks(14);
        const riseEnd = SYNTHETIC_ORIGIN + riseTicks;
        if (pidx === 1) {
          doc.setParamTimeVarying(
            pe,
            `${SYNTHETIC_ORIGIN},0.5:0.64814811944961548,5,0,0,0.16666666666666666,0,0.79127725845582986,5,4,0,0,0,-0.024691353241602581;` +
              `${riseEnd},0.5:0.5,5,0,0,0.92211837991940038,0,0.16666666666666666,5,4,0,0,0,0;`
          );
        } else if (pidx === 8) {
          doc.setParamTimeVarying(
            pe,
            `${SYNTHETIC_ORIGIN},0.,5,0,0,0.16666666666666666,0,0.75856697808993723;` +
              `${riseEnd},100.,5,0,0,0.85669781918761512,0,0.16666666666666666;`
          );
        }
      } else if (opts.style === "pop-bounce" || opts.style === "kinetic-stack") {
        const anchorStr = `-91445760000000000,${w.posX}:${w.posY},0,0,0,0,0,0,5,4,0,0,0,0`;
        const popTicks = clampAnimTicks(opts.style === "pop-bounce" ? 10 : 8);
        const fadeTicks = clampAnimTicks(5);
        if (pidx === 0 || pidx === 1) {
          doc.setParamStatic(pe, anchorStr);
        } else if (pidx === 3) {
          // Uniform Scale Height overshoot: 58 -> 112 -> 97 -> 100
          const pts: Array<[bigint, number]> = [
            [SYNTHETIC_ORIGIN, opts.style === "pop-bounce" ? 58 : 65],
            [SYNTHETIC_ORIGIN + (popTicks * 45n) / 100n, 108],
            [SYNTHETIC_ORIGIN + (popTicks * 70n) / 100n, 112],
            [SYNTHETIC_ORIGIN + (popTicks * 88n) / 100n, 98],
            [SYNTHETIC_ORIGIN + popTicks, 100],
          ];
          doc.setParamTimeVarying(
            pe,
            build8StepScalarKf(
              pts.map((p) => p[0]),
              pts.map((p) => p[1])
            )
          );
        } else if (pidx === 8) {
          const fadeEnd = SYNTHETIC_ORIGIN + fadeTicks;
          doc.setParamTimeVarying(
            pe,
            `${SYNTHETIC_ORIGIN},0.,0,0,0,0.16666666666666666,300,0.16666666666666666;` +
              `${fadeEnd},100.,0,0,300,0.16666666666666666,0,0.16666666666666666;`
          );
        }
      } else if (opts.style === "slide-whip") {
        const slideTicks = clampAnimTicks(10);
        const slideEnd = SYNTHETIC_ORIGIN + slideTicks;
        const fadeEnd = SYNTHETIC_ORIGIN + clampAnimTicks(5);
        if (pidx === 0) {
          doc.setParamStatic(pe, `-91445760000000000,${w.posX}:${w.posY},0,0,0,0,0,0,5,4,0,0,0,0`);
        } else if (pidx === 1) {
          doc.setParamTimeVarying(
            pe,
            buildLinearSlidePosKf(SYNTHETIC_ORIGIN, slideEnd, [w.posX - 0.09, w.posY], [w.posX, w.posY], 8)
          );
        } else if (pidx === 5) {
          doc.setParamTimeVarying(
            pe,
            build8StepScalarKf(
              [SYNTHETIC_ORIGIN, SYNTHETIC_ORIGIN + (slideTicks * 60n) / 100n, slideEnd],
              [-11, -3, 0]
            )
          );
        } else if (pidx === 8) {
          doc.setParamTimeVarying(
            pe,
            `${SYNTHETIC_ORIGIN},0.,0,0,0,0.16666666666666666,300,0.16666666666666666;` +
              `${fadeEnd},100.,0,0,300,0.16666666666666666,0,0.16666666666666666;`
          );
        } else if (pidx === 10) {
          doc.setParamStatic(pe, "-91445760000000000,180.,0,0,0,0,0,0");
        }
      }
      g2ParamEls.push(pe);
    }

    // 2. AE.ADBE Drop Shadow
    const dsEl = doc.importXml(txtT.dropShadow);
    const dsOid = doc.allocOid();
    dsEl.setAttribute("ObjectID", dsOid);
    const dsRefs = dsEl.getElementsByTagName("Param");
    const dsParamEls: Element[] = [];
    for (let pidx = 0; pidx < txtT.dropShadowParams.length; pidx++) {
      const pe = doc.importXml(txtT.dropShadowParams[pidx]);
      const pOid = doc.allocOid();
      pe.setAttribute("ObjectID", pOid);
      dsRefs[pidx].setAttribute("ObjectRef", pOid);
      dsParamEls.push(pe);
    }

    // 3. AE.ADBE Text
    const tcEl = doc.importXml(txtT.textComp);
    const tcOid = doc.allocOid();
    tcEl.setAttribute("ObjectID", tcOid);
    const instEl = findFirstDescendant(tcEl, "InstanceName");
    if (instEl) setText(instEl, w.word);
    const tcRefs = tcEl.getElementsByTagName("Param");
    const tcParamEls: Element[] = [];
    for (let pidx = 0; pidx < txtT.textParams.length; pidx++) {
      const pe = doc.importXml(txtT.textParams[pidx]);
      const pOid = doc.allocOid();
      pe.setAttribute("ObjectID", pOid);
      tcRefs[pidx].setAttribute("ObjectRef", pOid);
      if (pidx === 0) {
        const skv = findFirstDescendant(pe, "StartKeyframeValue");
        if (skv) {
          skv.setAttribute("BinaryHash", bhStr);
          setText(skv, b64H352);
        }
      } else if (pidx === 2) {
        const sk = findFirstDescendant(pe, "StartKeyframe");
        if (sk) {
          setText(sk, `-91445760000000000,${w.posX}:${w.posY},0,0,0,0,0,0,5,4,0,0,0,0`);
        }
      }
      tcParamEls.push(pe);
    }

    // 4. ComponentChain + Synthetic Media + SubClip + TrackItem
    const chEl = doc.importXml(txtT.componentChain);
    const chOid = doc.allocOid();
    chEl.setAttribute("ObjectID", chOid);
    const chComps = chEl.getElementsByTagName("Component");
    chComps[0].setAttribute("ObjectRef", g2Oid);
    chComps[1].setAttribute("ObjectRef", dsOid);
    chComps[2].setAttribute("ObjectRef", tcOid);

    const vsEl = doc.importXml(txtT.videoStream);
    const vsOid = doc.allocOid();
    vsEl.setAttribute("ObjectID", vsOid);
    const frVs = findFirstDescendant(vsEl, "FrameRect");
    if (frVs) setText(frVs, frameRectStr);

    const medEl = doc.importXml(txtT.media);
    stripBinaryHash(medEl);
    const medUid = doc.newUid();
    medEl.setAttribute("ObjectUID", medUid);
    const medVs = findFirstDescendant(medEl, "VideoStream");
    if (medVs) medVs.setAttribute("ObjectRef", vsOid);
    const impEl = findFirstDescendant(medEl, "ImplementationID");
    if (impEl) setText(impEl, doc.newUid());
    const modEl = findFirstDescendant(medEl, "ModificationState");
    if (modEl) setText(modEl, Buffer.from(doc.newUid(), "utf16le").toString("base64"));

    const msEl = doc.importXml(txtT.videoMediaSource);
    const msOid = doc.allocOid();
    msEl.setAttribute("ObjectID", msOid);
    const msMed = findFirstDescendant(msEl, "Media");
    if (msMed) msMed.setAttribute("ObjectURef", medUid);

    const mcLogEl = doc.importXml(txtT.loggingInfo);
    const mcLogOid = doc.allocOid();
    mcLogEl.setAttribute("ObjectID", mcLogOid);

    const mcAccgEl = doc.importXml(txtT.audioClipChannelGroups);
    const mcAccgOid = doc.allocOid();
    mcAccgEl.setAttribute("ObjectID", mcAccgOid);

    const mcClipEl = doc.importXml(txtT.masterClipItem);
    const mcClipOid = doc.allocOid();
    mcClipEl.setAttribute("ObjectID", mcClipOid);
    findFirstDescendant(mcClipEl, "Source")?.setAttribute("ObjectRef", msOid);
    const mcClipId = findFirstDescendant(mcClipEl, "ClipID");
    if (mcClipId) setText(mcClipId, doc.newUid());
    const mcIn = findFirstDescendant(mcClipEl, "InPoint");
    if (mcIn) setText(mcIn, "0");
    const mcOut = findFirstDescendant(mcClipEl, "OutPoint");
    if (mcOut) setText(mcOut, durTicks.toString());

    const mcEl = doc.importXml(txtT.masterClip);
    const mcUid = doc.newUid();
    mcEl.setAttribute("ObjectUID", mcUid);
    findFirstDescendant(mcEl, "LoggingInfo")?.setAttribute("ObjectRef", mcLogOid);
    findByPath(mcEl, "Clips", "Clip")?.setAttribute("ObjectRef", mcClipOid);
    findFirstDescendant(mcEl, "AudioClipChannelGroups")?.setAttribute("ObjectRef", mcAccgOid);

    const vcEl = doc.importXml(txtT.videoClip);
    const vcOid = doc.allocOid();
    vcEl.setAttribute("ObjectID", vcOid);
    findFirstDescendant(vcEl, "Source")?.setAttribute("ObjectRef", msOid);
    const vcCid = findFirstDescendant(vcEl, "ClipID");
    if (vcCid) setText(vcCid, doc.newUid());
    const vcIn = findFirstDescendant(vcEl, "InPoint");
    if (vcIn) setText(vcIn, SYNTHETIC_ORIGIN.toString());
    const vcOut = findFirstDescendant(vcEl, "OutPoint");
    if (vcOut) setText(vcOut, (SYNTHETIC_ORIGIN + durTicks).toString());

    const scEl = doc.importXml(txtT.subClip);
    const scOid = doc.allocOid();
    scEl.setAttribute("ObjectID", scOid);
    findFirstDescendant(scEl, "Clip")?.setAttribute("ObjectRef", vcOid);
    findFirstDescendant(scEl, "MasterClip")?.setAttribute("ObjectURef", mcUid);

    const itEl = doc.importXml(txtT.trackItem);
    const itOid = doc.allocOid();
    itEl.setAttribute("ObjectID", itOid);
    findByPath(itEl, "ComponentOwner", "Components")?.setAttribute("ObjectRef", chOid);
    const ti = findByPath(itEl, "ClipTrackItem", "TrackItem");
    if (ti) {
      let stEl = childElements(ti, "Start")[0] || null;
      if (!stEl) {
        stEl = doc.doc.createElement("Start");
        ti.insertBefore(stEl, ti.firstChild);
      }
      setText(stEl, stTicks.toString());
      let enEl = childElements(ti, "End")[0] || null;
      if (!enEl) {
        enEl = doc.doc.createElement("End");
        ti.appendChild(enEl);
      }
      setText(enEl, enTicks.toString());
    }
    findFirstDescendant(itEl, "SubClip")?.setAttribute("ObjectRef", scOid);

    const refNode = doc.doc.createElement("TrackItem");
    refNode.setAttribute("Index", String(nextItemIndex));
    refNode.setAttribute("ObjectRef", itOid);
    trackItemsList.appendChild(refNode);

    const added: Element[] = [
      itEl,
      chEl,
      g2El,
      ...g2ParamEls,
      dsEl,
      ...dsParamEls,
      tcEl,
      ...tcParamEls,
      scEl,
      vcEl,
      msEl,
      mcEl,
      mcLogEl,
      mcAccgEl,
      mcClipEl,
      medEl,
      vsEl,
    ];
    for (const a of added) doc.registerTopElement(a);
  }

  return { insertedCount: opts.words.length, tracksUsed: Array.from(new Set(assignedTracks)).sort((a, b) => a - b) };
}

// =========================================================================
// 2. Universal Crop-Safe Camera Zoom/Pan Keyframer
// =========================================================================

export function clampCameraPos(
  posX: number,
  posY: number,
  scalePct: number,
  anchorX = 0.5,
  anchorY = 0.5,
  cropPct = { left: 0, top: 0, right: 0, bottom: 0 }
): [number, number] {
  const s = scalePct / 100.0;
  const cl = cropPct.left / 100.0;
  const cr = cropPct.right / 100.0;
  const ct = cropPct.top / 100.0;
  const cb = cropPct.bottom / 100.0;

  const minPx = 1.0 - s * (1.0 - cr - anchorX);
  const maxPx = s * (anchorX - cl);
  const minPy = 1.0 - s * (1.0 - cb - anchorY);
  const maxPy = s * (anchorY - ct);

  const clampedX = minPx <= maxPx ? Math.max(minPx, Math.min(maxPx, posX)) : (minPx + maxPx) / 2;
  const clampedY = minPy <= maxPy ? Math.max(minPy, Math.min(maxPy, posY)) : (minPy + maxPy) / 2;
  return [clampedX, clampedY];
}

function parseScalarStartKf(paramEl: Element | null, fallback: number): number {
  if (!paramEl) return fallback;
  const sk = getText(paramEl, "StartKeyframe");
  const parts = sk.split(",");
  if (parts.length >= 2) {
    const v = parseFloat(parts[1]);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

function parsePointStartKf(paramEl: Element | null, fallback: [number, number]): [number, number] {
  if (!paramEl) return fallback;
  const sk = getText(paramEl, "StartKeyframe");
  const parts = sk.split(",");
  if (parts.length >= 2 && parts[1].includes(":")) {
    const [xs, ys] = parts[1].split(":");
    const x = parseFloat(xs);
    const y = parseFloat(ys);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  return fallback;
}

export function build8StepHermiteCameraKfs(params: {
  segments: CameraSegmentSpec[];
  tlStartTicks: bigint;
  vcInTicks: bigint;
  vcOutTicks: bigint;
  frameTicks: bigint;
  baseScale: number;
  basePos: [number, number];
  anchor?: [number, number];
  cropPct?: { left: number; top: number; right: number; bottom: number };
  easeStyle?: "smooth" | "snappy";
}): { scaleKf: string; posKf: string } {
  const { segments, tlStartTicks, vcInTicks, vcOutTicks, frameTicks, baseScale, basePos } = params;
  const anchor = params.anchor ?? [0.5, 0.5];
  const cropPct = params.cropPct ?? { left: 0, top: 0, right: 0, bottom: 0 };

  const segTick = (s: CameraSegmentSpec): bigint => {
    const tlT = frameToTicks(s.tlFrame, frameTicks);
    const src = vcInTicks + (tlT - tlStartTicks);
    if (src < vcInTicks) return vcInTicks;
    if (src > vcOutTicks) return vcOutTicks;
    return src;
  };

  const sBase = Math.max(1.0, baseScale / 100.0);
  const effectiveCropPct = {
    left: Math.max(cropPct.left, (anchor[0] - basePos[0] / sBase) * 100),
    top: Math.max(cropPct.top, (anchor[1] - basePos[1] / sBase) * 100),
    right: Math.max(cropPct.right, (1 - (anchor[0] + (1 - basePos[0]) / sBase)) * 100),
    bottom: Math.max(cropPct.bottom, (1 - (anchor[1] + (1 - basePos[1]) / sBase)) * 100),
  };

  const resolveScalePos = (s: CameraSegmentSpec): { scale: number; pos: [number, number] } => {
    if (s.useClipBase) {
      return { scale: baseScale, pos: basePos };
    }
    const sc = Math.max(baseScale, s.scale ?? baseScale);
    const rawX = s.posX ?? basePos[0];
    const rawY = s.posY ?? basePos[1];
    return { scale: sc, pos: clampCameraPos(rawX, rawY, sc, anchor[0], anchor[1], effectiveCropPct) };
  };

  const ptsS: Array<[bigint, number]> = [];
  const ptsP: Array<[bigint, [number, number]]> = [];

  for (let i = 0; i < segments.length - 1; i++) {
    const a = segments[i];
    const b = segments[i + 1];
    const ta = segTick(a);
    const tb = segTick(b);
    if (tb <= ta) continue;

    const va = resolveScalePos(a);
    const vb = resolveScalePos(b);
    const moving =
      Math.abs(vb.scale - va.scale) > 1e-7 ||
      Math.abs(vb.pos[0] - va.pos[0]) > 1e-7 ||
      Math.abs(vb.pos[1] - va.pos[1]) > 1e-7;

    if (!moving) {
      if (ptsS.length === 0 || ptsS[ptsS.length - 1][0] !== ta) {
        ptsS.push([ta, va.scale]);
        ptsP.push([ta, va.pos]);
      }
      ptsS.push([tb, vb.scale]);
      ptsP.push([tb, vb.pos]);
    } else {
      const steps = 8;
      const dt = Number(tb - ta);
      for (let k = 0; k <= steps; k++) {
        const u = k / steps;
        const h =
          params.easeStyle === "snappy"
            ? 1 - Math.pow(1 - u, 3)
            : 3 * u * u - 2 * u * u * u;
        const tk = ta + BigInt(Math.round(dt * u));
        if (ptsS.length > 0 && tk <= ptsS[ptsS.length - 1][0]) continue;
        const sk = va.scale + (vb.scale - va.scale) * h;
        const xk = va.pos[0] + (vb.pos[0] - va.pos[0]) * h;
        const yk = va.pos[1] + (vb.pos[1] - va.pos[1]) * h;
        ptsS.push([tk, sk]);
        ptsP.push([tk, [xk, yk]]);
      }
    }
  }

  if (ptsS.length < 2) {
    throw new Error(`Expected >= 2 keyframes for camera curve, got ${ptsS.length}`);
  }

  const ticksPerSecNum = Number(TICKS_PER_SEC);
  const scaleParts: string[] = [];
  const posParts: string[] = [];
  const n = ptsS.length;

  for (let i = 0; i < n; i++) {
    const [ti, si] = ptsS[i];
    const [xi, yi] = ptsP[i][1];
    const inS = i > 0 ? (si - ptsS[i - 1][1]) / (Number(ti - ptsS[i - 1][0]) / ticksPerSecNum) : 0;
    const outS = i + 1 < n ? (ptsS[i + 1][1] - si) / (Number(ptsS[i + 1][0] - ti) / ticksPerSecNum) : 0;
    scaleParts.push(
      `${ti},${fmtKfNum(si)},0,0,${fmtKfNum(inS)},0.16666666666666666,${fmtKfNum(outS)},0.16666666666666666`
    );

    const inSpd =
      i > 0
        ? Math.hypot(xi - ptsP[i - 1][1][0], yi - ptsP[i - 1][1][1]) /
          (Number(ti - ptsP[i - 1][0]) / ticksPerSecNum)
        : 0;
    const outSpd =
      i + 1 < n
        ? Math.hypot(ptsP[i + 1][1][0] - xi, ptsP[i + 1][1][1] - yi) /
          (Number(ptsP[i + 1][0] - ti) / ticksPerSecNum)
        : 0;

    let txIn = 0;
    let tyIn = 0;
    let txOut = 0;
    let tyOut = 0;
    if (i > 0 && i < n - 1) {
      const dxIn = xi - ptsP[i - 1][1][0];
      const dyIn = yi - ptsP[i - 1][1][1];
      const dxOut = ptsP[i + 1][1][0] - xi;
      const dyOut = ptsP[i + 1][1][1] - yi;
      if (dxIn === 0 && dyIn === 0 && (dxOut !== 0 || dyOut !== 0)) {
        txOut = dxOut / 6;
        tyOut = dyOut / 6;
      } else if (dxOut === 0 && dyOut === 0 && (dxIn !== 0 || dyIn !== 0)) {
        txIn = -dxIn / 6;
        tyIn = -dyIn / 6;
      } else {
        txOut = (ptsP[i + 1][1][0] - ptsP[i - 1][1][0]) / 6;
        tyOut = (ptsP[i + 1][1][1] - ptsP[i - 1][1][1]) / 6;
        txIn = -txOut;
        tyIn = -tyOut;
      }
    } else if (i === 0) {
      txOut = (ptsP[1][1][0] - xi) / 6;
      tyOut = (ptsP[1][1][1] - yi) / 6;
    } else {
      txIn = -(xi - ptsP[i - 1][1][0]) / 6;
      tyIn = -(yi - ptsP[i - 1][1][1]) / 6;
    }

    posParts.push(
      `${ti},${fmtKfNum(xi)}:${fmtKfNum(yi)},0,0,${fmtKfNum(inSpd)},0.16666666666666666,${fmtKfNum(outSpd)},0.16666666666666666,5,4,${fmtKfNum(txIn)},${fmtKfNum(tyIn)},${fmtKfNum(txOut)},${fmtKfNum(tyOut)}`
    );
  }

  return { scaleKf: scaleParts.join(";") + ";", posKf: posParts.join(";") + ";" };
}

export function injectCameraMoves(
  doc: PrprojDocument,
  opts: {
    sequenceId: string;
    frameTicks: bigint;
    moves: CameraClipMove[];
    easeStyle?: "smooth" | "snappy";
  }
): number {
  const { videoTrackGroup } = doc.findSequenceGroups(opts.sequenceId);
  const v1Track = doc.getVideoTracks(videoTrackGroup)[0]?.trackEl;
  if (!v1Track) throw new Error("V1 track not found");
  const tis = findFirstDescendant(v1Track, "TrackItems");
  if (!tis) return 0;

  const v1Clips: Element[] = [];
  for (const r of childElements(tis, "TrackItem")) {
    const it = doc.oid.get(r.getAttribute("ObjectRef") || "");
    if (it && it.tagName === "VideoClipTrackItem") v1Clips.push(it);
  }

  let applied = 0;
  for (const mv of opts.moves) {
    const it = v1Clips[mv.clipIdx];
    if (!it) continue;
    const ti = findByPath(it, "ClipTrackItem", "TrackItem");
    if (!ti) continue;
    const tlStartTicks = BigInt(getText(ti, "Start") || "0");
    const sc = doc.oid.get(findFirstDescendant(it, "SubClip")?.getAttribute("ObjectRef") || "");
    const vc = sc ? doc.oid.get(findFirstDescendant(sc, "Clip")?.getAttribute("ObjectRef") || "") : undefined;
    if (!vc) continue;
    const vcInTicks = BigInt(getText(vc, "InPoint") || "0");
    const vcOutTicks = BigInt(getText(vc, "OutPoint") || "0");

    const ch = doc.oid.get(findByPath(it, "ComponentOwner", "Components")?.getAttribute("ObjectRef") || "");
    if (!ch) continue;
    const compRefs = childElements(findFirstDescendant(ch, "Components") || ch, "Component");
    const comps = compRefs
      .map((cr) => doc.oid.get(cr.getAttribute("ObjectRef") || ""))
      .filter((c): c is Element => Boolean(c));

    const mot = comps.find((c) => getText(c, "MatchName") === "AE.ADBE Motion");
    if (!mot) continue;

    const pRefs = childElements(findFirstDescendant(mot, "Params") || mot, "Param");
    const paramEls = pRefs.map((pr) => doc.oid.get(pr.getAttribute("ObjectRef") || "") || null);
    const pPos = paramEls[0];
    const pScale = paramEls[1];
    if (!pPos || !pScale) continue;

    const basePos = parsePointStartKf(pPos, [0.5, 0.5]);
    const baseScale = parseScalarStartKf(pScale, 100);
    const anchor = parsePointStartKf(paramEls[5], [0.5, 0.5]);

    const cropComp = comps.find((c) => getText(c, "MatchName") === "AE.ADBE Crop");
    const cropCompParams = cropComp
      ? childElements(findFirstDescendant(cropComp, "Params") || cropComp, "Param").map(
          (pr) => doc.oid.get(pr.getAttribute("ObjectRef") || "") || null
        )
      : [];

    const cropPct = {
      left: Math.max(parseScalarStartKf(paramEls[7], 0), parseScalarStartKf(cropCompParams[0] || null, 0)),
      top: Math.max(parseScalarStartKf(paramEls[8], 0), parseScalarStartKf(cropCompParams[1] || null, 0)),
      right: Math.max(parseScalarStartKf(paramEls[9], 0), parseScalarStartKf(cropCompParams[2] || null, 0)),
      bottom: Math.max(parseScalarStartKf(paramEls[10], 0), parseScalarStartKf(cropCompParams[3] || null, 0)),
    };

    const { scaleKf, posKf } = build8StepHermiteCameraKfs({
      segments: mv.segments,
      tlStartTicks,
      vcInTicks,
      vcOutTicks,
      frameTicks: opts.frameTicks,
      baseScale,
      basePos,
      anchor,
      cropPct,
      easeStyle: opts.easeStyle,
    });

    doc.setParamTimeVarying(pPos, posKf);
    doc.setParamTimeVarying(pScale, scaleKf);
    applied += 1;
  }

  return applied;
}

export function resetClipCamera(doc: PrprojDocument, sequenceId: string, clipIdx: number): boolean {
  const { videoTrackGroup } = doc.findSequenceGroups(sequenceId);
  const v1Track = doc.getVideoTracks(videoTrackGroup)[0]?.trackEl;
  if (!v1Track) return false;
  const tis = findFirstDescendant(v1Track, "TrackItems");
  if (!tis) return false;

  const v1Clips: Element[] = [];
  for (const r of childElements(tis, "TrackItem")) {
    const it = doc.oid.get(r.getAttribute("ObjectRef") || "");
    if (it && it.tagName === "VideoClipTrackItem") v1Clips.push(it);
  }
  const it = v1Clips[clipIdx];
  if (!it) return false;
  const ch = doc.oid.get(findByPath(it, "ComponentOwner", "Components")?.getAttribute("ObjectRef") || "");
  if (!ch) return false;
  const comps = childElements(findFirstDescendant(ch, "Components") || ch, "Component")
    .map((cr) => doc.oid.get(cr.getAttribute("ObjectRef") || ""))
    .filter((c): c is Element => Boolean(c));
  const mot = comps.find((c) => getText(c, "MatchName") === "AE.ADBE Motion");
  if (!mot) return false;
  const pRefs = childElements(findFirstDescendant(mot, "Params") || mot, "Param");
  const pPos = doc.oid.get(pRefs[0]?.getAttribute("ObjectRef") || "");
  const pScale = doc.oid.get(pRefs[1]?.getAttribute("ObjectRef") || "");
  if (pPos) doc.setParamStatic(pPos, getText(pPos, "StartKeyframe"));
  if (pScale) doc.setParamStatic(pScale, getText(pScale, "StartKeyframe"));
  return true;
}

// =========================================================================
// 3. Phase 1 Clip Colorizer (KEEP = Iris, SILENCE = Violet, BAD_TAKE = Rose)
// =========================================================================

const LABEL_COLORS: Record<Phase1CutPlanItem["category"], { name: string; color: string }> = {
  KEEP: { name: "BE.Prefs.LabelColors.1", color: "6769408" },
  SILENCE: { name: "BE.Prefs.LabelColors.2", color: "13667565" },
  BAD_TAKE: { name: "BE.Prefs.LabelColors.6", color: "14780067" },
};

function setClipLabelProps(doc: PrprojDocument, clipEl: Element, label: { name: string; color: string }): void {
  const innerClip = findFirstDescendant(clipEl, "Clip");
  if (!innerClip) return;
  let nodeEl = childElements(innerClip, "Node")[0] || null;
  if (!nodeEl) {
    nodeEl = doc.doc.createElement("Node");
    nodeEl.setAttribute("Version", "1");
    innerClip.insertBefore(nodeEl, innerClip.firstChild);
  }
  let propsEl = childElements(nodeEl, "Properties")[0] || null;
  if (!propsEl) {
    propsEl = doc.doc.createElement("Properties");
    propsEl.setAttribute("Version", "1");
    nodeEl.appendChild(propsEl);
  }
  let colorEl = childElements(propsEl, "asl.clip.label.color")[0] || null;
  if (!colorEl) {
    colorEl = doc.doc.createElement("asl.clip.label.color");
    propsEl.appendChild(colorEl);
  }
  setText(colorEl, label.color);

  let nameEl = childElements(propsEl, "asl.clip.label.name")[0] || null;
  if (!nameEl) {
    nameEl = doc.doc.createElement("asl.clip.label.name");
    propsEl.appendChild(nameEl);
  }
  setText(nameEl, label.name);
}

export function colorizePhase1Clips(
  doc: PrprojDocument,
  sequenceId: string,
  items: Phase1CutPlanItem[]
): number {
  const { videoTrackGroup, audioTrackGroup } = doc.findSequenceGroups(sequenceId);
  const v1Track = doc.getVideoTracks(videoTrackGroup)[0]?.trackEl;
  const a1Ref = audioTrackGroup
    ? (findByPath(audioTrackGroup, "TrackGroup", "Tracks") || findFirstDescendant(audioTrackGroup, "Tracks"))
        ?.getElementsByTagName("Track")[0]
    : null;
  const a1Track = a1Ref ? doc.uid.get(a1Ref.getAttribute("ObjectURef") || "") : null;

  const v1Clips: Element[] = [];
  if (v1Track) {
    const tis = findFirstDescendant(v1Track, "TrackItems");
    if (tis) {
      for (const r of childElements(tis, "TrackItem")) {
        const it = doc.oid.get(r.getAttribute("ObjectRef") || "");
        if (it && it.tagName === "VideoClipTrackItem") v1Clips.push(it);
      }
    }
  }

  const a1Clips: Element[] = [];
  if (a1Track) {
    const tis = findFirstDescendant(a1Track, "TrackItems");
    if (tis) {
      for (const r of childElements(tis, "TrackItem")) {
        const it = doc.oid.get(r.getAttribute("ObjectRef") || "");
        if (it && it.tagName === "AudioClipTrackItem") a1Clips.push(it);
      }
    }
  }

  let colored = 0;
  for (const item of items) {
    const label = LABEL_COLORS[item.category];
    if (!label) continue;
    const vit = v1Clips[item.seq_clip_idx];
    if (vit) {
      const sc = doc.oid.get(findFirstDescendant(vit, "SubClip")?.getAttribute("ObjectRef") || "");
      const vc = sc ? doc.oid.get(findFirstDescendant(sc, "Clip")?.getAttribute("ObjectRef") || "") : undefined;
      if (vc) {
        setClipLabelProps(doc, vc, label);
        colored += 1;
      }
    }
    const ait = a1Clips[item.seq_clip_idx];
    if (ait) {
      const sc = doc.oid.get(findFirstDescendant(ait, "SubClip")?.getAttribute("ObjectRef") || "");
      const ac = sc ? doc.oid.get(findFirstDescendant(sc, "Clip")?.getAttribute("ObjectRef") || "") : undefined;
      if (ac) {
        setClipLabelProps(doc, ac, label);
      }
    }
  }
  return colored;
}

// =========================================================================
// 4. Smart Overlay Badge / Logo Track Injector
// =========================================================================

export function injectSmartBadge(
  doc: PrprojDocument,
  opts: {
    sequenceId: string;
    frameWidth: number;
    frameHeight: number;
    pngPath: string;
    targetTrackNum?: number;
    scalePct: number;
    opacityPct: number;
    segments: BadgeSegmentSpec[];
  }
): number {
  const { videoTrackGroup } = doc.findSequenceGroups(opts.sequenceId);
  const existingTracks = doc.getVideoTracks(videoTrackGroup);
  const targetNum = Math.max(2, opts.targetTrackNum ?? Math.max(7, existingTracks.length + 1));
  const tracks = doc.ensureVideoTrackCount(videoTrackGroup, targetNum);
  const badgeTrack = tracks[targetNum - 1];
  const tis = doc.ensureTrackItemsContainer(badgeTrack);

  // Clear previous TrackItem references on the badge track if re-applying
  for (const oldRef of childElements(tis, "TrackItem")) {
    tis.removeChild(oldRef);
  }

  const bT = TEMPLATES.badge;
  const baseName = opts.pngPath.split(/[\\/]/).pop() || "Badge.png";

  // Build shared MasterClip + Media + VideoStream + ClipProjectItem under RootProjectItem
  const mcUid = doc.newUid();
  const medUid = doc.newUid();
  const cpiUid = doc.newUid();

  const vsEl = doc.importXml(bT.videoStream);
  const vsOid = doc.allocOid();
  vsEl.setAttribute("ObjectID", vsOid);

  const medEl = doc.importXml(bT.media);
  stripBinaryHash(medEl);
  medEl.setAttribute("ObjectUID", medUid);
  findFirstDescendant(medEl, "VideoStream")?.setAttribute("ObjectRef", vsOid);
  const stateUid = doc.newUid();
  const modEl = findFirstDescendant(medEl, "ModificationState");
  if (modEl) setText(modEl, Buffer.from(stateUid, "utf16le").toString("base64"));
  const impEl = findFirstDescendant(medEl, "ImplementationID");
  if (impEl) setText(impEl, doc.newUid());
  const fkEl = findFirstDescendant(medEl, "FileKey");
  if (fkEl) setText(fkEl, doc.newUid());
  const cams = findFirstDescendant(medEl, "ContentAndMetadataState");
  if (cams) setText(cams, stateUid);
  const rps = medEl.getElementsByTagName("RelativePath");
  for (let i = 0; i < rps.length; i++) setText(rps[i], `./${baseName}`);
  const amp = findFirstDescendant(medEl, "ActualMediaFilePath");
  if (amp) setText(amp, opts.pngPath);
  const fp = findFirstDescendant(medEl, "FilePath");
  if (fp) setText(fp, opts.pngPath);
  const ttl = findFirstDescendant(medEl, "Title");
  if (ttl) setText(ttl, baseName);

  const msEl = doc.importXml(bT.videoMediaSource);
  const msOid = doc.allocOid();
  msEl.setAttribute("ObjectID", msOid);
  findFirstDescendant(msEl, "Media")?.setAttribute("ObjectURef", medUid);

  const mrkEl = doc.importXml(bT.markers);
  const mrkOid = doc.allocOid();
  mrkEl.setAttribute("ObjectID", mrkOid);
  const lcs = findFirstDescendant(mrkEl, "LastContentState");
  if (lcs) setText(lcs, stateUid);

  const mcClipEl = doc.importXml(bT.masterClipItem);
  const mcClipOid = doc.allocOid();
  mcClipEl.setAttribute("ObjectID", mcClipOid);
  findFirstDescendant(mcClipEl, "Markers")?.setAttribute("ObjectRef", mrkOid);
  findFirstDescendant(mcClipEl, "Source")?.setAttribute("ObjectRef", msOid);
  const mcCid = findFirstDescendant(mcClipEl, "ClipID");
  if (mcCid) setText(mcCid, doc.newUid());

  const logEl = doc.importXml(bT.loggingInfo);
  const logOid = doc.allocOid();
  logEl.setAttribute("ObjectID", logOid);

  const accgEl = doc.importXml(bT.audioClipChannelGroups);
  const accgOid = doc.allocOid();
  accgEl.setAttribute("ObjectID", accgOid);

  const mcEl = doc.importXml(bT.masterClip);
  mcEl.setAttribute("ObjectUID", mcUid);
  findFirstDescendant(mcEl, "LoggingInfo")?.setAttribute("ObjectRef", logOid);
  findByPath(mcEl, "Clips", "Clip")?.setAttribute("ObjectRef", mcClipOid);
  findFirstDescendant(mcEl, "AudioClipChannelGroups")?.setAttribute("ObjectRef", accgOid);

  const cpiEl = doc.importXml(bT.clipProjectItem);
  cpiEl.setAttribute("ObjectUID", cpiUid);
  findFirstDescendant(cpiEl, "MasterClip")?.setAttribute("ObjectURef", mcUid);
  const cpiName = findFirstDescendant(cpiEl, "Name");
  if (cpiName) setText(cpiName, baseName);

  const rpis = doc.root.getElementsByTagName("RootProjectItem");
  for (let i = 0; i < rpis.length; i++) {
    if (rpis[i].getAttribute("ObjectUID")) {
      const itemsEl = findByPath(rpis[i], "ProjectItemContainer", "Items");
      if (itemsEl) {
        const nextIdx = childElements(itemsEl, "Item").length;
        const itemRef = doc.doc.createElement("Item");
        itemRef.setAttribute("Index", String(nextIdx));
        itemRef.setAttribute("ObjectURef", cpiUid);
        itemsEl.appendChild(itemRef);
      }
      break;
    }
  }

  for (const el of [cpiEl, mcEl, logEl, accgEl, mrkEl, msEl, mcClipEl, medEl, vsEl]) {
    doc.registerTopElement(el);
  }

  let count = 0;
  for (let sIdx = 0; sIdx < opts.segments.length; sIdx++) {
    const seg = opts.segments[sIdx];
    const durTicks = BigInt(seg.endTicks) - BigInt(seg.startTicks);
    if (durTicks <= 0n) continue;

    const opcEl = doc.importXml(bT.opacity);
    const opcOid = doc.allocOid();
    opcEl.setAttribute("ObjectID", opcOid);
    const opcRefs = opcEl.getElementsByTagName("Param");
    const opcParams: Element[] = [];
    for (let pidx = 0; pidx < bT.opacityParams.length; pidx++) {
      const pe = doc.importXml(bT.opacityParams[pidx]);
      const pOid = doc.allocOid();
      pe.setAttribute("ObjectID", pOid);
      opcRefs[pidx].setAttribute("ObjectRef", pOid);
      if (pidx === 0) {
        doc.setParamStatic(pe, `-91445760000000000,${fmtKfNum(opts.opacityPct)},0,0,0,0,0,0`);
      }
      opcParams.push(pe);
    }

    const motEl = doc.importXml(bT.motion);
    stripBinaryHash(motEl);
    const motOid = doc.allocOid();
    motEl.setAttribute("ObjectID", motOid);
    const motRefs = motEl.getElementsByTagName("Param");
    const motParams: Element[] = [];
    for (let pidx = 0; pidx < bT.motionParams.length; pidx++) {
      const pe = doc.importXml(bT.motionParams[pidx]);
      const pOid = doc.allocOid();
      pe.setAttribute("ObjectID", pOid);
      motRefs[pidx].setAttribute("ObjectRef", pOid);
      if (pidx === 0) {
        doc.setParamStatic(
          pe,
          `-91445760000000000,${seg.posX}:${seg.posY},0,0,0,0,0,0,5,4,0,0,0,0`
        );
      } else if (pidx === 1 || pidx === 2) {
        doc.setParamStatic(pe, `-91445760000000000,${fmtKfNum(opts.scalePct)},0,0,0,0,0,0`);
      }
      motParams.push(pe);
    }

    const chEl = doc.importXml(bT.componentChain);
    const chOid = doc.allocOid();
    chEl.setAttribute("ObjectID", chOid);
    const cRefs = chEl.getElementsByTagName("Component");
    cRefs[0].setAttribute("ObjectRef", opcOid);
    cRefs[1].setAttribute("ObjectRef", motOid);

    const vcEl = doc.importXml(bT.videoClip);
    const vcOid = doc.allocOid();
    vcEl.setAttribute("ObjectID", vcOid);
    findFirstDescendant(vcEl, "Markers")?.setAttribute("ObjectRef", mrkOid);
    findFirstDescendant(vcEl, "Source")?.setAttribute("ObjectRef", msOid);
    const vcCid = findFirstDescendant(vcEl, "ClipID");
    if (vcCid) setText(vcCid, doc.newUid());
    const vcIn = findFirstDescendant(vcEl, "InPoint");
    if (vcIn) setText(vcIn, "0");
    const vcOut = findFirstDescendant(vcEl, "OutPoint");
    if (vcOut) setText(vcOut, durTicks.toString());

    const scEl = doc.importXml(bT.subClip);
    const scOid = doc.allocOid();
    scEl.setAttribute("ObjectID", scOid);
    findFirstDescendant(scEl, "Clip")?.setAttribute("ObjectRef", vcOid);
    findFirstDescendant(scEl, "MasterClip")?.setAttribute("ObjectURef", mcUid);

    const itEl = doc.importXml(bT.trackItem);
    const itOid = doc.allocOid();
    itEl.setAttribute("ObjectID", itOid);
    findByPath(itEl, "ComponentOwner", "Components")?.setAttribute("ObjectRef", chOid);
    const ti = findByPath(itEl, "ClipTrackItem", "TrackItem");
    if (ti) {
      let stEl = childElements(ti, "Start")[0] || null;
      if (!stEl) {
        stEl = doc.doc.createElement("Start");
        ti.insertBefore(stEl, ti.firstChild);
      }
      setText(stEl, String(seg.startTicks));
      let enEl = childElements(ti, "End")[0] || null;
      if (!enEl) {
        enEl = doc.doc.createElement("End");
        ti.appendChild(enEl);
      }
      setText(enEl, String(seg.endTicks));
    }
    findFirstDescendant(itEl, "SubClip")?.setAttribute("ObjectRef", scOid);

    const trRef = doc.doc.createElement("TrackItem");
    trRef.setAttribute("Index", String(sIdx));
    trRef.setAttribute("ObjectRef", itOid);
    tis.appendChild(trRef);

    for (const el of [itEl, chEl, opcEl, ...opcParams, motEl, ...motParams, scEl, vcEl]) {
      doc.registerTopElement(el);
    }
    count += 1;
  }

  return count;
}

export function loadPrprojFromBuffer(gzOrXml: Buffer): PrprojDocument {
  const zlib = nodeRequire<typeof import("node:zlib")>("zlib");
  const isGzip = gzOrXml.length >= 2 && gzOrXml[0] === 0x1f && gzOrXml[1] === 0x8b;
  const xmlStr = (isGzip ? zlib.gunzipSync(gzOrXml) : gzOrXml).toString("utf8");
  return new PrprojDocument(xmlStr);
}

export function savePrprojAtomic(doc: PrprojDocument, projectDir: string): string {
  const fs = nodeRequire<typeof import("node:fs")>("fs");
  const path = nodeRequire<typeof import("node:path")>("path");
  const zlib = nodeRequire<typeof import("node:zlib")>("zlib");

  doc.validateIntegrity();
  const xmlText = doc.serialize();
  const gz = zlib.gzipSync(Buffer.from(xmlText, "utf8"));
  const stagingPath = path.join(projectDir, `.kahamatic_staging_${Date.now()}.prproj`);
  fs.writeFileSync(stagingPath, gz);
  return stagingPath;
}
