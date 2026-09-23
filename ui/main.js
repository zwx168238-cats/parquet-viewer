// Parquet Viewer 前端逻辑(Tauri v2 global API,无打包器)
const invoke = window.__TAURI__?.core?.invoke;
const dialog = window.__TAURI__?.dialog;

const MAX_RENDER_ROWS = 500; // 表格最多渲染的行数
const DEFAULT_QUERY_LIMIT = 1000; // 单次查询后端返回的最大行数

let currentPath = null; // 当前打开的 parquet 文件或目录

const el = {
  openFile: document.getElementById("btn-open-file"),
  openDir: document.getElementById("btn-open-dir"),
  currentPath: document.getElementById("current-path"),
  fileStats: document.getElementById("file-stats"),
  schemaList: document.getElementById("schema-list"),
  sqlEditor: document.getElementById("sql-editor"),
  run: document.getElementById("btn-run"),
  queryStatus: document.getElementById("query-status"),
  errorBanner: document.getElementById("error-banner"),
  resultInfo: document.getElementById("result-info"),
  resultContainer: document.getElementById("result-container"),
  filterInput: document.getElementById("filter-input"),
  filterExec: document.getElementById("btn-filter-exec"),
  filterClear: document.getElementById("btn-filter-clear"),
  offsetInput: document.getElementById("offset-input"),
  countInput: document.getElementById("count-input"),
};

function showError(msg) {
  el.errorBanner.textContent = String(msg);
  el.errorBanner.classList.remove("hidden");
}

function clearError() {
  el.errorBanner.classList.add("hidden");
}

function setStatus(text) {
  el.queryStatus.textContent = text || "";
}

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n;
  let i = -1;
  do {
    v /= 1024;
    i += 1;
  } while (v >= 1024 && i < units.length - 1);
  return `${v.toFixed(1)} ${units[i]}`;
}

async function pickPath(directory) {
  if (!dialog) {
    showError("当前环境不支持系统对话框,请在 Tauri 应用中运行");
    return null;
  }
  try {
    const selected = await dialog.open({
      multiple: false,
      directory,
      title: directory ? "选择包含 Parquet 文件的目录" : "选择 Parquet 文件",
      filters: directory
        ? undefined
        : [{ name: "Parquet", extensions: ["parquet"] }],
    });
    return typeof selected === "string" ? selected : null;
  } catch (e) {
    showError(`打开文件对话框失败: ${e}`);
    return null;
  }
}

async function openPath(path) {
  clearError();
  setStatus("正在打开…");
  try {
    const info = await invoke("open_path", { path });
    currentPath = path;
    el.currentPath.textContent = path;
    el.currentPath.title = path;

    const parts = [];
    if (info.file_count > 0) parts.push(`${info.file_count} 个文件`);
    if (info.file_size > 0) parts.push(formatBytes(info.file_size));
    if (info.num_rows !== null && info.num_rows !== undefined)
      parts.push(`${info.num_rows.toLocaleString()} 行`);
    el.fileStats.textContent = parts.join(" · ");

    renderSchema(info.schema);
    setStatus("");

    // 打开后自动预览前 100 行
    el.sqlEditor.value = "SELECT * FROM parquet_view LIMIT 100;";
    await runQuery();
  } catch (e) {
    showError(`打开文件失败: ${e}`);
    setStatus("");
  }
}

function renderSchema(schema) {
  el.schemaList.innerHTML = "";
  if (!schema || schema.length === 0) {
    el.schemaList.innerHTML = '<div class="placeholder">无 schema 信息</div>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const col of schema) {
    const item = document.createElement("div");
    item.className = "schema-item";
    item.title = `${col.name}: ${col.column_type}`;
    const name = document.createElement("span");
    name.className = "col-name";
    name.textContent = col.name;
    const type = document.createElement("span");
    type.className = "col-type";
    type.textContent = col.column_type;
    item.append(name, type);
    frag.appendChild(item);
  }
  el.schemaList.appendChild(frag);
}

