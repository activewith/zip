/* AW ZIP core — 브라우저/Node 공용 로직 (UI 비의존) */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AWCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const enc = new TextEncoder();
  const BLOCK = 512;

  /* ---------- 공용 ---------- */
  function concat(a, b) {
    const out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }

  function formatBytes(n) {
    if (!isFinite(n) || n < 0) return "-";
    const u = ["B", "KB", "MB", "GB", "TB"];
    let i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n.toFixed(0) : n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)) + " " + u[i];
  }

  /* 파일명 디코딩: auto = 올바른 UTF-8이면 UTF-8, 아니면 CP949(euc-kr) */
  function decodeName(bytes, mode) {
    mode = mode || "auto";
    if (mode === "utf-8") return new TextDecoder("utf-8").decode(bytes);
    if (mode === "cp949") return new TextDecoder("euc-kr").decode(bytes);
    if (mode === "cp437") return undefined; // zip.js 기본 처리
    let ascii = true;
    for (let i = 0; i < bytes.length; i++) if (bytes[i] > 0x7f) { ascii = false; break; }
    if (ascii) return new TextDecoder("utf-8").decode(bytes);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (e) {
      return new TextDecoder("euc-kr").decode(bytes);
    }
  }

  /* 경로 정리: '..' / 절대경로 / 윈도우 금지문자 제거. 안전한 세그먼트 배열 반환 */
  const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;
  function sanitizePath(path) {
    const segs = String(path).replace(/\\/g, "/").split("/");
    const out = [];
    for (let s of segs) {
      if (s === "" || s === "." || s === "..") continue;
      s = s.replace(/[<>:"|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/, "");
      if (!s) s = "_";
      if (RESERVED.test(s)) s = "_" + s;
      if (s.length > 240) s = s.slice(0, 240);
      out.push(s);
    }
    return out;
  }

  /* 같은 경로 중복 시 "이름 (2).ext" */
  function makeUniquePath(path, used) {
    if (!used.has(path.toLowerCase())) { used.add(path.toLowerCase()); return path; }
    const slash = path.lastIndexOf("/");
    const dir = path.slice(0, slash + 1);
    const base = path.slice(slash + 1);
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let i = 2; ; i++) {
      const p = dir + stem + " (" + i + ")" + ext;
      if (!used.has(p.toLowerCase())) { used.add(p.toLowerCase()); return p; }
    }
  }

  /* ---------- 분할 파일 판별 ---------- */
  // files: [{name, ...}] → {kind, ordered, name}
  //  kind: 'single' | 'zipSplit'(.z01..+.zip) | 'plainSplit'(.001,.002..)
  function classifyParts(files) {
    const list = Array.from(files);
    if (list.length === 1) {
      const f = list[0];
      const m = f.name.match(/^(.*)\.(\d{3})$/);
      if (m && Number(m[2]) === 1) return { kind: "plainSplit", ordered: list, name: m[1] };
      return { kind: "single", ordered: list, name: f.name };
    }
    // .z01 계열
    const zParts = [], zipMain = [], numParts = [], other = [];
    for (const f of list) {
      let m;
      if ((m = f.name.match(/^(.*)\.z(\d{2,3})$/i))) zParts.push({ f, base: m[1], n: Number(m[2]) });
      else if ((m = f.name.match(/^(.*)\.zip$/i))) zipMain.push({ f, base: m[1] });
      else if ((m = f.name.match(/^(.*)\.(\d{3})$/))) numParts.push({ f, base: m[1], n: Number(m[2]) });
      else other.push(f);
    }
    if (zParts.length && zipMain.length === 1 && !numParts.length && !other.length) {
      const base = zipMain[0].base;
      if (zParts.some((p) => p.base !== base)) throw new Error("서로 다른 압축파일의 분할 조각이 섞여 있습니다.");
      zParts.sort((a, b) => a.n - b.n);
      zParts.forEach((p, i) => { if (p.n !== i + 1) throw new Error("분할 조각이 빠져 있습니다: " + base + ".z" + String(i + 1).padStart(2, "0")); });
      return { kind: "zipSplit", ordered: zParts.map((p) => p.f).concat([zipMain[0].f]), name: zipMain[0].f.name };
    }
    if (numParts.length === list.length) {
      const base = numParts[0].base;
      if (numParts.some((p) => p.base !== base)) throw new Error("서로 다른 파일의 분할 조각이 섞여 있습니다.");
      numParts.sort((a, b) => a.n - b.n);
      numParts.forEach((p, i) => { if (p.n !== i + 1) throw new Error("분할 조각이 빠져 있습니다: " + base + "." + String(i + 1).padStart(3, "0")); });
      return { kind: "plainSplit", ordered: numParts.map((p) => p.f), name: base };
    }
    if (zParts.length && !zipMain.length) throw new Error("분할 ZIP의 마지막 조각(.zip 파일)도 함께 선택하세요.");
    throw new Error("압축파일은 하나씩 선택하세요. (분할 압축은 모든 조각을 함께 선택)");
  }

  // 이름 + 앞부분 바이트로 포맷 판별
  function detectFormat(name, head) {
    const n = name.toLowerCase();
    const b = head || new Uint8Array(0);
    const isZip = b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7);
    const isGz = b[0] === 0x1f && b[1] === 0x8b;
    const isTar = b.length >= 262 && String.fromCharCode(b[257], b[258], b[259], b[260], b[261]) === "ustar";
    if (isZip) return "zip";
    if (isGz) return "gz"; // tar.gz 여부는 풀면서 판별
    if (isTar) return "tar";
    if (/\.zip$/.test(n)) return "zip";
    if (/\.(tgz|gz)$/.test(n)) return "gz";
    if (/\.tar$/.test(n)) return "tar";
    if (/\.(alz|egg|rar|7z|bz2|xz|zst|tbz2|txz|lzh|cab)$/.test(n)) return "unsupported";
    return "unknown";
  }

  /* ---------- TAR 쓰기 ---------- */
  function writeStr(buf, off, len, str) {
    const b = typeof str === "string" ? enc.encode(str) : str;
    buf.set(b.subarray(0, len), off);
  }
  function writeOctal(buf, off, len, n) {
    writeStr(buf, off, len, Math.floor(n).toString(8).padStart(len - 1, "0") + "\0");
  }
  function paxRecord(key, value) {
    const body = " " + key + "=" + value + "\n";
    const bodyLen = enc.encode(body).length;
    let len = bodyLen + String(bodyLen).length;
    if (String(len).length !== String(len - bodyLen).length) len = bodyLen + String(len).length;
    return String(len) + body;
  }
  const MAX_OCTAL_SIZE = 8589934591; // 0o77777777777

  function rawHeader(nameBytes, size, mtime, type, mode) {
    const h = new Uint8Array(BLOCK);
    writeStr(h, 0, 100, nameBytes);
    writeOctal(h, 100, 8, mode);
    writeOctal(h, 108, 8, 0);
    writeOctal(h, 116, 8, 0);
    if (size > MAX_OCTAL_SIZE) {
      // GNU base-256
      h[124] = 0x80;
      let v = BigInt(size);
      for (let i = 135; i > 124; i--) { h[i] = Number(v & 0xffn); v >>= 8n; }
    } else writeOctal(h, 124, 12, size);
    writeOctal(h, 136, 12, mtime);
    h.fill(0x20, 148, 156);
    h[156] = type.charCodeAt(0);
    writeStr(h, 257, 6, "ustar\0");
    writeStr(h, 263, 2, "00");
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += h[i];
    writeStr(h, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
    return h;
  }

  // entry: {path, size, mtime(ms), dir:boolean} → 헤더 바이트(필요시 PAX 포함)
  function tarHeader(entry) {
    let name = entry.path + (entry.dir && !entry.path.endsWith("/") ? "/" : "");
    const nameBytes = enc.encode(name);
    const size = entry.dir ? 0 : entry.size;
    const mtime = Math.floor((entry.mtime || Date.now()) / 1000);
    const type = entry.dir ? "5" : "0";
    const mode = entry.dir ? 0o755 : 0o644;
    let pax = "";
    if (nameBytes.length > 100) pax += paxRecord("path", name);
    if (size > MAX_OCTAL_SIZE) pax += paxRecord("size", String(size));
    const main = rawHeader(nameBytes.length > 100 ? nameBytes.subarray(0, 99) : nameBytes, size, mtime, type, mode);
    if (!pax) return main;
    const paxBytes = enc.encode(pax);
    const padded = Math.ceil(paxBytes.length / BLOCK) * BLOCK;
    const out = new Uint8Array(BLOCK + padded + BLOCK);
    out.set(rawHeader(enc.encode("././@PaxHeader"), paxBytes.length, mtime, "x", 0o644), 0);
    out.set(paxBytes, BLOCK);
    out.set(main, BLOCK + padded);
    return out;
  }

  // entries: [{path, dir, file(Blob/File)}] → ReadableStream<Uint8Array>
  function createTarStream(entries, onBytes) {
    let i = 0, reader = null, curSize = 0, curRead = 0;
    return new ReadableStream({
      async pull(ctrl) {
        for (;;) {
          if (reader) {
            const { value, done } = await reader.read();
            if (!done) {
              curRead += value.length;
              if (curRead > curSize) throw new Error("파일 크기가 압축 도중 바뀌었습니다.");
              ctrl.enqueue(value);
              if (onBytes) onBytes(value.length);
              return;
            }
            reader = null;
            if (curRead !== curSize) throw new Error("파일 크기가 압축 도중 바뀌었습니다.");
            const pad = (BLOCK - (curSize % BLOCK)) % BLOCK;
            if (pad) { ctrl.enqueue(new Uint8Array(pad)); return; }
            continue;
          }
          if (i >= entries.length) {
            ctrl.enqueue(new Uint8Array(BLOCK * 2));
            ctrl.close();
            return;
          }
          const e = entries[i++];
          const size = e.dir ? 0 : e.file.size;
          ctrl.enqueue(tarHeader({ path: e.path, dir: e.dir, size, mtime: e.file ? e.file.lastModified : Date.now() }));
          if (!e.dir && size > 0) { reader = e.file.stream().getReader(); curSize = size; curRead = 0; }
          return;
        }
      },
      cancel() { if (reader) reader.cancel(); },
    }, { highWaterMark: 2 });
  }

  /* ---------- 바이트 스트림 리더 ---------- */
  class ByteReader {
    constructor(readable) { this.r = readable.getReader(); this.buf = new Uint8Array(0); this.off = 0; }
    available() { return this.buf.length - this.off; }
    async fill() {
      const { value, done } = await this.r.read();
      if (done) return false;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      this.buf = this.available() ? concat(this.buf.subarray(this.off), chunk) : chunk;
      this.off = 0;
      return true;
    }
    async peek(n) {
      while (this.available() < n) if (!(await this.fill())) break;
      return this.buf.subarray(this.off, this.off + Math.min(n, this.available()));
    }
    async readExact(n) {
      while (this.available() < n) {
        if (!(await this.fill())) {
          if (this.available() === 0) return null;
          throw new Error("압축파일이 손상되었거나 중간에 끊겼습니다.");
        }
      }
      const out = this.buf.slice(this.off, this.off + n);
      this.off += n;
      return out;
    }
    // n 바이트를 writer로 전달 (writer가 null이면 건너뜀). n=Infinity면 끝까지
    async pipe(n, writer, onBytes) {
      while (n > 0) {
        if (this.available() === 0 && !(await this.fill())) {
          if (n === Infinity) return;
          throw new Error("압축파일이 손상되었거나 중간에 끊겼습니다.");
        }
        const take = Math.min(n, this.available());
        if (writer) {
          const piece = this.off === 0 && take === this.buf.length ? this.buf : this.buf.slice(this.off, this.off + take);
          await writer.write(piece);
        }
        this.off += take;
        n -= take;
        if (onBytes) onBytes(take);
      }
    }
    cancel() { try { this.r.cancel(); } catch (e) {} }
  }

  /* ---------- TAR 읽기 ---------- */
  function cstr(b, off, len) {
    let end = off;
    while (end < off + len && b[end] !== 0) end++;
    return b.subarray(off, end);
  }
  function parseNum(b, off, len) {
    if (b[off] & 0x80) {
      let v = 0n;
      for (let i = off + 1; i < off + len; i++) v = (v << 8n) | BigInt(b[i]);
      return Number(v);
    }
    const s = new TextDecoder().decode(cstr(b, off, len)).trim();
    return s ? parseInt(s, 8) : 0;
  }
  function checksumOk(h) {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : h[i];
    return sum === parseNum(h, 148, 8);
  }
  function parsePax(bytes) {
    const text = new TextDecoder().decode(bytes);
    const out = {};
    let i = 0;
    while (i < text.length) {
      const sp = text.indexOf(" ", i);
      if (sp < 0) break;
      const len = parseInt(text.slice(i, sp), 10);
      if (!len) break;
      // len은 바이트 단위 — 문자열 기준 근사 처리 후 줄바꿈으로 보정
      const nl = text.indexOf("\n", sp);
      const rec = text.slice(sp + 1, nl < 0 ? text.length : nl);
      const eq = rec.indexOf("=");
      if (eq > 0) out[rec.slice(0, eq)] = rec.slice(eq + 1);
      i = nl < 0 ? text.length : nl + 1;
    }
    return out;
  }

  /**
   * TAR 스트림을 sink로 해제
   * sink: { mkdir(segs), createFile(segs) → Promise<WritableStream|null(건너뜀)> }
   * opts: { onEntry(path,size), onBytes(n), signal, encoding }
   */
  async function extractTar(br, sink, opts) {
    opts = opts || {};
    let pax = {}, longName = null, count = 0;
    for (;;) {
      if (opts.signal && opts.signal.aborted) throw new DOMException("취소됨", "AbortError");
      const h = await br.readExact(BLOCK);
      if (!h) break;
      if (h.every((x) => x === 0)) break;
      if (!checksumOk(h)) throw new Error("TAR 헤더가 올바르지 않습니다 (손상되었거나 TAR 형식이 아님).");
      const type = String.fromCharCode(h[156] || 48);
      let size = parseNum(h, 124, 12);
      const isUstar = String.fromCharCode(h[257], h[258], h[259], h[260], h[261]) === "ustar";
      let nameBytes = cstr(h, 0, 100);
      if (isUstar && h[345]) nameBytes = concat(concat(cstr(h, 345, 155), enc.encode("/")), nameBytes);
      const pad = (n) => (BLOCK - (n % BLOCK)) % BLOCK;

      if (type === "x" || type === "g" || type === "L" || type === "K") {
        const data = await br.readExact(size);
        await br.pipe(pad(size), null);
        if (type === "x") pax = parsePax(data);
        else if (type === "L") longName = decodeName(cstr(data, 0, data.length), opts.encoding) || new TextDecoder().decode(cstr(data, 0, data.length));
        continue;
      }
      let name = pax.path || longName || decodeName(nameBytes, opts.encoding) || new TextDecoder().decode(nameBytes);
      if (pax.size) size = Number(pax.size);
      pax = {}; longName = null;
      const segs = sanitizePath(name);

      if (type === "5") {
        if (segs.length) await sink.mkdir(segs);
        if (size) await br.pipe(size + pad(size), null);
        continue;
      }
      if ((type === "0" || type === "\0" || type === "7") && segs.length) {
        if (opts.onEntry) opts.onEntry(segs.join("/"), size);
        const ws = await sink.createFile(segs);
        if (ws) {
          const w = ws.getWriter();
          try {
            await br.pipe(size, w, opts.onBytes);
            await w.close();
          } catch (e) {
            try { await w.abort(e); } catch (_) {}
            throw e;
          }
        } else await br.pipe(size, null, opts.onBytes);
        await br.pipe(pad(size), null);
        count++;
        continue;
      }
      // 링크·장치 등은 건너뜀
      await br.pipe(size + pad(size), null);
    }
    return count;
  }

  /* ---------- 단순 분할(.001) 쓰기 ---------- */
  // openPart(index:1..) → Promise<WritableStream>
  function createSplitWritable(openPart, partSize, onPartClosed) {
    let idx = 0, w = null, written = 0;
    async function closeCur() { await w.close(); w = null; if (onPartClosed) onPartClosed(idx); }
    return new WritableStream({
      async write(chunk) {
        let off = 0;
        while (off < chunk.length) {
          if (!w) { idx++; w = (await openPart(idx)).getWriter(); written = 0; }
          const take = Math.min(chunk.length - off, partSize - written);
          await w.write(chunk.subarray(off, off + take));
          off += take; written += take;
          if (written >= partSize) await closeCur();
        }
      },
      async close() { if (w) await closeCur(); },
      async abort(r) { if (w) { try { await w.abort(r); } catch (e) {} } },
    });
  }

  function countingStream(onBytes) {
    return new TransformStream({ transform(chunk, ctrl) { onBytes(chunk.length); ctrl.enqueue(chunk); } });
  }

  return {
    concat, formatBytes, decodeName, sanitizePath, makeUniquePath, classifyParts, detectFormat,
    tarHeader, createTarStream, ByteReader, extractTar, createSplitWritable, countingStream,
  };
});
