# Parquet Viewer

**简体中文** | [English](README.md)

一款跨平台的 [Apache Parquet](https://parquet.apache.org/) 文件桌面查看器,内置 SQL 查询能力,基于 [Tauri](https://tauri.app/) 与 [DuckDB](https://duckdb.org/) 构建。

灵感来自 [mukunku/ParquetViewer](https://github.com/mukunku/ParquetViewer)(仅 Windows),本项目用一套源码把同类能力带到 **macOS、Linux 和 Windows**。

![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)

## 功能特性

- **打开文件或目录** —— 目录会被递归读取,支持 Hive 分区数据集(基于 `read_parquet` 的 glob 匹配)
- **Schema 浏览** —— 一览列名与类型,并显示行数与文件大小
- **SQL 查询编辑器** —— 由 DuckDB 提供完整 SQL 能力,像操作数据库一样查询 parquet
- **过滤查询(Filter Query)模式** —— 无需写 SQL 即可做简单过滤(与原版 ParquetViewer 一致),支持记录偏移/数量分页
- **图片与音频预览** —— BLOB 列按 magic bytes 自动识别;图片渲染为可点击的缩略图,音频渲染为内嵌播放器,均可在弹窗中预览并导出到磁盘
- **生成 SQL Schema** —— 一键生成与 parquet schema 对应的 `CREATE TABLE` 语句,可直接复制
- **文件元数据视图** —— 通过 `parquet_metadata` 查看 parquet 内部信息
- **丰富类型渲染** —— 时间戳、日期、列表、结构体、blob(hex 摘要)、NULL
- 原生菜单栏 —— **关于(About)** 与 **语言(Language)** 子菜单统一放在应用菜单(Parquet Viewer)下,符合 macOS 惯例
- **双语界面** —— 运行时通过 **Parquet Viewer → 语言(Language)** 在简体中文与 English 之间切换,选择会被持久化

## 安装

从 [Releases](../../releases) 页面下载对应平台的安装包:

| 平台 | 架构 | 安装包 |
|---|---|---|
| macOS | Apple Silicon (arm64) | `.dmg` |
| Linux | amd64 | `.deb` / `.AppImage` |
| Windows | amd64 | `.msi` / `.exe` |

> 安装包未做代码签名。macOS 首次打开时,请右键点击应用并选择 *打开*,以绕过 Gatekeeper。

## 使用方法

1. 点击 **打开文件**(或 **打开目录**),选择一个 parquet 文件或包含 parquet 文件的文件夹。
2. 界面会立即显示 schema、行数与文件大小,并预览前 100 行数据。
3. 用 SQL 查询数据 —— 已打开的文件会被注册为视图 `parquet_view`:

   ```sql
   SELECT * FROM parquet_view WHERE id > 100 LIMIT 1000;
   ```

   ```sql
   DESCRIBE parquet_view;                -- 列类型
   SELECT count(*) FROM parquet_view;    -- 行数
   SELECT * FROM parquet_meta;           -- parquet 文件元数据
   ```

4. 或使用 **过滤查询(Filter Query)** 栏(无需写 SQL):输入形如
   `repo_path = 'Android'` 的条件,设置 *记录偏移* / *记录数量*,点击 **执行**。
   生成的 SQL 会显示在编辑器中,便于学习或微调。
5. 点击 **SQL Schema** 为已加载文件生成 `CREATE TABLE` 语句并复制。
6. 图片/音频 BLOB 单元格会显示缩略图或播放器 —— 点击可在弹窗中预览,再点 **导出** 把二进制保存到磁盘。
7. 通过 **Parquet Viewer → 语言(Language)** 切换界面语言(简体中文 / English),选择会被记住,下次启动依然生效。

## 从源码构建

前置依赖:

- [Rust](https://www.rust-lang.org/tools/install)(stable)
- [Node.js](https://nodejs.org/)(LTS)
- 平台依赖:
  - **macOS**:Xcode Command Line Tools
  - **Linux (Ubuntu/Debian)**:`libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  - **Windows**:Microsoft Visual Studio C++ Build Tools + WebView2(Windows 11 已预装)

```bash
npm install        # 安装 @tauri-apps/cli
npm run dev        # 开发模式,支持热重载
npm run build      # 生产安装包(.dmg / .deb+.AppImage / .msi+.exe)
```

DuckDB 从源码编译(bundled 特性),首次构建约需 10 分钟。

### CI 发布

推送版本 tag 会触发 GitHub Actions 构建三个平台,并把安装包上传到 draft release:

```bash
git tag v0.1.0
git push origin v0.1.0
```

## 项目结构

```
├── ui/                  # 前端(原生 JS,无打包器)
│   ├── index.html
│   ├── main.js
│   ├── i18n.js          # zh-CN / en 词典 + 运行时语言切换
│   └── styles.css
├── src-tauri/
│   ├── src/lib.rs       # 后端:DuckDB 引擎、tauri 命令、原生菜单
│   ├── tauri.conf.json
│   └── capabilities/
├── .github/workflows/   # 三平台发布 CI
└── LICENSE              # GPL-3.0
```

## 致谢

- [mukunku/ParquetViewer](https://github.com/mukunku/ParquetViewer) —— 本项目灵感来源的原版 Windows 工具(GPL-3.0)
- [Tauri](https://tauri.app/) —— 轻量级跨平台应用框架
- [DuckDB](https://duckdb.org/) —— 进程内分析型 SQL 引擎(MIT)

## 许可

GPL-3.0-only。详见 [LICENSE](LICENSE)。