// 快捷 SQL 模板
function quickSql(kind) {
  if (!currentPath) {
    showError("请先打开一个 Parquet 文件或目录");
    return null;
  }
  switch (kind) {
    case "preview":
      return "SELECT * FROM parquet_view LIMIT 100;";
    case "schema":
      return "DESCRIBE parquet_view;";
    case "count":
      return "SELECT count(*) AS row_count FROM parquet_view;";
    case "metadata":
      return "SELECT * FROM parquet_meta LIMIT 50;";
    default:
      return null;
  }
}

async function runQuery() {
  const sql = el.sqlEditor.value.trim();
  if (!sql) {
    showError("请输入 SQL 语句");
    return;
  }
  if (!currentPath) {
    showError("请先打开一个 Parquet 文件或目录");
    return;
  }
  clearError();
  setStatus("执行中…");
  el.run.disabled = true;
  try {
    const result = await invoke("run_query", {
      path: currentPath,
      sql,
      limit: DEFAULT_QUERY_LIMIT,
    });
    renderResult(result);
    let status = `${result.elapsed_ms} ms`;
    if (result.truncated) status += ` · 结果已截断(超过 ${DEFAULT_QUERY_LIMIT} 行)`;
    setStatus(status);
  } catch (e) {
    showError(`查询失败: ${e}`);
    setStatus("");
  } finally {
    el.run.disabled = false;
  }
}

// ---------- Filter Query ----------

/** 把用户输入的过滤条件整理为 WHERE 子句内容 */
function normalizeFilter(raw) {
  let filter = raw.trim();
  // 容错:去掉误写的 WHERE 前缀
  filter = filter.replace(/^\s*where\s+/i, "");
  // 容错:col="值" 的双引号字符串转单引号(SQL 字符串用单引号)
  filter = filter.replace(/([=!<>]=?|\b(?:in|like|ilike)\b)\s*"([^"]*)"/gi, "$1'$2'");
  return filter.trim();
}

/** 根据过滤条件和分页参数拼接完整 SQL */
function buildFilterSql() {
  const filter = normalizeFilter(el.filterInput.value);
  if (!filter) return null;
  const offset = Math.max(0, parseInt(el.offsetInput.value, 10) || 0);
  const count = Math.min(
    100000,
    Math.max(1, parseInt(el.countInput.value, 10) || 1000)
  );
  return {
    filter,
    offset,
    count,
    sql: `SELECT * FROM parquet_view WHERE ${filter} OFFSET ${offset} LIMIT ${count};`,
  };
}

async function runFilter() {
  if (!currentPath) {
    showError("请先打开一个 Parquet 文件或目录");
    return;
  }
  const built = buildFilterSql();
  if (!built) {
    showError("请输入过滤条件");
    return;
  }
  // 把生成的完整 SQL 显示到编辑器,透明可学
  el.sqlEditor.value = built.sql;
  const lastOffset = built.offset;
  await runQuery();
  fetchFilteredCount(built.filter, lastOffset, built.count);
}

/** 异步统计过滤后的总行数,更新状态栏 */
async function fetchFilteredCount(filter, offset, count) {
  try {
    const r = await invoke("run_query", {
      path: currentPath,
      sql: `SELECT count(*) AS total FROM parquet_view WHERE ${filter}`,
      limit: 1,
    });
    const total = r.rows?.[0]?.[0];
    if (typeof total === "number") {
      const to = Math.min(offset + count, total);
      const loaded = `Loaded: ${total > 0 ? offset + 1 : 0} to ${to} Out of: ${total.toLocaleString()}`;
      el.resultInfo.textContent = `${el.resultInfo.textContent} · ${loaded}`;
    }
  } catch {
    // 统计失败不影响主查询结果展示
  }
}

function clearFilter() {
  el.filterInput.value = "";
  el.offsetInput.value = "0";
  el.sqlEditor.value = "SELECT * FROM parquet_view LIMIT 100;";
  runQuery();
}

function cellContent(value) {
  if (value === null || value === undefined) {
    return { text: "NULL", cls: "null" };
  }
  if (typeof value === "object") {
    const text = JSON.stringify(value);
    return { text: text, cls: "" };
  }
  return { text: String(value), cls: typeof value === "number" ? "num" : "" };
}

