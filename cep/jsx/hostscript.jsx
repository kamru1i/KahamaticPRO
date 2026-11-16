/* KahamaticPRO - Pure ES3 Strict ASCII ExtendScript Host (Adobe Premiere Pro) */
if (typeof $._Kahamatic === "undefined") {
  $._Kahamatic = {};
}

(function (ns) {
  function kmJsonStr(s) {
    if (s === null || s === undefined) return "null";
    var str = String(s);
    var out = '"';
    for (var i = 0; i < str.length; i++) {
      var c = str.charAt(i);
      var code = str.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\b') out += '\\b';
      else if (c === '\f') out += '\\f';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (code < 32 || code > 126) {
        var hex = code.toString(16);
        while (hex.length < 4) hex = "0" + hex;
        out += "\\u" + hex;
      } else {
        out += c;
      }
    }
    return out + '"';
  }

  function kmJsonVal(v) {
    if (v === null || v === undefined) return "null";
    var t = typeof v;
    if (t === "boolean") return v ? "true" : "false";
    if (t === "number") return isFinite(v) ? String(v) : "null";
    if (t === "string") return kmJsonStr(v);
    if (v instanceof Array) {
      var arr = [];
      for (var i = 0; i < v.length; i++) arr.push(kmJsonVal(v[i]));
      return "[" + arr.join(",") + "]";
    }
    var parts = [];
    for (var k in v) {
      if (v.hasOwnProperty(k) && v[k] !== undefined && typeof v[k] !== "function") {
        parts.push(kmJsonStr(k) + ":" + kmJsonVal(v[k]));
      }
    }
    return "{" + parts.join(",") + "}";
  }

  function pad2(n) {
    return n < 10 ? "0" + n : String(n);
  }

  function frameToTc(frame, fps) {
    var f = Math.round(frame);
    var ff = f % fps;
    var sTot = Math.floor(f / fps);
    var ss = sTot % 60;
    var mTot = Math.floor(sTot / 60);
    var mm = mTot % 60;
    var hh = Math.floor(mTot / 60);
    return pad2(hh) + ":" + pad2(mm) + ":" + pad2(ss) + ":" + pad2(ff);
  }

  function parentDirOf(filePath) {
    var s = String(filePath);
    var idx = s.lastIndexOf("/");
    if (idx < 0) idx = s.lastIndexOf("\\");
    return idx >= 0 ? s.substring(0, idx) : s;
  }

  function findProjectByPath(targetPath) {
    for (var i = 0; i < app.projects.numProjects; i++) {
      if (String(app.projects[i].path) === String(targetPath)) {
        return app.projects[i];
      }
    }
    return null;
  }

  function findSequenceById(proj, seqId) {
    for (var i = 0; i < proj.sequences.numSequences; i++) {
      if (String(proj.sequences[i].sequenceID) === String(seqId)) {
        return proj.sequences[i];
      }
    }
    return null;
  }

  function countOfflineClips(seq) {
    var off = 0;
    var vt, k, c;
    for (var t = 0; t < seq.videoTracks.numTracks; t++) {
      vt = seq.videoTracks[t];
      for (k = 0; k < vt.clips.numItems; k++) {
        c = vt.clips[k];
        if (c.projectItem && c.projectItem.isOffline && c.projectItem.isOffline()) {
          off++;
        }
      }
    }
    for (var a = 0; a < seq.audioTracks.numTracks; a++) {
      vt = seq.audioTracks[a];
      for (k = 0; k < vt.clips.numItems; k++) {
        c = vt.clips[k];
        if (c.projectItem && c.projectItem.isOffline && c.projectItem.isOffline()) {
          off++;
        }
      }
    }
    return off;
  }

  ns.getProjectContext = function () {
    try {
      var proj = app.project;
      if (!proj || !proj.path) {
        return kmJsonVal({ ok: false, error: "No saved Premiere Pro project is active." });
      }
      var seq = proj.activeSequence;
      if (!seq) {
        return kmJsonVal({ ok: false, error: "No active sequence in current project." });
      }

      var ticksPerSec = 254016000000;
      var frameTicks = parseInt(String(seq.timebase), 10);
      if (!frameTicks || frameTicks <= 0) frameTicks = 8467200000;
      var fps = Math.round(ticksPerSec / frameTicks);
      if (fps <= 0) fps = 30;

      var inTicksRaw = String(seq.getInPointAsTicks());
      var outTicksRaw = String(seq.getOutPointAsTicks());
      var inTicksNum = parseFloat(inTicksRaw);
      var outTicksNum = parseFloat(outTicksRaw);
      var hasIO = !isNaN(inTicksNum) && !isNaN(outTicksNum) && inTicksNum >= 0 && outTicksNum > inTicksNum;

      var inTicks = hasIO ? inTicksRaw : null;
      var outTicks = hasIO ? outTicksRaw : null;
      var inSecNum = hasIO ? (inTicksNum / ticksPerSec) : null;
      var outSecNum = hasIO ? (outTicksNum / ticksPerSec) : null;

      var pos = seq.getPlayerPosition();
      var playheadTicks = pos ? String(pos.ticks) : "0";
      var playheadSec = pos ? Number(pos.seconds) : 0;

      var v1 = seq.videoTracks.numTracks > 0 ? seq.videoTracks[0] : null;
      var v1Clips = [];
      if (v1) {
        for (var i = 0; i < v1.clips.numItems; i++) {
          var c = v1.clips[i];
          var mp = "";
          if (c.projectItem && c.projectItem.getMediaPath) {
            mp = String(c.projectItem.getMediaPath() || "");
          }
          v1Clips.push({
            idx: i,
            name: String(c.name || ""),
            mediaPath: mp,
            startTicks: String(c.start.ticks),
            endTicks: String(c.end.ticks),
            inTicks: String(c.inPoint.ticks),
            outTicks: String(c.outPoint.ticks),
            startSec: Number(c.start.seconds),
            endSec: Number(c.end.seconds),
            inSec: Number(c.inPoint.seconds),
            outSec: Number(c.outPoint.seconds)
          });
        }
      }

      var seqEndTicks = String(seq.end);
      if (v1 && v1.clips.numItems > 0) {
        seqEndTicks = String(v1.clips[v1.clips.numItems - 1].end.ticks);
      }

      return kmJsonVal({
        ok: true,
        projectPath: String(proj.path),
        projectName: String(proj.name),
        projectDir: parentDirOf(proj.path),
        sequenceId: String(seq.sequenceID),
        sequenceName: String(seq.name),
        frameWidth: Number(seq.frameSizeHorizontal) || 1920,
        frameHeight: Number(seq.frameSizeVertical) || 1080,
        fps: fps,
        frameTicks: String(frameTicks),
        seqEndTicks: seqEndTicks,
        inTicks: inTicks,
        outTicks: outTicks,
        inSec: inSecNum,
        outSec: outSecNum,
        playheadTicks: playheadTicks,
        playheadSec: playheadSec,
        videoTrackCount: Number(seq.videoTracks.numTracks),
        audioTrackCount: Number(seq.audioTracks.numTracks),
        v1Clips: v1Clips
      });
    } catch (e) {
      return kmJsonVal({ ok: false, error: e.toString() });
    }
  };

  ns.saveCurrentProject = function (expectedPath) {
    try {
      var proj = expectedPath ? findProjectByPath(expectedPath) : app.project;
      if (!proj) return "ERROR: Target project is not open.";
      var ok = proj.save();
      return kmJsonVal({ ok: Boolean(ok), path: String(proj.path) });
    } catch (e) {
      return "ERROR: saveCurrentProject failed: " + e.toString();
    }
  };

  ns.pickBadgePngFile = function () {
    try {
      var f = File.openDialog("Select Watermark / Badge PNG", "*.png");
      if (!f) return kmJsonVal({ cancelled: true, path: "" });
      return kmJsonVal({ cancelled: false, path: String(f.fsName) });
    } catch (e) {
      return "ERROR: pickBadgePngFile failed: " + e.toString();
    }
  };

  ns.exportFrameAtTicks = function (ticksStr, outBaseNoExt, seqId) {
    try {
      var proj = app.project;
      if (!proj) return "ERROR: No active project.";
      var seq = seqId ? findSequenceById(proj, seqId) : proj.activeSequence;
      if (!seq) return "ERROR: Target sequence not found.";
      proj.activeSequence = seq;
      proj.openSequence(seq.sequenceID);
      seq.setPlayerPosition(String(ticksStr));
      $.sleep(60);
      app.enableQE();
      var qeseq = qe.project.getActiveSequence();
      if (!qeseq) return "ERROR: QE active sequence unavailable.";
      var tc = qeseq.CTI.timecode;
      var ok = qeseq.exportFramePNG(tc, String(outBaseNoExt));
      if (!ok) return "ERROR: exportFramePNG failed at " + tc;
      return kmJsonStr(String(outBaseNoExt) + ".png");
    } catch (e) {
      return "ERROR: exportFrameAtTicks failed: " + e.toString();
    }
  };

  ns.applyPhase1RazorAndNames = function (planJsonStr) {
    try {
      var plan = eval("(" + planJsonStr + ")");
      var proj = app.project;
      if (!proj) return "ERROR: No active project.";
      var seq = findSequenceById(proj, plan.sequenceId);
      if (!seq) return "ERROR: Sequence not found for Phase 1 cuts.";

      proj.activeSequence = seq;
      proj.openSequence(seq.sequenceID);
      app.enableQE();
      var qeseq = qe.project.getActiveSequence();
      if (!qeseq || String(qeseq.guid).replace(/[{}]/g, "").toLowerCase() !== String(plan.sequenceId).replace(/[{}]/g, "").toLowerCase()) {
        return "ERROR: QE sequence mismatch.";
      }

      var fps = Number(plan.fps) || 30;
      var qevt = qeseq.getVideoTrackAt(0);
      var qeat = seq.audioTracks.numTracks > 0 ? qeseq.getAudioTrackAt(0) : null;
      var v1 = seq.videoTracks[0];
      var a1 = seq.audioTracks.numTracks > 0 ? seq.audioTracks[0] : null;

      var existingBounds = {};
      var i;
      for (i = 0; i < v1.clips.numItems; i++) {
        existingBounds[Math.round(v1.clips[i].start.seconds * fps)] = true;
        existingBounds[Math.round(v1.clips[i].end.seconds * fps)] = true;
      }

      var razors = plan.razor_frames || [];
      var applied = 0;
      for (i = 0; i < razors.length; i++) {
        var f = Number(razors[i]);
        if (f > 0 && !existingBounds[f]) {
          var tc = frameToTc(f, fps);
          qevt.razor(tc);
          if (qeat) qeat.razor(tc);
          existingBounds[f] = true;
          applied++;
        }
      }

      var clips = plan.clips || [];
      var renamed = 0;
      for (i = 0; i < clips.length; i++) {
        var item = clips[i];
        var midSec = (item.start_frame + item.end_frame) / (2.0 * fps);
        for (var vcIdx = 0; vcIdx < v1.clips.numItems; vcIdx++) {
          var vc = v1.clips[vcIdx];
          if (midSec >= vc.start.seconds - 0.005 && midSec <= vc.end.seconds + 0.005) {
            vc.name = String(item.clip_label);
            renamed++;
            break;
          }
        }
        if (a1) {
          for (var acIdx = 0; acIdx < a1.clips.numItems; acIdx++) {
            var ac = a1.clips[acIdx];
            if (midSec >= ac.start.seconds - 0.005 && midSec <= ac.end.seconds + 0.005) {
              ac.name = String(item.clip_label);
              break;
            }
          }
        }
      }

      seq.setPlayerPosition("0");
      proj.save();
      return kmJsonVal({
        ok: true,
        razorsApplied: applied,
        clipsRenamed: renamed,
        v1Count: v1.clips.numItems,
        a1Count: a1 ? a1.clips.numItems : 0
      });
    } catch (e) {
      return "ERROR: applyPhase1RazorAndNames failed: " + e.toString();
    }
  };

  ns.hotSwapEditedProject = function (origPath, stagingPath, seqId, restorePlayheadTicks) {
    try {
      var oldProj = findProjectByPath(origPath);
      var oldSeq = oldProj ? findSequenceById(oldProj, seqId) : null;
      var baselineOffline = oldSeq ? countOfflineClips(oldSeq) : 0;

      var opened = app.openDocument(String(stagingPath), 1, 1, 1);
      if (!opened) {
        return "ERROR: app.openDocument failed for staging project.";
      }

      var stagingProj = findProjectByPath(stagingPath);
      if (!stagingProj) {
        for (var i = 0; i < app.projects.numProjects; i++) {
          if (String(app.projects[i].path).indexOf(".kahamatic_staging_") !== -1) {
            stagingProj = app.projects[i];
            break;
          }
        }
      }
      if (!stagingProj) {
        return "ERROR: Opened staging project could not be located in app.projects.";
      }

      var newSeq = findSequenceById(stagingProj, seqId) || stagingProj.activeSequence || stagingProj.sequences[0];
      if (!newSeq) {
        stagingProj.closeDocument(0, 0);
        return "ERROR: Target sequence missing in staging project.";
      }

      stagingProj.activeSequence = newSeq;
      stagingProj.openSequence(newSeq.sequenceID);
      app.project = stagingProj;

      var newOffline = countOfflineClips(newSeq);
      if (newOffline > baselineOffline) {
        stagingProj.closeDocument(0, 0);
        if (oldProj) app.project = oldProj;
        return "ERROR: Staged XML produced newly offline clips (" + newOffline + " > " + baselineOffline + "). Aborted safely.";
      }

      if (oldProj && oldProj !== stagingProj) {
        oldProj.closeDocument(0, 0);
      }

      var savedAs = stagingProj.saveAs(String(origPath));
      if (!savedAs) {
        return "ERROR: saveAs failed onto " + origPath;
      }

      stagingProj.openSequence(newSeq.sequenceID);
      $.sleep(250);
      if (restorePlayheadTicks) {
        newSeq.setPlayerPosition(String(restorePlayheadTicks));
      }
      stagingProj.save();

      return kmJsonVal({
        ok: true,
        projectPath: String(stagingProj.path),
        sequenceId: String(newSeq.sequenceID),
        videoTrackCount: Number(newSeq.videoTracks.numTracks)
      });
    } catch (e) {
      return "ERROR: hotSwapEditedProject failed: " + e.toString();
    }
  };
})($._Kahamatic);
