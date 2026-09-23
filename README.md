# Parquet Viewer

A cross-platform desktop viewer for [Apache Parquet](https://parquet.apache.org/) files with built-in SQL query support, powered by [Tauri](https://tauri.app/) and [DuckDB](https://duckdb.org/).

Inspired by [mukunku/ParquetViewer](https://github.com/mukunku/ParquetViewer) (Windows-only), this project brings similar capabilities to **macOS, Linux and Windows** from a single codebase.

![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)

## Features

- **Open a file or a directory** — directories are read recursively, including Hive-partitioned datasets (`read_parquet` with glob support)
- **Schema browser** — column names and types at a glance, plus row count and file size
- **SQL query editor** — full SQL powered by DuckDB, query parquet files like a database
- **Filter Query mode** — simplified filtering without writing SQL (like the original ParquetViewer), with record offset/count pagination
- **Image & audio preview** — BLOB columns are auto-detected by magic bytes; images render as clickable thumbnails and audio as inline players, both previewable in a modal and exportable to disk
- **Generate SQL schema** — one click produces a `CREATE TABLE` statement matching the parquet schema, ready to copy
- **File metadata view** — inspect parquet internals via `parquet_metadata`
- **Rich type rendering** — timestamps, dates, lists, structs, blobs (hex preview), NULLs
- Native menu bar with **Help → About**

## Installation

Download the installer for your platform from the [Releases](../../releases) page:

| Platform | Architecture | Package |
|---|---|---|
| macOS | Apple Silicon (arm64) | `.dmg` |
| Linux | amd64 | `.deb` / `.AppImage` |
| Windows | amd64 | `.msi` / `.exe` |

> Installers are not code-signed. On macOS, right-click the app and choose *Open* the first time to bypass Gatekeeper.

## Usage

1. Click **打开文件 / Open File** (or **打开目录 / Open Directory**) and pick a parquet file or a folder of parquet files.
2. The schema, row count and file size are shown immediately, along with a preview of the first 100 rows.
3. Query the data with SQL — the opened file is registered as the view `parquet_view`:

   ```sql
   SELECT * FROM parquet_view WHERE id > 100 LIMIT 1000;
   ```

   ```sql
   DESCRIBE parquet_view;                -- column types
   SELECT count(*) FROM parquet_view;    -- row count
   SELECT * FROM parquet_meta;           -- parquet file metadata
   ```

4. Or use the **Filter Query** bar (no SQL needed): type a condition such as
   `repo_path = 'Android'`, set *Record Offset* / *Record Count*, and hit **Execute**.
   The generated SQL is shown in the editor so you can learn/tweak it.
5. Click **SQL Schema** to generate a `CREATE TABLE` statement for the loaded file and copy it.
6. Image/audio BLOB cells show a thumbnail or player — click to preview in a modal, then **Export** to save the binary to disk.

## Building from source

Prerequisites:

- [Rust](https://www.rust-lang.org/tools/install) (stable)
- [Node.js](https://nodejs.org/) (LTS)
- Platform dependencies:
  - **macOS**: Xcode Command Line Tools
  - **Linux (Ubuntu/Debian)**: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  - **Windows**: Microsoft Visual Studio C++ Build Tools + WebView2 (preinstalled on Windows 11)

```bash
npm install        # installs @tauri-apps/cli
npm run dev        # development mode with hot reload
npm run build      # production installers (.dmg / .deb+.AppImage / .msi+.exe)
```

DuckDB is compiled from source (bundled feature); the first build takes ~10 minutes.

### CI releases

Pushing a version tag triggers GitHub Actions to build all three platforms and upload the installers to a draft release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## Project layout

```
├── ui/                  # frontend (vanilla JS, no bundler)
│   ├── index.html
│   ├── main.js
│   └── styles.css
├── src-tauri/
│   ├── src/lib.rs       # backend: DuckDB engine, tauri commands, native menu
│   ├── tauri.conf.json
│   └── capabilities/
├── .github/workflows/   # tri-platform release CI
└── LICENSE              # GPL-3.0
```

## Acknowledgements

- [mukunku/ParquetViewer](https://github.com/mukunku/ParquetViewer) — the original Windows tool this project is inspired by (GPL-3.0)
- [Tauri](https://tauri.app/) — lightweight cross-platform app framework
- [DuckDB](https://duckdb.org/) — in-process analytical SQL engine (MIT)

## License

GPL-3.0-only. See [LICENSE](LICENSE).
