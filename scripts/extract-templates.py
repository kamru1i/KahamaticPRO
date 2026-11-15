"""
Extract verified clean Adobe Premiere XML templates into cep/templates/premiere_templates.json
from M2-03_v1_WITH_BADGE.xml and M2-10_clean_backup.xml.
Run via: C:\\Users\\kamru\\.local\\bin\\uv.exe run --offline python scripts/extract-templates.py
"""
import base64
import copy
import json
import xml.etree.ElementTree as ET
from pathlib import Path

M203_XML = Path(
    r"C:\Users\kamru\.gemini\antigravity\brain\bc0f0ce1-e358-4320-bb06-8873bb00692f\scratch\m2_03_edit\M2-03_v1_WITH_BADGE.xml"
)
M210_XML = Path(
    r"C:\Users\kamru\.gemini\antigravity\brain\bc0f0ce1-e358-4320-bb06-8873bb00692f\scratch\m2_10_edit\M2-10_clean_backup.xml"
)
OUT_JSON = Path(__file__).resolve().parent.parent / "cep" / "templates" / "premiere_templates.json"


def strip_binary_hash(elem: ET.Element) -> ET.Element:
    cp = copy.deepcopy(elem)
    for e in cp.iter():
        if "BinaryHash" in e.attrib:
            del e.attrib["BinaryHash"]
    return cp


def to_xml_str(elem: ET.Element, strip_bh: bool = True) -> str:
    node = strip_binary_hash(elem) if strip_bh else copy.deepcopy(elem)
    return ET.tostring(node, encoding="unicode")


