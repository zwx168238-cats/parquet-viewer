// Parquet Viewer 前端逻辑(Tauri v2 global API,无打包器)
const invoke = window.__TAURI__?.core?.invoke;
const dialog = window.__TAURI__?.dialog;
const t = window.i18n.t; // i18n 翻译函数(见 i18n.js)

const MAX_RENDER_ROWS = 10000; // 表格最多渲染的行数(需覆盖单页记录数)
const DEFAULT_QUERY_LIMIT = 1000; // 单次查询后端返回的最大行数
const MAX_PAGE_SIZE = 100000; // 分页/记录数量的上限

let currentPath = null; // 当前打开的 parquet 文件或目录
let displayRowOffset = 0; // 结果表格 # 列的行号偏移(分页时显示全局行号)
let filterTotal = null; // 最近一次过滤/分页匹配到的总行数(用于翻页按钮禁用)

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
  pagePrev: document.getElementById("btn-page-prev"),
  pageNext: document.getElementById("btn-page-next"),
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
    showError(t("err.noDialog"));
    return null;
  }
  try {
    const selected = await dialog.open({
      multiple: false,
      directory,
      title: directory ? t("dialog.titleDir") : t("dialog.titleFile"),
      filters: directory
        ? undefined
        : [{ name: "Parquet", extensions: ["parquet"] }],
    });
    return typeof selected === "string" ? selected : null;
  } catch (e) {
    showError(t("err.openDialog", { e }));
    return null;
  }
}

async function openPath(path) {
  clearError();
  setStatus(t("status.opening"));
  try {
    const info = await invoke("open_path", { path });
    currentPath = path;
    filterTotal = null; // 切换文件时重置分页状态
    displayRowOffset = 0;
    el.currentPath.textContent = path;
    el.currentPath.title = path;

    const parts = [];
    if (info.file_count > 0) parts.push(t("stat.files", { n: info.file_count }));
    if (info.file_size > 0) parts.push(formatBytes(info.file_size));
    if (info.num_rows !== null && info.num_rows !== undefined)
      parts.push(t("stat.rows", { n: info.num_rows.toLocaleString() }));
    el.fileStats.textContent = parts.join(" · ");

    renderSchema(info.schema);
    setStatus("");

    // 打开后自动预览前 100 行
    el.sqlEditor.value = "SELECT * FROM parquet_view LIMIT 100;";
    await runQuery();
  } catch (e) {
    showError(t("err.open", { e }));
    setStatus("");
  }
}

function renderSchema(schema) {
  el.schemaList.innerHTML = "";
  if (!schema || schema.length === 0) {
    el.schemaList.innerHTML = `<div class="placeholder">${t("schema.none")}</div>`;
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
    showError(t("err.openFirst"));
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

async function runQuery(limit) {
  const sql = el.sqlEditor.value.trim();
  if (!sql) {
    showError(t("err.emptySql"));
    return;
  }
  if (!currentPath) {
    showError(t("err.openFirst"));
    return;
  }
  const effectiveLimit = limit && limit > 0 ? limit : DEFAULT_QUERY_LIMIT;
  if (!limit || limit <= 0) displayRowOffset = 0; // 非分页查询,行号从 1 开始
  clearError();
  setStatus(t("status.running"));
  el.run.disabled = true;
  try {
    const result = await invoke("run_query", {
      path: currentPath,
      sql,
      limit: effectiveLimit,
    });
    renderResult(result);
    let status = `${result.elapsed_ms} ms`;
    if (result.truncated) status += t("status.truncated", { n: effectiveLimit });
    setStatus(status);
  } catch (e) {
    showError(t("err.query", { e }));
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

/** 根据过滤条件与分页参数拼接完整 SQL(filter 可为空,表示浏览全部) */
function buildFilterSql(offsetOverride) {
  const filter = normalizeFilter(el.filterInput.value);
  const offset =
    offsetOverride !== undefined
      ? Math.max(0, offsetOverride)
      : Math.max(0, parseInt(el.offsetInput.value, 10) || 0);
  const count = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(el.countInput.value, 10) || 1000)
  );
  const where = filter ? ` WHERE ${filter}` : "";
  return {
    filter,
    offset,
    count,
    sql: `SELECT * FROM parquet_view${where} OFFSET ${offset} LIMIT ${count};`,
  };
}

/** 执行过滤/分页查询;传入 offsetOverride 时按该偏移翻页 */
async function runFilter(offsetOverride) {
  if (!currentPath) {
    showError(t("err.openFirst"));
    return;
  }
  const built = buildFilterSql(offsetOverride);
  el.offsetInput.value = String(built.offset); // 回写,保持输入框与翻页一致
  // 把生成的完整 SQL 显示到编辑器,透明可学
  el.sqlEditor.value = built.sql;
  displayRowOffset = built.offset;
  await runQuery(built.count);
  fetchFilteredCount(built.filter, built.offset, built.count);
}

/** 翻页:delta = -1 上一页,+1 下一页,步长为当前记录数量(页大小) */
function gotoPage(delta) {
  const offset = Math.max(0, parseInt(el.offsetInput.value, 10) || 0);
  const count = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(el.countInput.value, 10) || 1000)
  );
  runFilter(Math.max(0, offset + delta * count));
}

