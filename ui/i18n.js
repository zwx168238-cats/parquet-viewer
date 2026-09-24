// Parquet Viewer 国际化:简体中文(zh-CN) + English(en)
// 语言来源优先级:localStorage > 默认 English(不跟随系统语言,统一以英文为默认)
// 菜单驱动切换:Rust 侧 emit "change-language" 事件;前端切换后回调 set_app_language 同步后端
(function () {
  const DICT = {
    "zh-CN": {
      // ---- 工具栏 / 侧栏 ----
      "btn.openFile": "打开文件",
      "btn.openDir": "打开目录",
      "label.noFile": "未打开文件",
      "panel.schema": "Schema",
      "schema.placeholder": "打开 Parquet 文件后显示结构",
      "schema.none": "无 schema 信息",
      // ---- 查询区 ----
      "query.label": 'SQL 查询(目标视图:<code>parquet_view</code>)',
      "btn.preview": "预览数据",
      "btn.tableSchema": "表结构",
      "btn.rowCount": "行数",
      "btn.metadata": "文件元数据",
      "btn.sqlSchema": "SQL Schema",
      "btn.run": "执行查询",
      "filter.label": "过滤查询 (?)",
      "filter.title":
        "输入过滤条件(无需 SELECT 和 WHERE),如: repo_path = 'Android' AND controlled = TRUE",
      "filter.placeholder": "如: repo_path = 'Android'",
      "filter.exec": "执行",
      "filter.clear": "清除",
      "filter.offset": "记录偏移:",
      "filter.count": "记录数量:",
      "filter.prev": "上一页",
      "filter.next": "下一页",
      "result.placeholder": "执行查询后在此显示结果",
      // ---- 弹窗 ----
      "media.export": "导出",
      "media.close": "关闭",
      "media.exportBtn": "导出",
      "media.thumbTitle": "点击查看大图({size})",
      "media.info": "{col} · 第 {row} 行 · {mime} · {size}",
      "schemaModal.title": "SQL Schema(CREATE TABLE)",
      "schemaModal.copy": "复制",
      "schemaModal.close": "关闭",
      "about.tagline": "跨平台 Parquet 查看与 SQL 查询工具",
      "about.built": "基于 Tauri + DuckDB 构建",
      "about.inspired": "灵感来自 mukunku/ParquetViewer (GPL-3.0)",
      "about.close": "关闭",
      "about.version": "版本 {v}",
      "about.license": "许可: {l}",
      // ---- 状态 / 结果 ----
      "status.opening": "正在打开…",
      "status.running": "执行中…",
      "status.truncated": " · 结果已截断(超过 {n} 行)",
      "status.exported": "已导出: {path}",
      "status.copied": "SQL Schema 已复制到剪贴板",
      "status.loaded": "已加载: {from} 至 {to},共 {total} 条",
      "stat.files": "{n} 个文件",
      "stat.rows": "{n} 行",
      "result.executedNoSet": "已执行,无结果集({ms} ms)",
      "result.executed": "语句已执行({ms} ms)",
      "result.noResultSet": "该语句没有返回结果集",
      "result.showingFirst": "(仅显示前 {n} 行{trunc})",
      "result.truncSuffix": ",后端已截断",
      "result.info": "{rows} 行 × {cols} 列 {total} · {ms} ms",
      // ---- 对话框 / 错误 ----
      "dialog.titleDir": "选择包含 Parquet 文件的目录",
      "dialog.titleFile": "选择 Parquet 文件",
      "err.noDialog": "当前环境不支持系统对话框,请在 Tauri 应用中运行",
      "err.openDialog": "打开文件对话框失败: {e}",
      "err.open": "打开文件失败: {e}",
      "err.openFirst": "请先打开一个 Parquet 文件或目录",
      "err.emptySql": "请输入 SQL 语句",
      "err.emptyFilter": "请输入过滤条件",
      "err.query": "查询失败: {e}",
      "err.export": "导出失败: {e}",
      "err.schema": "生成 SQL Schema 失败: {e}",
      "err.copy": "复制失败,请手动选择文本复制",
      "err.noTauri":
        "未检测到 Tauri 运行时,请通过 `npm run dev` 或打包后的应用启动本工具",
    },
    en: {
      "btn.openFile": "Open File",
      "btn.openDir": "Open Directory",
      "label.noFile": "No file opened",
      "panel.schema": "Schema",
      "schema.placeholder": "Open a Parquet file to view its schema",
      "schema.none": "No schema information",
      "query.label": 'SQL Query (target view: <code>parquet_view</code>)',
      "btn.preview": "Preview",
      "btn.tableSchema": "Table Schema",
      "btn.rowCount": "Row Count",
      "btn.metadata": "File Metadata",
      "btn.sqlSchema": "SQL Schema",
      "btn.run": "Run Query",
      "filter.label": "Filter Query (?)",
      "filter.title":
        "Enter a filter condition (no SELECT/WHERE needed), e.g. repo_path = 'Android' AND controlled = TRUE",
      "filter.placeholder": "e.g. repo_path = 'Android'",
      "filter.exec": "Execute",
      "filter.clear": "Clear",
      "filter.offset": "Record Offset:",
      "filter.count": "Record Count:",
      "filter.prev": "Previous Page",
      "filter.next": "Next Page",
      "result.placeholder": "Results appear here after running a query",
      "media.export": "Export",
      "media.close": "Close",
      "media.exportBtn": "Export",
      "media.thumbTitle": "Click to enlarge ({size})",
      "media.info": "{col} · row {row} · {mime} · {size}",
      "schemaModal.title": "SQL Schema (CREATE TABLE)",
      "schemaModal.copy": "Copy",
      "schemaModal.close": "Close",
      "about.tagline": "Cross-platform Parquet viewer with SQL query",
      "about.built": "Built with Tauri + DuckDB",
      "about.inspired": "Inspired by mukunku/ParquetViewer (GPL-3.0)",
      "about.close": "Close",
      "about.version": "Version {v}",
      "about.license": "License: {l}",
      "status.opening": "Opening…",
      "status.running": "Running…",
      "status.truncated": " · result truncated (over {n} rows)",
      "status.exported": "Exported: {path}",
      "status.copied": "SQL Schema copied to clipboard",
      "status.loaded": "Loaded: {from} to {to} Out of: {total}",
      "stat.files": "{n} files",
      "stat.rows": "{n} rows",
      "result.executedNoSet": "Executed, no result set ({ms} ms)",
      "result.executed": "Statement executed ({ms} ms)",
      "result.noResultSet": "This statement returned no result set",
      "result.showingFirst": "(showing first {n} rows{trunc})",
      "result.truncSuffix": ", truncated by backend",
      "result.info": "{rows} rows × {cols} cols {total} · {ms} ms",
      "dialog.titleDir": "Choose a directory containing Parquet files",
      "dialog.titleFile": "Choose a Parquet file",
      "err.noDialog": "System dialogs unavailable; please run inside the Tauri app",
      "err.openDialog": "Failed to open file dialog: {e}",
      "err.open": "Failed to open file: {e}",
      "err.openFirst": "Please open a Parquet file or directory first",
      "err.emptySql": "Please enter a SQL statement",
      "err.emptyFilter": "Please enter a filter condition",
      "err.query": "Query failed: {e}",
      "err.export": "Export failed: {e}",
      "err.schema": "Failed to generate SQL Schema: {e}",
      "err.copy": "Copy failed; please select and copy the text manually",
      "err.noTauri":
        "Tauri runtime not detected; launch via `npm run dev` or the packaged app",
    },
  };

  const invoke = window.__TAURI__?.core?.invoke;

  function detect() {
    try {
      const saved = localStorage.getItem("pv-lang");
      if (saved && DICT[saved]) return saved;
    } catch {
      /* localStorage 不可用时忽略 */
    }
    return "en"; // 默认英文
  }

  let current = detect();

  function t(key, vars) {
    const table = DICT[current] || DICT.en;
    let s =
      table[key] !== undefined
        ? table[key]
        : DICT.en[key] !== undefined
          ? DICT.en[key]
          : key;
    if (vars) {
      for (const k in vars) {
        s = s.split(`{${k}}`).join(String(vars[k]));
      }
    }
    return s;
  }

  function applyI18n() {
    document.documentElement.lang = current === "zh-CN" ? "zh-CN" : "en";
    document.querySelectorAll("[data-i18n]").forEach((node) => {
      node.textContent = t(node.dataset.i18n);
    });
    document.querySelectorAll("[data-i18n-html]").forEach((node) => {
      node.innerHTML = t(node.dataset.i18nHtml);
    });
    document.querySelectorAll("[data-i18n-placeholder]").forEach((node) => {
      node.placeholder = t(node.dataset.i18nPlaceholder);
    });
    document.querySelectorAll("[data-i18n-title]").forEach((node) => {
      node.title = t(node.dataset.i18nTitle);
    });
  }

  // notifyBackend=false 用于响应 Rust 菜单切换(后端已知晓语言)
  function setLang(lang, notifyBackend = true) {
    if (!DICT[lang]) return;
    current = lang;
    try {
      localStorage.setItem("pv-lang", lang);
    } catch {
      /* 忽略持久化失败 */
    }
    applyI18n();
    if (notifyBackend && invoke) {
      invoke("set_app_language", { lang }).catch(() => {});
    }
  }

  window.i18n = { t, applyI18n, setLang, getLang: () => current };

  function init() {
    applyI18n();
    if (invoke) {
      // 告知后端当前语言,使原生菜单与错误信息一致
      invoke("set_app_language", { lang: current }).catch(() => {});
    }
    // 监听原生菜单 Help > Language 的切换
    window.__TAURI__?.event?.listen("change-language", (e) => {
      setLang(e.payload, false);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