def main() -> None:
    t3 = ET.parse(M203_XML).getroot()
    m3_oid = {e.attrib["ObjectID"]: e for e in list(t3) if "ObjectID" in e.attrib}
    m3_uid = {e.attrib["ObjectUID"]: e for e in list(t3) if "ObjectUID" in e.attrib}

    vtg3 = t3.find(".//VideoTrackGroup")
    # Text graphic template from V2[0]
    v2_tr3 = m3_uid[vtg3.findall(".//Tracks/Track")[1].attrib["ObjectURef"]]
    v2_it0 = m3_oid[v2_tr3.findall(".//TrackItems/TrackItem")[0].attrib["ObjectRef"]]
    ch0 = m3_oid[v2_it0.find(".//ComponentOwner/Components").attrib["ObjectRef"]]
    comps0 = [m3_oid[c.attrib["ObjectRef"]] for c in ch0.findall(".//Components/Component")]
    geom2_tpl, drops_tpl, text_tpl = comps0[0], comps0[1], comps0[2]
    assert [c.findtext(".//MatchName") for c in (geom2_tpl, drops_tpl, text_tpl)] == [
        "AE.ADBE Geometry2",
        "AE.ADBE Drop Shadow",
        "AE.ADBE Text",
    ]
    geom2_params_tpl = [m3_oid[p.attrib["ObjectRef"]] for p in geom2_tpl.findall(".//Params/Param")]
    drops_params_tpl = [m3_oid[p.attrib["ObjectRef"]] for p in drops_tpl.findall(".//Params/Param")]
    text_params_tpl = [m3_oid[p.attrib["ObjectRef"]] for p in text_tpl.findall(".//Params/Param")]

    h352_raw = base64.b64decode(text_params_tpl[0].findtext(".//StartKeyframeValue"))
    assert len(h352_raw) >= 356
    h352_base_hex = h352_raw[:352].hex()

    sc0 = m3_oid[v2_it0.find(".//SubClip").attrib["ObjectRef"]]
    vc0 = m3_oid[sc0.find(".//Clip").attrib["ObjectRef"]]
    ms0 = m3_oid[vc0.find(".//Source").attrib["ObjectRef"]]
    mc0 = m3_uid[sc0.find(".//MasterClip").attrib["ObjectURef"]]
    mc0_log = m3_oid[mc0.find(".//LoggingInfo").attrib["ObjectRef"]]
    mc0_clip = m3_oid[mc0.find(".//Clips/Clip").attrib["ObjectRef"]]
    mc0_accg = m3_oid[mc0.find(".//AudioClipChannelGroups").attrib["ObjectRef"]]
    med0 = m3_uid[ms0.find(".//Media").attrib["ObjectURef"]]
    vs0 = m3_oid[med0.find(".//VideoStream").attrib["ObjectRef"]]

    # Clean up SKV inside text param 0 template so JSON stays compact & deterministic
    text_params_clean = []
    for idx, p in enumerate(text_params_tpl):
        cp = strip_binary_hash(p)
        if idx == 0:
            skv = cp.find(".//StartKeyframeValue")
            if skv is not None:
                skv.text = ""
        text_params_clean.append(ET.tostring(cp, encoding="unicode"))

    # Image / Badge template from V7[0]
    v7_tr3 = m3_uid[vtg3.findall(".//Tracks/Track")[6].attrib["ObjectURef"]]
    v7_it0 = m3_oid[v7_tr3.findall(".//TrackItems/TrackItem")[0].attrib["ObjectRef"]]
    ch7 = m3_oid[v7_it0.find(".//ComponentOwner/Components").attrib["ObjectRef"]]
    bcomps = [m3_oid[c.attrib["ObjectRef"]] for c in ch7.findall(".//Components/Component")]
    opc7_tpl, mot7_tpl = bcomps[0], bcomps[1]
    assert [c.findtext(".//MatchName") for c in (opc7_tpl, mot7_tpl)] == [
        "AE.ADBE Opacity",
        "AE.ADBE Motion",
    ]
    opc7_params_tpl = [m3_oid[p.attrib["ObjectRef"]] for p in opc7_tpl.findall(".//Params/Param")]
    mot7_params_tpl = [m3_oid[p.attrib["ObjectRef"]] for p in mot7_tpl.findall(".//Params/Param")]

    sc7 = m3_oid[v7_it0.find(".//SubClip").attrib["ObjectRef"]]
    vc7 = m3_oid[sc7.find(".//Clip").attrib["ObjectRef"]]
    ms7 = m3_oid[vc7.find(".//Source").attrib["ObjectRef"]]
    mc7 = m3_uid[sc7.find(".//MasterClip").attrib["ObjectURef"]]
    mc7_log = m3_oid[mc7.find(".//LoggingInfo").attrib["ObjectRef"]]
    mc7_clip = m3_oid[mc7.find(".//Clips/Clip").attrib["ObjectRef"]]
    mc7_accg = m3_oid[mc7.find(".//AudioClipChannelGroups").attrib["ObjectRef"]]
    mc7_mrk = m3_oid[mc7_clip.find(".//MarkerOwner/Markers").attrib["ObjectRef"]]
    med7 = m3_uid[ms7.find(".//Media").attrib["ObjectURef"]]
    vs7 = m3_oid[med7.find(".//VideoStream").attrib["ObjectRef"]]
    cpi7 = [
        cpi
        for cpi in t3.findall(".//ClipProjectItem")
        if cpi.find(".//MasterClip") is not None
        and cpi.find(".//MasterClip").attrib.get("ObjectURef") == mc7.attrib["ObjectUID"]
    ][0]

    # Empty VideoTrack template from M2-10 V2 (guaranteed completely empty VideoTrack)
    t10 = ET.parse(M210_XML).getroot()
    m10_uid = {e.attrib["ObjectUID"]: e for e in list(t10) if "ObjectUID" in e.attrib}
    vtg10 = t10.find(".//VideoTrackGroup")
    empty_vtrack_tpl = m10_uid[vtg10.findall(".//Tracks/Track")[1].attrib["ObjectURef"]]
    assert len(empty_vtrack_tpl.findall(".//TrackItems/TrackItem")) == 0

    payload = {
        "h352BaseHex": h352_base_hex,
        "emptyVideoTrack": to_xml_str(empty_vtrack_tpl),
        "text": {
            "trackItem": to_xml_str(v2_it0),
            "componentChain": to_xml_str(ch0),
            "geom2": to_xml_str(geom2_tpl),
            "geom2Params": [to_xml_str(p) for p in geom2_params_tpl],
            "dropShadow": to_xml_str(drops_tpl),
            "dropShadowParams": [to_xml_str(p) for p in drops_params_tpl],
            "textComp": to_xml_str(text_tpl),
            "textParams": text_params_clean,
            "subClip": to_xml_str(sc0),
            "videoClip": to_xml_str(vc0),
            "videoMediaSource": to_xml_str(ms0),
            "masterClip": to_xml_str(mc0),
            "loggingInfo": to_xml_str(mc0_log),
            "audioClipChannelGroups": to_xml_str(mc0_accg),
            "masterClipItem": to_xml_str(mc0_clip),
            "media": to_xml_str(med0),
            "videoStream": to_xml_str(vs0),
        },
        "badge": {
            "trackItem": to_xml_str(v7_it0),
            "componentChain": to_xml_str(ch7),
            "opacity": to_xml_str(opc7_tpl),
            "opacityParams": [to_xml_str(p) for p in opc7_params_tpl],
            "motion": to_xml_str(mot7_tpl),
            "motionParams": [to_xml_str(p) for p in mot7_params_tpl],
            "subClip": to_xml_str(sc7),
            "videoClip": to_xml_str(vc7),
            "videoMediaSource": to_xml_str(ms7),
            "masterClip": to_xml_str(mc7),
            "loggingInfo": to_xml_str(mc7_log),
            "audioClipChannelGroups": to_xml_str(mc7_accg),
            "masterClipItem": to_xml_str(mc7_clip),
            "markers": to_xml_str(mc7_mrk),
            "media": to_xml_str(med7),
            "videoStream": to_xml_str(vs7),
            "clipProjectItem": to_xml_str(cpi7),
        },
    }

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote {OUT_JSON} ({OUT_JSON.stat().st_size / 1024:.1f} KB)")


if __name__ == "__main__":
    main()