function renderResult(result) {
  el.resultContainer.innerHTML = "";
  el.resultInfo.textContent = "";

  if (!result.columns || result.columns.length === 0) {
    el.resultInfo.textContent =
      result.row_count > 0
        ? `已执行,无结果集(${result.elapsed_ms} ms)`
        : `语句已执行(${result.elapsed_ms} ms)`;
    el.resultContainer.innerHTML =
      '<div class="placeholder">该语句没有返回结果集</div>';
    return;
  }

  const shown = Math.min(result.rows.length, MAX_RENDER_ROWS);
  const totalInfo =
    result.truncated || result.rows.length > MAX_RENDER_ROWS
      ? `(仅显示前 ${shown} 行${result.truncated ? ",后端已截断" : ""})`
      : "";
  el.resultInfo.textContent = `${result.rows.length} 行 × ${result.columns.length} 列 ${totalInfo} · ${result.elapsed_ms} ms`;

  const table = document.createElement("table");
  table.className = "result-table";

  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  const thIndex = document.createElement("th");
  thIndex.textContent = "#";
  headRow.appendChild(thIndex);
  result.columns.forEach((col, i) => {
    const th = document.createElement("th");
    th.title = `${col}: ${result.column_types[i] || "?"}`;
    const name = document.createElement("span");
    name.textContent = col;
    const type = document.createElement("span");
    type.className = "th-type";
    type.textContent = result.column_types[i] || "";
    th.append(name, type);
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (let r = 0; r < shown; r++) {
    const tr = document.createElement("tr");
    const idx = document.createElement("td");
    idx.className = "num";
    idx.textContent = String(r + 1);
    tr.appendChild(idx);
    result.rows[r].forEach((value, c) => {
      const td = document.createElement("td");
      const media = mediaElement(value, result.columns[c], r);
      if (media) {
        td.appendChild(media);
      } else {
        const { text, cls } = cellContent(value);
        if (cls) td.className = cls;
        td.textContent = text;
        td.title = text.length > 60 ? text : "";
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  el.resultContainer.appendChild(table);
}

// ---------- 媒体预览与导出(图片/音频) ----------

function fmtSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function mediaExt(mime) {
  const map = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/bmp": "bmp",
    "image/webp": "webp",
    "audio/wav": "wav",
    "audio/flac": "flac",
    "audio/ogg": "ogg",
    "audio/mpeg": "mp3",
  };
  return map[mime] || "bin";
}

/** blob 媒体单元格:图片渲染缩略图,音频渲染播放器;非媒体返回 null */
function mediaElement(value, colName, rowIdx) {
  if (!value || typeof value !== "object" || !value.__blob) return null;
  const src = `data:${value.mime};base64,${value.base64}`;
  if (value.kind === "image") {
    const img = document.createElement("img");
    img.className = "cell-thumb";
    img.src = src;
    img.alt = colName;
    img.title = `点击查看大图(${fmtSize(value.size)})`;
    img.addEventListener("click", () => openMediaModal(value, colName, rowIdx));
    return img;
  }
  if (value.kind === "audio") {
    const wrap = document.createElement("div");
    wrap.className = "cell-audio";
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = src;
    wrap.appendChild(audio);
    const btn = document.createElement("button");
    btn.className = "btn small";
    btn.textContent = "导出";
    btn.addEventListener("click", () => exportMedia(value, colName, rowIdx));
    wrap.appendChild(btn);
    return wrap;
  }
  return null;
}

let currentMedia = null; // 当前预览的媒体对象

function openMediaModal(value, colName, rowIdx) {
  currentMedia = { value, colName, rowIdx };
  const body = document.getElementById("media-body");
  body.innerHTML = "";
  const src = `data:${value.mime};base64,${value.base64}`;
  if (value.kind === "image") {
    const img = document.createElement("img");
    img.src = src;
    body.appendChild(img);
  } else {
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.src = src;
    body.appendChild(audio);
  }
  document.getElementById("media-info").textContent =
    `${colName} · 第 ${rowIdx + 1} 行 · ${value.mime} · ${fmtSize(value.size)}`;
  document.getElementById("media-modal").classList.remove("hidden");
}

function hideMediaModal() {
  const body = document.getElementById("media-body");
  body.innerHTML = ""; // 停止音频播放
  document.getElementById("media-modal").classList.add("hidden");
  currentMedia = null;
}

async function exportMedia(value, colName, rowIdx) {
  const name = `${colName}_row${rowIdx + 1}.${mediaExt(value.mime)}`;
  try {
    const saved = await invoke("export_base64", {
      base64Data: value.base64,
      defaultName: name,
    });
    if (saved) setStatus(`已导出: ${saved}`);
  } catch (e) {
    showError(`导出失败: ${e}`);
  }
}

// ---------- SQL Schema 生成 ----------

async function showSqlSchema() {
  if (!currentPath) {
    showError("请先打开一个 Parquet 文件或目录");
    return;
  }
  try {
    const sql = await invoke("generate_sql_schema", { path: currentPath });
    document.getElementById("schema-sql").textContent = sql;
    document.getElementById("schema-modal").classList.remove("hidden");
  } catch (e) {
    showError(`生成 SQL Schema 失败: ${e}`);
  }
}

// ---------- 事件绑定 ----------
el.openFile.addEventListener("click", async () => {
  const path = await pickPath(false);
  if (path) await openPath(path);
});

el.openDir.addEventListener("click", async () => {
  const path = await pickPath(true);
  if (path) await openPath(path);
});

el.run.addEventListener("click", runQuery);

el.filterExec.addEventListener("click", runFilter);

el.filterClear.addEventListener("click", clearFilter);

el.filterInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    runFilter();
  }
});

document.querySelectorAll("[data-sql]").forEach((btn) => {
  btn.addEventListener("click", async () => {
    const sql = quickSql(btn.dataset.sql);
    if (sql) {
      el.sqlEditor.value = sql;
      await runQuery();
    }
  });
});

el.sqlEditor.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
    e.preventDefault();
    runQuery();
  }
});

