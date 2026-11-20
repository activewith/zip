/* AW ZIP — UI */
(function () {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const C = window.AWCore, Z = window.AWZip, zipLib = window.zip;
  const fmt = C.formatBytes;
  const HW = Math.min(navigator.hardwareConcurrency || 4, 8);

  const supported = "showDirectoryPicker" in window && "showSaveFilePicker" in window;
  if (!supported) $("unsupported").hidden = false;
  zipLib.configure({ useWebWorkers: true, maxWorkers: HW });

  let busy = false;
  window.addEventListener("beforeunload", (e) => { if (busy) { e.preventDefault(); e.returnValue = ""; } });

  /* ---------- 탭 ---------- */
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => {
    if (busy) return;
    document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", String(x === t)));
    $("tab-c").hidden = t.dataset.tab !== "c";
    $("tab-x").hidden = t.dataset.tab !== "x";
  }));

  /* ---------- 공용: 메시지 / 진행률 ---------- */
  function msg(el, type, text) { el.className = "msg show " + type; el.textContent = text; }
  function clearMsg(el) { el.className = "msg"; el.textContent = ""; }

  function makeProgress(box) {
    const bar = box.querySelector(".bar > i"), pct = box.querySelector(".pct"), bytes = box.querySelector(".bytes"),
      speed = box.querySelector(".speed"), eta = box.querySelector(".eta"), file = box.querySelector(".pfile");
    let total = 0, done = 0, cur = "", t0 = 0, raf = 0, samples = [];
    function render() {
      raf = 0;
      const now = performance.now();
      samples.push([now, done]);
      while (samples.length > 2 && now - samples[0][0] > 4000) samples.shift();
      const [st, sd] = samples[0];
      const sp = now - st > 300 ? (done - sd) / ((now - st) / 1000) : 0;
      const p = total ? Math.min(100, (done / total) * 100) : 0;
      bar.style.width = p.toFixed(1) + "%";
      pct.textContent = p.toFixed(1) + "%";
      bytes.textContent = fmt(done) + " / " + fmt(total);
      speed.textContent = sp > 0 ? fmt(sp) + "/s" : "";
      eta.textContent = sp > 0 && total > done ? "남은 시간 " + hms((total - done) / sp) : "";
      file.textContent = cur;
    }
    function schedule() { if (!raf) raf = requestAnimationFrame(render); }
    return {
      start(t) { total = t; done = 0; cur = ""; t0 = performance.now(); samples = []; box.classList.add("show"); render(); },
      set(d) { done = d; schedule(); },
      file(name) { cur = name; schedule(); },
      finish() { done = total; cur = ""; render(); eta.textContent = ""; },
      elapsed() { return (performance.now() - t0) / 1000; },
      hide() { box.classList.remove("show"); },
    };
  }
  function hms(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
    return h ? h + "시간 " + m + "분" : m ? m + "분 " + x + "초" : x + "초";
  }
  function errText(e) {
    if (!e) return "알 수 없는 오류";
    const m = String(e.message || e);
    if (e.name === "AbortError" || /abort|취소/i.test(m)) return "취소되었습니다.";
    if (/Invalid password|ERR_INVALID_PASSWORD/i.test(m)) return "암호가 틀렸습니다.";
    if (/Encrypted|ERR_ENCRYPTED/i.test(m)) return "암호가 필요합니다. 암호를 입력하세요.";
    if (e.name === "QuotaExceededError" || /quota|space/i.test(m)) return "디스크 공간이 부족합니다.";
    if (e.name === "NotAllowedError") return "폴더/파일 접근이 허용되지 않았습니다. (시스템 폴더는 고를 수 없으니 하위 폴더를 고르세요)";
    if (e.name === "NotReadableError") return "원본 파일을 읽을 수 없습니다. 작업 중 파일이 바뀌었거나 이동되었을 수 있습니다.";
    if (e.name === "TypeMismatchError") return "같은 이름의 파일과 폴더가 겹칩니다: " + m;
    if (/End of central directory not found|ERR_EOCDR/i.test(m)) return "ZIP 파일이 아니거나 손상되었습니다. 분할 압축이면 조각 전체를 함께 선택하세요.";
    if (/Split zip file|ERR_SPLIT/i.test(m)) return "분할 ZIP입니다. .z01 ~ .zip 조각 전체를 함께 선택하세요.";
    return m;
  }
  const isPickerCancel = (e) => e && e.name === "AbortError" && /user aborted|abort/i.test(String(e.message));

  /* ---------- 디렉터리 쓰기 sink ---------- */
  function dirSink(root, overwrite) {
    const cache = new Map();
    function getDir(segs) {
      if (!segs.length) return Promise.resolve(root);
      const key = segs.join("/");
      if (!cache.has(key)) cache.set(key, getDir(segs.slice(0, -1)).then((p) => p.getDirectoryHandle(segs[segs.length - 1], { create: true })));
      return cache.get(key);
    }
    return {
      mkdir: (segs) => getDir(segs),
      async createFile(segs) {
        const d = await getDir(segs.slice(0, -1));
        const name = segs[segs.length - 1];
        if (!overwrite) {
          try { await d.getFileHandle(name); return null; } catch (e) { /* 없음 → 생성 */ }
        }
        const fh = await d.getFileHandle(name, { create: true });
        return fh.createWritable();
      },
    };
  }

  // 실제 파일 writable을 앱이 직접 잡아 두는 래퍼 — 실패/취소 시 확실히 abort 가능
  function owned(real, registry) {
    const w = real.getWriter();
    const rec = { w, closed: false };
    registry.push(rec);
    return new WritableStream({
      write: (c) => w.write(c),
      close: async () => { await w.close(); rec.closed = true; },
      abort: async (r) => { if (!rec.closed) { rec.closed = true; try { await w.abort(r); } catch (e) {} } },
    });
  }
  async function abortAll(registry) {
    for (const rec of registry) if (!rec.closed) { rec.closed = true; try { await rec.w.abort(); } catch (e) {} }
  }

  /* ---------- 폴더 선택 (차단 폴더 안내 포함) ---------- */
  let guideSeen = false;
  try { guideSeen = localStorage.getItem("awzip-folder-guide") === "1"; } catch (e) {}
  function showGuide(title, retry) {
    const d = $("folderGuide");
    $("fgTitle").textContent = title;
    $("fgRetry").hidden = !retry;
    return new Promise((resolve) => {
      const done = (v) => { $("fgPick").onclick = $("fgCancel").onclick = d.oncancel = null; if (d.open) d.close(); resolve(v); };
      $("fgPick").onclick = () => done(true);
      $("fgCancel").onclick = () => done(false);
      d.oncancel = (e) => { e.preventDefault(); done(false); }; // Esc
      d.showModal();
    });
  }
  async function pickFolder(id, title) {
    const open = () => window.showDirectoryPicker({ id, mode: "readwrite", startIn: "downloads" });
    let retry = false;
    if (guideSeen) {
      try { return await open(); } catch (e) { if (e.name !== "AbortError") throw e; retry = true; }
    }
    for (;;) {
      if (!(await showGuide(title, retry))) throw new DOMException("The user aborted a request.", "AbortError");
      try {
        const h = await open();
        guideSeen = true;
        try { localStorage.setItem("awzip-folder-guide", "1"); } catch (e) {}
        return h;
      } catch (e) {
        if (e.name !== "AbortError") throw e;
        retry = true;
      }
    }
  }

  async function exists(dir, name) { try { await dir.getFileHandle(name); return true; } catch (e) { return false; } }
  async function removeIfExists(dir, name) { try { await dir.removeEntry(name); } catch (e) {} }
  async function renameInDir(dir, from, to) {
    if (from === to) return;
    const fh = await dir.getFileHandle(from);
    await removeIfExists(dir, to);
    if (typeof fh.move === "function") {
      try { await fh.move(to); return; } catch (e) { /* 아래 복사 방식으로 */ }
    }
    const src = await fh.getFile();
    const dst = await (await dir.getFileHandle(to, { create: true })).createWritable();
    await src.stream().pipeTo(dst);
    await dir.removeEntry(from);
  }

  /* =========================================================
     압축
     ========================================================= */
  let items = []; // {path, dir, file}
  let used = new Set();
  const cProg = makeProgress($("cProg"));

  function addItem(path, file, dir) {
    if (dir) {
      const key = path.toLowerCase() + "/";
      if (used.has(key)) return;
      used.add(key);
      items.push({ path, dir: true });
    } else {
      items.push({ path: C.makeUniquePath(path, used), file });
    }
  }

  async function walkDir(handle, prefix, onCount) {
    addItem(prefix, null, true);
    for await (const [name, h] of handle.entries()) {
      const p = prefix + "/" + name;
      if (h.kind === "directory") await walkDir(h, p, onCount);
      else { addItem(p, await h.getFile()); onCount(); }
    }
  }

  function defaultName() {
    const top = new Set(items.map((i) => i.path.split("/")[0]));
    if (top.size === 1) {
      const n = [...top][0];
      const one = items.find((i) => i.path === n && !i.dir);
      return one ? n.replace(/\.[^.]+$/, "") || n : n;
    }
    return "압축파일";
  }

  function renderItems() {
    const files = items.filter((i) => !i.dir);
    const total = files.reduce((s, i) => s + i.file.size, 0);
    const list = $("cList");
    if (!items.length) {
      list.innerHTML = ""; $("cSummary").textContent = ""; $("cClear").hidden = true; $("cStart").disabled = true; return;
    }
    const MAX = 300;
    let html = "<table>";
    files.slice(0, MAX).forEach((i) => {
      html += `<tr><td class="name">${esc(i.path)}</td><td class="size">${fmt(i.file.size)}</td><td class="act"><button class="btn small" data-rm="${esc(i.path)}">✕</button></td></tr>`;
    });
    html += "</table>";
    if (files.length > MAX) html += `<div class="more">… 외 ${(files.length - MAX).toLocaleString()}개 파일</div>`;
    list.innerHTML = html;
    const dirs = items.length - files.length;
    $("cSummary").textContent = `파일 ${files.length.toLocaleString()}개${dirs ? ", 폴더 " + dirs.toLocaleString() + "개" : ""} · 총 ${fmt(total)}`;
    $("cClear").hidden = false;
    $("cStart").disabled = busy || !files.length;
    if (!$("cName").dataset.touched) $("cName").value = defaultName();
    updateFormatUI();
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  $("cList").addEventListener("click", (e) => {
    const p = e.target.dataset && e.target.dataset.rm;
    if (p === undefined || busy) return;
    items = items.filter((i) => i.path !== p);
    used = new Set(items.map((i) => i.path.toLowerCase() + (i.dir ? "/" : "")));
    renderItems();
  });
  $("cClear").onclick = () => { if (busy) return; items = []; used = new Set(); delete $("cName").dataset.touched; $("cName").value = ""; clearMsg($("cMsg")); cProg.hide(); renderItems(); };
  $("cName").addEventListener("input", () => { $("cName").dataset.touched = "1"; });

  $("cAddFiles").onclick = () => $("cFileInput").click();
  $("cFileInput").onchange = (e) => { for (const f of e.target.files) addItem(f.name, f); e.target.value = ""; renderItems(); };
  $("cAddFolder").onclick = async () => {
    try {
      const h = await window.showDirectoryPicker({ id: "awzip-src", mode: "read" });
      await scanWithStatus(async (tick) => walkDir(h, h.name, tick));
    } catch (e) { if (!isPickerCancel(e)) msg($("cMsg"), "err", errText(e)); }
  };
  async function scanWithStatus(fn) {
    let n = 0;
    const s = $("cSummary");
    const t = setInterval(() => { s.textContent = `폴더 읽는 중… ${n.toLocaleString()}개`; }, 200);
    try { await fn(() => n++); } finally { clearInterval(t); renderItems(); }
  }

  setupDrop($("cDrop"), async (dt) => {
    const handles = [];
    const plain = [];
    for (const it of dt.items) {
      if (it.kind !== "file") continue;
      if (it.getAsFileSystemHandle) handles.push(it.getAsFileSystemHandle());
      else plain.push(it.getAsFile());
    }
    const hs = await Promise.all(handles);
    await scanWithStatus(async (tick) => {
      for (const h of hs) {
        if (!h) continue;
        if (h.kind === "directory") await walkDir(h, h.name, tick);
        else { addItem(h.name, await h.getFile()); tick(); }
      }
      for (const f of plain) if (f) { addItem(f.name, f); tick(); }
    });
  });

  function setupDrop(el, onDrop) {
    el.addEventListener("dragover", (e) => { e.preventDefault(); if (!busy) el.classList.add("over"); });
    el.addEventListener("dragleave", () => el.classList.remove("over"));
    el.addEventListener("drop", (e) => {
      e.preventDefault(); el.classList.remove("over");
      if (busy) return;
      onDrop(e.dataTransfer).catch((err) => msg(el.closest(".panel").querySelector(".msg"), "err", errText(err)));
    });
  }

  const EXT = { zip: ".zip", tgz: ".tar.gz", tar: ".tar", gz: ".gz" };
  function updateFormatUI() {
    const f = $("cFormat").value;
    $("cLevelWrap").hidden = f !== "zip";
    $("cPwWrap").hidden = f !== "zip";
    const files = items.filter((i) => !i.dir);
    const base = (f === "gz" && files.length === 1) ? files[0].path.split("/").pop() : null;
    $("cNameHint").textContent = base ? "결과: " + base + ".gz (원본 이름 사용)" : EXT[f];
    $("cName").disabled = Boolean(base);
    const sp = $("cSplit").value !== "0";
    $("cSplitHint").textContent = !sp ? "분할 시 저장할 폴더를 고릅니다."
      : f === "zip" ? "ZIP 표준 분할: 이름.z01, 이름.z02 … 이름.zip (마지막 조각이 .zip)"
      : "단순 분할: 이름" + EXT[f] + ".001, .002 … (해제 시 조각을 함께 선택)";
    $("cSplitCustom").hidden = $("cSplit").value !== "custom";
    $("cLevelHint").textContent = $("cLevel").value === "9" ? "최대는 브라우저 내장 엔진 대신 자체 엔진을 써서 표준보다 몇 배 느립니다." : $("cLevel").value === "0" ? "압축 없이 묶기만 합니다. 동영상·사진처럼 이미 압축된 파일에 적합합니다." : "표준은 브라우저 내장 엔진을 써서 가장 빠릅니다.";
  }
  ["cFormat", "cSplit", "cLevel"].forEach((id) => $(id).addEventListener("change", updateFormatUI));
  updateFormatUI();

  function splitSize() {
    const v = $("cSplit").value;
    if (v === "0") return 0;
    if (v === "custom") {
      const mb = Number($("cSplitCustom").value);
      if (!(mb >= 1)) throw new Error("분할 크기를 MB 단위로 입력하세요 (1 이상).");
      return Math.floor(mb * 1024 * 1024);
    }
    return Number(v);
  }
  function safeFileName(n) { return C.sanitizePath(n).join("_") || "압축파일"; }

  let cAbort = null;
  $("cCancel").onclick = () => { if (cAbort) cAbort.abort(); };

  $("cStart").onclick = async () => {
    clearMsg($("cMsg"));
    const files = items.filter((i) => !i.dir);
    if (!files.length) return;
    const format = $("cFormat").value;
    let split, outDir = null, outHandle = null, base;
    try {
      split = splitSize();
      if (format === "gz" && files.length !== 1) throw new Error("GZ는 파일 1개만 압축할 수 있습니다. 여러 파일은 TAR.GZ나 ZIP을 고르세요.");
      base = format === "gz" ? files[0].path.split("/").pop() : safeFileName($("cName").value.trim() || defaultName());
      const ext = format === "gz" ? ".gz" : EXT[format];
      if (split) {
        outDir = await pickFolder("awzip-out", "분할 압축파일을 저장할 폴더 선택");
        // 기존 조각 정리
        const names = [];
        for await (const [n, h] of outDir.entries()) if (h.kind === "file") names.push(n);
        const lower = base.toLowerCase();
        const clash = names.filter((n) => {
          const l = n.toLowerCase();
          return format === "zip" ? (l === lower + ".zip" || new RegExp("^" + escRe(lower) + "\\.z\\d{2,3}$").test(l))
            : (l === (lower + ext) || new RegExp("^" + escRe(lower + ext) + "\\.\\d{3}$").test(l));
        });
        if (clash.length) {
          if (!confirm(`선택한 폴더에 같은 이름의 압축파일(조각)이 ${clash.length}개 있습니다.\n삭제하고 새로 만들까요?\n\n${clash.slice(0, 8).join("\n")}${clash.length > 8 ? "\n…" : ""}`)) return;
          for (const n of clash) await removeIfExists(outDir, n);
        }
      } else {
        outHandle = await window.showSaveFilePicker({ id: "awzip-out", suggestedName: base + ext });
      }
    } catch (e) {
      if (!isPickerCancel(e)) msg($("cMsg"), "err", errText(e));
      return;
    }

    const total = files.reduce((s, i) => s + i.file.size, 0);
    setBusy(true, "c");
    cAbort = new AbortController();
    const signal = cAbort.signal;
    cProg.start(total);
    const created = [];
    const writers = [];
    const ext = format === "gz" ? ".gz" : EXT[format];

    try {
      if (format === "zip") {
        const o = {
          zip: zipLib, entries: items, level: Number($("cLevel").value), password: $("cPw").value || "",
          signal, concurrency: HW,
          onProgress: (d) => cProg.set(d), onEntry: (p) => cProg.file(p),
        };
        if (split) {
          o.splitSize = split;
          o.openPart = async (i) => {
            const n = base + ".z" + String(i).padStart(2, "0");
            created.push(n);
            return owned(await (await outDir.getFileHandle(n, { create: true })).createWritable(), writers);
          };
        } else {
          o.out = owned(await outHandle.createWritable(), writers);
        }
        await Z.compressZip(o);
        if (split) {
          const last = created[created.length - 1];
          await renameInDir(outDir, last, base + ".zip");
          created[created.length - 1] = base + ".zip";
        }
      } else {
        // TAR / TAR.GZ / GZ
        let done = 0;
        const onBytes = (n) => { done += n; cProg.set(done); };
        let src;
        if (format === "gz") {
          cProg.file(files[0].path);
          src = files[0].file.stream().pipeThrough(C.countingStream(onBytes)).pipeThrough(new CompressionStream("gzip"));
        } else {
          let idx = 0;
          const tarEntries = items.map((i) => i);
          src = C.createTarStream(tarEntries, (n) => { onBytes(n); });
          if (format === "tgz") src = src.pipeThrough(new CompressionStream("gzip"));
          // 현재 파일 표시는 근사치(누적 바이트 기준)
          const sizes = tarEntries.map((e) => (e.dir ? 0 : e.file.size));
          let acc = 0;
          const t = setInterval(() => {
            while (idx < tarEntries.length && acc + sizes[idx] <= done && (sizes[idx] > 0 || tarEntries[idx].dir)) { acc += sizes[idx]; idx++; }
            if (tarEntries[idx]) cProg.file(tarEntries[idx].path);
          }, 300);
          signal.addEventListener("abort", () => clearInterval(t));
          src = src.pipeThrough(new TransformStream({ flush() { clearInterval(t); } }));
        }
        let dest;
        if (split) {
          dest = C.createSplitWritable(async (i) => {
            const n = base + ext + "." + String(i).padStart(3, "0");
            created.push(n);
            return owned(await (await outDir.getFileHandle(n, { create: true })).createWritable(), writers);
          }, split);
        } else {
          dest = owned(await outHandle.createWritable(), writers);
        }
        await src.pipeTo(dest, { signal });
        if (split && created.length === 1) {
          await renameInDir(outDir, created[0], base + ext);
          created[0] = base + ext;
        }
      }
      cProg.finish();
      const sec = cProg.elapsed();
      let outInfo;
      if (split) {
        let outTotal = 0;
        for (const n of created) outTotal += (await (await outDir.getFileHandle(n)).getFile()).size;
        outInfo = `${outDir.name} 폴더에 ${created.length}개 파일 · ${fmt(outTotal)}\n${created.length > 6 ? created.slice(0, 3).join(", ") + " … " + created.slice(-2).join(", ") : created.join(", ")}`;
      } else {
        const f = await outHandle.getFile();
        outInfo = `${f.name} · ${fmt(f.size)}` + (total ? ` (원본 대비 ${((f.size / total) * 100).toFixed(1)}%)` : "");
      }
      msg($("cMsg"), "ok", `압축 완료 — ${hms(sec)} 소요, 평균 ${fmt(total / Math.max(sec, 0.001))}/s\n${outInfo}`);
    } catch (e) {
      await abortAll(writers);
      if (split && outDir) for (const n of created) await removeIfExists(outDir, n);
      msg($("cMsg"), "err", "압축 실패: " + errText(e) + (signal.aborted ? "" : "\n만들던 파일은 삭제(또는 저장 취소)되었습니다."));
      cProg.hide();
    } finally {
      cAbort = null;
      setBusy(false, "c");
    }
  };
  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

  function setBusy(b, which) {
    busy = b;
    $(which + "Cancel").hidden = !b;
    $("cStart").disabled = b || !items.some((i) => !i.dir);
    $("xStart").disabled = b || !xState;
    document.querySelectorAll(".panel input, .panel select, #cAddFiles, #cAddFolder, #cClear, #xPick").forEach((el) => { el.disabled = b; });
    if (!b) updateFormatUI();
  }

  /* =========================================================
     압축 풀기
     ========================================================= */
  let xState = null; // {kind, ordered, name, blob, format, zr, entries}
  const xProg = makeProgress($("xProg"));

  $("xPick").onclick = () => $("xFileInput").click();
  $("xFileInput").onchange = (e) => { const f = [...e.target.files]; e.target.value = ""; if (f.length) loadArchive(f); };
  setupDrop($("xDrop"), async (dt) => {
    const f = [...dt.files];
    if (f.length) await loadArchive(f);
  });
  $("xEnc").addEventListener("change", () => { if (xState && xState.format === "zip") openZipState().catch((e) => msg($("xMsg"), "err", errText(e))); });

  async function loadArchive(files) {
    clearMsg($("xMsg")); xProg.hide();
    $("xInfo").classList.remove("show"); $("xList").innerHTML = ""; $("xOpts").hidden = true; $("xStart").disabled = true;
    if (xState && xState.zr) { try { await xState.zr.close(); } catch (e) {} }
    xState = null;
    try {
      const cls = C.classifyParts(files);
      const blob = cls.kind === "plainSplit" ? new Blob(cls.ordered) : cls.ordered[0];
      const nameForType = cls.kind === "zipSplit" ? cls.name : cls.name;
      const head = new Uint8Array(await (cls.kind === "zipSplit" ? cls.ordered[0] : blob).slice(0, 512).arrayBuffer());
      let format = cls.kind === "zipSplit" ? "zip" : C.detectFormat(nameForType, head);
      const total = cls.ordered.reduce((s, f) => s + f.size, 0);
      xState = { ...cls, blob, format, total };
      if (format === "unsupported") throw new Error("이 형식(" + (nameForType.split(".").pop() || "").toUpperCase() + ")은 아직 지원하지 않습니다. 지원: ZIP, TAR, TAR.GZ, GZ");
      if (format === "unknown") throw new Error("압축파일 형식을 알 수 없습니다. 지원: ZIP, TAR, TAR.GZ, GZ");
      if (format === "zip" && cls.kind === "single" && head[0] === 0x50 && head[1] === 0x4b && head[2] === 7 && head[3] === 8)
        throw new Error("분할 ZIP의 첫 조각입니다. .z01 ~ .zip 조각 전체를 함께 선택하세요.");
      $("xOpts").hidden = false;
      $("xEncWrap").hidden = format !== "zip";
      $("xPwWrap").hidden = true;
      if (format === "zip") await openZipState();
      else {
        const label = format === "tar" ? "TAR" : /\.(tgz|tar\.gz)$/i.test(nameForType) ? "TAR.GZ" : "GZ";
        showInfo(`<span class="tag">${label}</span><b>${esc(nameForType)}</b> · ${fmt(total)}${cls.ordered.length > 1 ? " · 조각 " + cls.ordered.length + "개" : ""}<br><span style="color:var(--muted)">이 형식은 미리 목록을 볼 수 없고, 푸는 동안 파일이 표시됩니다.</span>`);
        $("xStart").disabled = false;
      }
    } catch (e) {
      xState = null;
      msg($("xMsg"), "err", errText(e));
    }
  }
  function showInfo(html) { $("xInfo").innerHTML = html; $("xInfo").classList.add("show"); }

  async function openZipState() {
    const s = xState;
    if (s.zr) { try { await s.zr.close(); } catch (e) {} }
    const { zr, entries } = await Z.openZip(zipLib, s.kind === "zipSplit" ? s.ordered : s.blob, $("xEnc").value);
    s.zr = zr; s.entries = entries;
    const files = entries.filter((e) => !e.directory);
    const usize = files.reduce((a, e) => a + (e.uncompressedSize || 0), 0);
    const enc = files.some((e) => e.encrypted);
    $("xPwWrap").hidden = !enc;
    showInfo(`<span class="tag">ZIP</span><b>${esc(s.name)}</b> · ${fmt(s.total)}${s.ordered.length > 1 ? " · 조각 " + s.ordered.length + "개" : ""}<br>파일 ${files.length.toLocaleString()}개 · 풀면 ${fmt(usize)}${enc ? ' · <b style="color:var(--warn)">암호 있음</b>' : ""}`);
    const MAX = 500;
    let html = "<table>";
    files.slice(0, MAX).forEach((e) => { html += `<tr><td class="name">${esc(e.filename)}${e.encrypted ? " 🔒" : ""}</td><td class="size">${fmt(e.uncompressedSize)}</td></tr>`; });
    html += "</table>";
    if (files.length > MAX) html += `<div class="more">… 외 ${(files.length - MAX).toLocaleString()}개</div>`;
    $("xList").innerHTML = html;
    s.usize = usize;
    $("xStart").disabled = busy;
  }

  let xAbort = null, xCancelHook = null;
  $("xCancel").onclick = () => { if (xAbort) xAbort.abort(); if (xCancelHook) xCancelHook(); };

  function stripArchiveExt(n) {
    return n.replace(/\.(tar\.gz|tgz|tar|zip|gz)$/i, "") || "압축해제";
  }

  $("xStart").onclick = async () => {
    if (!xState) return;
    clearMsg($("xMsg"));
    const s = xState;
    if (s.format === "zip" && s.entries.some((e) => e.encrypted) && !$("xPw").value) {
      msg($("xMsg"), "err", "암호를 입력하세요."); $("xPw").focus(); return;
    }
    let root;
    try {
      root = await pickFolder("awzip-extract", "압축을 풀 폴더 선택");
    } catch (e) { if (!isPickerCancel(e)) msg($("xMsg"), "err", errText(e)); return; }

    setBusy(true, "x");
    xAbort = new AbortController();
    const signal = xAbort.signal;
    const overwrite = $("xOverwrite").checked;
    let target = root, folderName = root.name;
    let br = null;
    try {
      let sinkObj = null;
      const getSink = async (useFolder) => {
        if (sinkObj) return sinkObj;
        if (useFolder && $("xMkdir").checked) {
          const sub = C.sanitizePath(stripArchiveExt(s.name)).join("_") || "압축해제";
          target = await root.getDirectoryHandle(sub, { create: true });
          folderName = root.name + "/" + sub;
        }
        return (sinkObj = dirSink(target, overwrite));
      };
      let result = { files: 0, skipped: 0 };

      if (s.format === "zip") {
        xProg.start(s.usize);
        const sink = await getSink(true);
        result = await Z.extractZipEntries({
          entries: s.entries, sink, password: $("xPw").value || "", signal, concurrency: Math.min(HW, 4),
          onProgress: (d) => xProg.set(d), onEntry: (p) => xProg.file(p),
        });
      } else {
        xProg.start(s.total);
        let readBytes = 0;
        let stream = s.blob.stream().pipeThrough(C.countingStream((n) => { readBytes += n; xProg.set(readBytes); }));
        if (s.format === "gz") stream = stream.pipeThrough(new DecompressionStream("gzip"));
        br = new C.ByteReader(stream);
        xCancelHook = () => br.cancel();
        const opts = { signal, onEntry: (p) => { xProg.file(p); result.files++; } };
        let isTar = s.format === "tar";
        if (s.format === "gz") {
          const head = await br.peek(512);
          isTar = C.detectFormat("", head) === "tar";
        }
        const sink = await getSink(isTar);
        if (isTar) {
          const countSkip = { n: 0 };
          const tarSink = {
            mkdir: sink.mkdir,
            async createFile(segs) { const w = await sink.createFile(segs); if (!w) countSkip.n++; return w; },
          };
          await C.extractTar(br, tarSink, opts);
          result.skipped = countSkip.n;
          result.files -= countSkip.n;
        } else {
          // 단일 GZ
          const outName = C.sanitizePath(s.name.replace(/\.gz$/i, "") || "output").join("_");
          xProg.file(outName);
          const ws = await sink.createFile([outName]);
          if (ws) {
            const w = ws.getWriter();
            try { await br.pipe(Infinity, w); await w.close(); } catch (e) { try { await w.abort(e); } catch (_) {} throw e; }
            result.files = 1;
          } else result.skipped = 1;
        }
      }
      if (signal.aborted) throw new DOMException("취소됨", "AbortError");
      xProg.finish();
      const sec = xProg.elapsed();
      msg($("xMsg"), "ok", `압축 풀기 완료 — ${hms(sec)} 소요\n${folderName} 폴더에 파일 ${result.files.toLocaleString()}개${result.skipped ? ` (같은 이름이 있어 건너뜀 ${result.skipped.toLocaleString()}개)` : ""}`);
    } catch (e) {
      const t = signal.aborted ? "취소되었습니다." : errText(e);
      msg($("xMsg"), "err", "압축 풀기 실패: " + t + "\n이미 풀린 파일은 폴더에 남아 있습니다.");
      xProg.hide();
    } finally {
      xAbort = null; xCancelHook = null;
      setBusy(false, "x");
      $("xStart").disabled = !xState;
    }
  };
})();
