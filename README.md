# AW ZIP

브라우저에서 대용량(4GB 이상) 파일을 압축·해제하는 웹앱. https://zip.activewith.net

- 지원: ZIP(ZIP64, 표준 분할 .z01~.zip, AES-256 암호, 한글 CP949 파일명 자동 판별), TAR, TAR.GZ, GZ, 단순 분할(.001)
- 모든 처리는 브라우저 안에서 수행 — 파일 업로드 없음
- PC용 Chrome / Edge 전용 (File System Access API로 디스크에 직접 씀)

## 구성
- `index.html` — UI
- `app.js` — 화면 로직 (파일 선택, 진행률, 디스크 쓰기)
- `core.js` — TAR 쓰기/읽기, 분할 처리, 파일명 디코딩, 경로 정리
- `zipops.js` — zip.js 기반 ZIP 압축/해제
- `vendor/zip.min.js` — [zip.js](https://github.com/gildas-lormeau/zip.js) 2.x (BSD-3-Clause)

## 예정
- 2단계: 7z / RAR / xz / zst 해제 (libarchive WASM)
- 3단계: ALZ 해제
