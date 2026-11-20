/* AW ZIP — zip.js 기반 ZIP 압축/해제 (UI 비의존) */
(function (root, factory) {
  const api = factory(root.AWCore || (typeof require === "function" ? require("./core.js") : null));
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWZip = api;
})(typeof self !== "undefined" ? self : this, function (AWCore) {
  "use strict";

  const SMALL_COMPRESS = 32 * 1024 * 1024;
  const SMALL_EXTRACT = 8 * 1024 * 1024;

  function abortErr() { return new DOMException("취소됨", "AbortError"); }

  /**
   * o: { zip, entries:[{path, dir, file}], out?:WritableStream, splitSize?, openPart?(i)→WritableStream,
   *      level, password, onProgress(doneBytes), onEntry(path), signal, concurrency }
   */
  async function compressZip(o) {
    const zip = o.zip;
    let target;
    if (o.splitSize) {
      const gen = (async function* () { for (let i = 1; ; i++) yield { writable: await o.openPart(i) }; })();
      target = new zip.SplitDataWriter(gen, o.splitSize);
    } else target = o.out;

    // 4GB 근처를 넘는 아카이브는 모든 항목을 Zip64로 (offset이 4GB를 넘는 항목 대비)
    const totalIn = o.entries.reduce((s, e) => s + (e.file ? e.file.size : 0), 0);
    const opts = { level: o.level, signal: o.signal, zip64: totalIn > 3.9e9 };
    if (o.password) { opts.password = o.password; opts.encryptionStrength = 3; }
    if (zip.createBlobTempStream) opts.createTempStream = zip.createBlobTempStream({ thresholdBytes: 16 * 1024 * 1024 });
    const zw = new zip.ZipWriter(target, opts);

    let doneBytes = 0;
    const pool = new Set();
    const maxPool = Math.max(1, o.concurrency || 4);
    const track = (p) => { pool.add(p); p.then(() => pool.delete(p), () => pool.delete(p)); };

    try {
      for (const e of o.entries) {
        if (o.signal && o.signal.aborted) throw abortErr();
        if (e.dir) {
          await Promise.all(pool);
          await zw.add(e.path.replace(/\/?$/, "/"), null, { directory: true, lastModDate: new Date() });
          continue;
        }
        let last = 0;
        const size = e.file.size;
        const p = zw.add(e.path, new zip.BlobReader(e.file), {
          lastModDate: new Date(e.file.lastModified || Date.now()),
          signal: o.signal,
          onstart: () => { if (o.onEntry) o.onEntry(e.path); },
          onprogress: (done) => { doneBytes += done - last; last = done; if (o.onProgress) o.onProgress(doneBytes); },
        }).then((r) => { doneBytes += size - last; last = size; if (o.onProgress) o.onProgress(doneBytes); return r; });
        if (size >= SMALL_COMPRESS) {
          await Promise.all(pool);
          await p;
        } else {
          track(p);
          if (pool.size >= maxPool) await Promise.race(pool);
        }
      }
      await Promise.all(pool);
      await zw.close();
    } catch (err) {
      try { await Promise.allSettled(pool); } catch (_) {}
      throw err;
    }
  }

  /* ZIP 열기(목록 읽기). blobs: Blob 하나 또는 분할 조각 배열(.z01..., .zip 순) */
  async function openZip(zip, blobs, encoding) {
    const reader = Array.isArray(blobs) && blobs.length > 1
      ? new zip.SplitDataReader(blobs.map((b) => new zip.BlobReader(b)))
      : new zip.BlobReader(Array.isArray(blobs) ? blobs[0] : blobs);
    const zr = new zip.ZipReader(reader, {
      decodeText: (value, _enc, type) => (type === "filename" || type === "comment" ? AWCore.decodeName(value, encoding) : undefined),
    });
    const entries = await zr.getEntries();
    return { zr, entries };
  }

  /**
   * o: { entries, sink:{mkdir(segs), createFile(segs)→WritableStream|null}, password, onProgress(doneBytes), onEntry(path), signal, concurrency }
   */
  async function extractZipEntries(o) {
    let doneBytes = 0, files = 0, skipped = 0;
    const pool = new Set();
    const maxPool = Math.max(1, o.concurrency || 4);
    const track = (p) => { pool.add(p); p.then(() => pool.delete(p), () => pool.delete(p)); };

    async function one(entry, segs) {
      const size = entry.uncompressedSize || 0;
      const ws = await o.sink.createFile(segs);
      if (!ws) { skipped++; doneBytes += size; if (o.onProgress) o.onProgress(doneBytes); return; }
      if (o.onEntry) o.onEntry(segs.join("/"));
      let last = 0;
      await entry.getData(ws, {
        password: o.password || undefined,
        signal: o.signal,
        onprogress: (done) => { doneBytes += done - last; last = done; if (o.onProgress) o.onProgress(doneBytes); },
      });
      doneBytes += size - last;
      files++;
      if (o.onProgress) o.onProgress(doneBytes);
    }

    try {
      for (const entry of o.entries) {
        if (o.signal && o.signal.aborted) throw abortErr();
        const segs = AWCore.sanitizePath(entry.filename);
        if (!segs.length) continue;
        if (entry.directory) { await o.sink.mkdir(segs); continue; }
        const p = one(entry, segs);
        if ((entry.uncompressedSize || 0) >= SMALL_EXTRACT) {
          await Promise.all(pool);
          await p;
        } else {
          track(p);
          if (pool.size >= maxPool) await Promise.race(pool);
        }
      }
      await Promise.all(pool);
    } catch (err) {
      try { await Promise.allSettled(pool); } catch (_) {}
      throw err;
    }
    return { files, skipped };
  }

  return { compressZip, openZip, extractZipEntries };
});