// ---------- About 对话框 ----------
const elAbout = {
  modal: document.getElementById("about-modal"),
  version: document.getElementById("about-version"),
  license: document.getElementById("about-license"),
  close: document.getElementById("about-close"),
};

async function showAbout() {
  try {
    const info = await invoke("about_info");
    elAbout.version.textContent = `Version ${info.version}`;
    elAbout.license.textContent = `License: ${info.license}`;
  } catch {
    elAbout.version.textContent = "";
    elAbout.license.textContent = "";
  }
  elAbout.modal.classList.remove("hidden");
}

function hideAbout() {
  elAbout.modal.classList.add("hidden");
}

elAbout.close.addEventListener("click", hideAbout);

elAbout.modal.addEventListener("click", (e) => {
  if (e.target === elAbout.modal) hideAbout();
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !elAbout.modal.classList.contains("hidden")) {
    hideAbout();
  }
});

// 菜单 Help > About 触发(由 Rust 侧 emit)
window.__TAURI__?.event?.listen("show-about", showAbout);

// ---------- 媒体 / SQL Schema 对话框事件 ----------
document.getElementById("media-close").addEventListener("click", hideMediaModal);

document.getElementById("media-modal").addEventListener("click", (e) => {
  if (e.target.id === "media-modal") hideMediaModal();
});

document.getElementById("media-export").addEventListener("click", () => {
  if (currentMedia) {
    exportMedia(currentMedia.value, currentMedia.colName, currentMedia.rowIdx);
  }
});

document.getElementById("btn-sql-schema").addEventListener("click", showSqlSchema);

document.getElementById("schema-close").addEventListener("click", () => {
  document.getElementById("schema-modal").classList.add("hidden");
});

document.getElementById("schema-modal").addEventListener("click", (e) => {
  if (e.target.id === "schema-modal") {
    document.getElementById("schema-modal").classList.add("hidden");
  }
});

document.getElementById("schema-copy").addEventListener("click", async () => {
  const sql = document.getElementById("schema-sql").textContent;
  try {
    await navigator.clipboard.writeText(sql);
    setStatus("SQL Schema 已复制到剪贴板");
  } catch {
    showError("复制失败,请手动选择文本复制");
  }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!document.getElementById("media-modal").classList.contains("hidden")) {
      hideMediaModal();
    } else if (
      !document.getElementById("schema-modal").classList.contains("hidden")
    ) {
      document.getElementById("schema-modal").classList.add("hidden");
    }
  }
});

// 启动提示:若不在 Tauri 环境内运行
if (!invoke) {
  showError(
    "未检测到 Tauri 运行时,请通过 `npm run dev` 或打包后的应用启动本工具"
  );
}