/** 根据当前 offset/count 与总行数更新翻页按钮可用状态 */
function updatePageButtons() {
  const offset = Math.max(0, parseInt(el.offsetInput.value, 10) || 0);
  const count = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(el.countInput.value, 10) || 1000)
  );
  if (el.pagePrev) el.pagePrev.disabled = offset <= 0;
  if (el.pageNext)
    el.pageNext.disabled =
      filterTotal !== null && filterTotal !== undefined
        ? offset + count >= filterTotal
        : false;
}

/** 异步统计过滤后的总行数,更新状态栏与翻页按钮 */
async function fetchFilteredCount(filter, offset, count) {
  const where = filter ? ` WHERE ${filter}` : "";
  try {
    const r = await invoke("run_query", {
      path: currentPath,
      sql: `SELECT count(*) AS total FROM parquet_view${where}`,
      limit: 1,
    });
    const total = r.rows?.[0]?.[0];
    if (typeof total === "number") {
      filterTotal = total;
      const to = Math.min(offset + count, total);
      const loaded = t("status.loaded", {
        from: total > 0 ? offset + 1 : 0,
        to,
        total: total.toLocaleString(),
      });
      el.resultInfo.textContent = `${el.resultInfo.textContent} · ${loaded}`;
    }
  } catch {
    // 统计失败不影响主查询结果展示
  }
  updatePageButtons();
}

function clearFilter() {
  el.filterInput.value = "";
  el.offsetInput.value = "0";
  filterTotal = null;
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
        ? t("result.executedNoSet", { ms: result.elapsed_ms })
        : t("result.executed", { ms: result.elapsed_ms });
    el.resultContainer.innerHTML =
      `<div class="placeholder">${t("result.noResultSet")}</div>`;
    return;
  }

  const shown = Math.min(result.rows.length, MAX_RENDER_ROWS);
  const totalInfo =
    result.truncated || result.rows.length > MAX_RENDER_ROWS
      ? t("result.showingFirst", {
          n: shown,
          trunc: result.truncated ? t("result.truncSuffix") : "",
        })
      : "";
  el.resultInfo.textContent = t("result.info", {
    rows: result.rows.length,
    cols: result.columns.length,
    total: totalInfo,
    ms: result.elapsed_ms,
  });

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
    idx.textContent = String(displayRowOffset + r + 1);
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
    img.title = t("media.thumbTitle", { size: fmtSize(value.size) });
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
    btn.textContent = t("media.exportBtn");
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
  document.getElementById("media-info").textContent = t("media.info", {
    col: colName,
    row: rowIdx + 1,
    mime: value.mime,
    size: fmtSize(value.size),
  });
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
    if (saved) setStatus(t("status.exported", { path: saved }));
  } catch (e) {
    showError(t("err.export", { e }));
  }
}

// ---------- SQL Schema 生成 ----------

async function showSqlSchema() {
  if (!currentPath) {
    showError(t("err.openFirst"));
    return;
  }
  try {
    const sql = await invoke("generate_sql_schema", { path: currentPath });
    document.getElementById("schema-sql").textContent = sql;
    document.getElementById("schema-modal").classList.remove("hidden");
  } catch (e) {
    showError(t("err.schema", { e }));
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

el.run.addEventListener("click", () => runQuery());

el.filterExec.addEventListener("click", () => runFilter());

el.filterClear.addEventListener("click", clearFilter);

el.pagePrev?.addEventListener("click", () => gotoPage(-1));

el.pageNext?.addEventListener("click", () => gotoPage(1));

// 手动修改偏移/数量时同步刷新翻页按钮可用状态
el.offsetInput.addEventListener("change", updatePageButtons);
el.countInput.addEventListener("change", updatePageButtons);

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
    elAbout.version.textContent = t("about.version", { v: info.version });
    elAbout.license.textContent = t("about.license", { l: info.license });
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
    setStatus(t("status.copied"));
  } catch {
    showError(t("err.copy"));
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
  showError(t("err.noTauri"));
}
