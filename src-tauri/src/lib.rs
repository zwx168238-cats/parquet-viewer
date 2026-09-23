use std::path::Path;
use std::sync::Mutex;
use std::time::Instant;

use duckdb::types::{TimeUnit, Type, Value};
use duckdb::Connection;
use serde::Serialize;
use tauri::menu::{
    CheckMenuItemBuilder, MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder,
};
use tauri::{Emitter, Manager};

/// 单次查询默认返回的最大行数(前端可指定)
const DEFAULT_LIMIT: usize = 1000;

/// 全局语言状态("zh-CN" / "en"),由前端初始化时同步、原生菜单切换时更新。
/// 命令与菜单据此产出对应语言的错误信息与菜单文案。
struct LangState(Mutex<String>);

impl LangState {
    fn get(&self) -> String {
        self.0
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "en".to_string())
    }
}

/// 双语文案助手:lang 为 "zh-CN" 时返回简体中文,否则(含未知语言)回退英文。
fn tr(lang: &str, zh: &str, en: &str) -> String {
    if lang == "zh-CN" {
        zh.to_string()
    } else {
        en.to_string()
    }
}

#[derive(Serialize)]
struct ColumnInfo {
    name: String,
    column_type: String,
}

#[derive(Serialize)]
struct FileInfo {
    path: String,
    is_dir: bool,
    file_size: u64,
    file_count: usize,
    num_rows: Option<i64>,
    schema: Vec<ColumnInfo>,
}

#[derive(Serialize)]
struct QueryResult {
    columns: Vec<String>,
    column_types: Vec<String>,
    rows: Vec<Vec<serde_json::Value>>,
    row_count: usize,
    truncated: bool,
    elapsed_ms: u64,
}

/// 打开一个 in-memory DuckDB 连接,并把目标 parquet 文件/目录注册为视图 `parquet_view`。
/// 传入目录时 DuckDB 会自动递归读取其中所有 parquet 文件(含 Hive 分区目录)。
fn open_conn(path: &str, lang: &str) -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| {
        tr(
            lang,
            &format!("无法创建内存数据库连接: {e}"),
            &format!("Failed to create in-memory database connection: {e}"),
        )
    })?;
    let escaped = path.replace('\'', "''");
    conn.execute_batch(&format!(
        "CREATE OR REPLACE VIEW parquet_view AS SELECT * FROM read_parquet('{escaped}')"
    ))
    .map_err(|e| {
        tr(
            lang,
            &format!("打开 Parquet 文件失败: {e}"),
            &format!("Failed to open Parquet file: {e}"),
        )
    })?;

    // 注册文件元数据视图 `parquet_meta`(兼容新旧 DuckDB 的表函数名)
    let meta_view = format!(
        "CREATE OR REPLACE VIEW parquet_meta AS SELECT * FROM parquet_metadata('{escaped}')"
    );
    if conn.execute_batch(&meta_view).is_err() {
        let meta_view_v2 = format!(
            "CREATE OR REPLACE VIEW parquet_meta AS SELECT * FROM parquet_file_metadata('{escaped}')"
        );
        let _ = conn.execute_batch(&meta_view_v2);
    }
    Ok(conn)
}

/// 打开单个 parquet 文件或目录,返回文件信息与 schema
#[tauri::command]
fn open_path(path: String, state: tauri::State<LangState>) -> Result<FileInfo, String> {
    let lang = state.get();
    let p = Path::new(&path);
    if !p.exists() {
        return Err(tr(
            &lang,
            &format!("路径不存在: {path}"),
            &format!("Path does not exist: {path}"),
        ));
    }
    let is_dir = p.is_dir();
    let (file_size, file_count) = if is_dir {
        let mut size = 0u64;
        let mut count = 0usize;
        collect_parquet_files(p, &mut count, &mut size, &lang)?;
        (size, count)
    } else {
        (std::fs::metadata(p).map(|m| m.len()).unwrap_or(0), 1)
    };

    let conn = open_conn(&path, &lang)?;
    let schema = describe_schema(&conn, &lang)?;
    let num_rows = count_rows(&conn).ok();

    Ok(FileInfo {
        path,
        is_dir,
        file_size,
        file_count,
        num_rows,
        schema,
    })
}

/// 递归统计目录下的 parquet 文件数量与总大小
fn collect_parquet_files(
    dir: &Path,
    count: &mut usize,
    size: &mut u64,
    lang: &str,
) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| {
        tr(
            lang,
            &format!("读取目录失败: {e}"),
            &format!("Failed to read directory: {e}"),
        )
    })?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_parquet_files(&path, count, size, lang)?;
        } else if path
            .extension()
            .and_then(|s| s.to_str())
            .map(|s| s.eq_ignore_ascii_case("parquet"))
            .unwrap_or(false)
        {
            *count += 1;
            *size += entry.metadata().map(|m| m.len()).unwrap_or(0);
        }
    }
    Ok(())
}

fn describe_schema(conn: &Connection, lang: &str) -> Result<Vec<ColumnInfo>, String> {
    let mut stmt = conn.prepare("DESCRIBE parquet_view").map_err(|e| {
        tr(
            lang,
            &format!("读取 schema 失败: {e}"),
            &format!("Failed to read schema: {e}"),
        )
    })?;
    let mut rows = stmt.query([]).map_err(|e| {
        tr(
            lang,
            &format!("读取 schema 失败: {e}"),
            &format!("Failed to read schema: {e}"),
        )
    })?;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let name: String = row.get(0).map_err(|e| e.to_string())?;
        let column_type: String = row.get(1).map_err(|e| e.to_string())?;
        out.push(ColumnInfo { name, column_type });
    }
    Ok(out)
}

fn count_rows(conn: &Connection) -> Result<i64, String> {
    let mut stmt = conn
        .prepare("SELECT count(*) FROM parquet_view")
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let row = rows
        .next()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "count 查询无结果".to_string())?;
    row.get(0).map_err(|e| e.to_string())
}

/// 在已注册的 parquet 视图上执行任意 SQL,返回前 limit 行
#[tauri::command]
fn run_query(
    path: String,
    sql: String,
    limit: usize,
    state: tauri::State<LangState>,
) -> Result<QueryResult, String> {
    let lang = state.get();
    let start = Instant::now();
    let limit = if limit == 0 { DEFAULT_LIMIT } else { limit };

    let conn = open_conn(&path, &lang)?;
    let mut stmt = conn.prepare(&sql).map_err(|e| {
        tr(
            &lang,
            &format!("SQL 解析失败: {e}"),
            &format!("SQL parse failed: {e}"),
        )
    })?;
    let mut rows = stmt.query([]).map_err(|e| {
        tr(
            &lang,
            &format!("SQL 执行失败: {e}"),
            &format!("SQL execution failed: {e}"),
        )
    })?;

    // 通过 rows.as_ref() 获取列信息(语句已执行,且避免与 rows 的可变借用冲突)
    let (ncols, columns, column_types) = {
        let s = rows.as_ref().ok_or_else(|| {
            tr(
                &lang,
                "无法获取结果集列信息",
                "Unable to obtain result set column info",
            )
        })?;
        let n = s.column_count();
        let cols = s.column_names();
        let types = (0..n)
            .map(|i| Type::from(&s.column_type(i)).to_string())
            .collect::<Vec<_>>();
        (n, cols, types)
    };

    let mut out = Vec::new();
    let mut truncated = false;
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        if out.len() >= limit {
            truncated = true;
            break;
        }
        let mut vals = Vec::with_capacity(ncols);
        for i in 0..ncols {
            let v = row.get::<usize, Value>(i).map_err(|e| e.to_string())?;
            vals.push(value_to_json(&v));
        }
        out.push(vals);
    }

    Ok(QueryResult {
        row_count: out.len(),
        columns,
        column_types,
        rows: out,
        truncated,
        elapsed_ms: start.elapsed().as_millis() as u64,
    })
}

fn value_to_json(v: &Value) -> serde_json::Value {
    use serde_json::Value as J;
    match v {
        Value::Null => J::Null,
        Value::Boolean(b) => J::Bool(*b),
        Value::TinyInt(i) => J::from(*i),
        Value::SmallInt(i) => J::from(*i),
        Value::Int(i) => J::from(*i),
        Value::BigInt(i) => J::from(*i),
        Value::HugeInt(i) => J::String(i.to_string()),
        Value::UHugeInt(i) => J::String(i.to_string()),
        Value::UTinyInt(i) => J::from(*i),
        Value::USmallInt(i) => J::from(*i),
        Value::UInt(i) => J::from(*i),
        Value::UBigInt(i) => J::from(*i),
        Value::Float(f) => number_from_f64(f64::from(*f)),
        Value::Double(f) => number_from_f64(*f),
        Value::Decimal(d) => J::String(d.to_string()),
        Value::Timestamp(unit, value) => J::String(format_timestamp(*unit, *value)),
        Value::Time64(unit, value) => J::String(format_time_of_day(*unit, *value)),
        Value::Date32(days) => J::String(format_date(*days)),
        Value::Interval { months, days, nanos } => {
            J::String(format!("{months} months {days} days {nanos} nanos"))
        }
        Value::Text(s) => J::String(s.clone()),
        Value::Enum(s) => J::String(s.clone()),
        Value::Blob(b) => blob_to_json(b),
        Value::Geometry(b) => J::String(format!("[GEOMETRY {} bytes]", b.len())),
        Value::List(items) | Value::Array(items) => {
            J::Array(items.iter().map(value_to_json).collect())
        }
        Value::Struct(fields) => J::Object(
            fields
                .iter()
                .map(|(k, val)| (k.clone(), value_to_json(val)))
                .collect(),
        ),
        Value::Map(entries) => J::Array(
            entries
                .iter()
                .map(|(k, val)| {
                    serde_json::json!({ "key": value_to_json(k), "value": value_to_json(val) })
                })
                .collect(),
        ),
        Value::Union(inner) => value_to_json(inner),
        other => J::String(format!("{other:?}")),
    }
}

/// serde_json 无法表示 NaN/Infinity,转字符串兜底
fn number_from_f64(x: f64) -> serde_json::Value {
    use serde_json::Value as J;
    if x.is_finite() {
        J::Number(serde_json::Number::from_f64(x).unwrap_or_else(|| serde_json::Number::from(0)))
    } else {
        J::String(x.to_string())
    }
}

fn format_timestamp(unit: TimeUnit, value: i64) -> String {
    format_iso_utc(unit.to_micros(value))
}

fn format_time_of_day(unit: TimeUnit, value: i64) -> String {
    let micros = unit.to_micros(value);
    let us = micros.rem_euclid(1_000_000);
    let secs = micros.div_euclid(1_000_000);
    let (hh, mm, ss) = (secs / 3600, (secs % 3600) / 60, secs % 60);
    format!("{hh:02}:{mm:02}:{ss:02}.{us:06}")
}

fn format_date(days: i32) -> String {
    let (y, m, d) = civil_from_days(days as i64);
    format!("{y:04}-{m:02}-{d:02}")
}

fn format_iso_utc(micros: i64) -> String {
    let secs = micros.div_euclid(1_000_000);
    let us = micros.rem_euclid(1_000_000);
    let (y, m, d) = civil_from_days(secs.div_euclid(86_400));
    let sod = secs.rem_euclid(86_400);
    let (hh, mm, ss) = (sod / 3600, (sod % 3600) / 60, sod % 60);
    if us == 0 {
        format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}")
    } else {
        format!("{y:04}-{m:02}-{d:02} {hh:02}:{mm:02}:{ss:02}.{us:06}")
    }
}

/// Howard Hinnant 算法:自 Unix epoch 的天数转公历 (year, month, day)
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

fn format_blob(b: &[u8]) -> String {
    let hex: String = b.iter().take(32).map(|x| format!("{x:02x}")).collect();
    if b.len() > 32 {
        format!("[BLOB {} bytes] {hex}...", b.len())
    } else {
        format!("[BLOB {} bytes] {hex}", b.len())
    }
}

/// 通过 magic bytes 检测 blob 是否为图片/音频,返回 (kind, mime)
fn detect_media(b: &[u8]) -> Option<(&'static str, &'static str)> {
    if b.starts_with(&[0x89, 0x50, 0x4E, 0x47]) {
        Some(("image", "image/png"))
    } else if b.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(("image", "image/jpeg"))
    } else if b.starts_with(b"GIF8") {
        Some(("image", "image/gif"))
    } else if b.starts_with(b"BM") {
        Some(("image", "image/bmp"))
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WEBP" {
        Some(("image", "image/webp"))
    } else if b.len() >= 12 && &b[0..4] == b"RIFF" && &b[8..12] == b"WAVE" {
        Some(("audio", "audio/wav"))
    } else if b.starts_with(b"fLaC") {
        Some(("audio", "audio/flac"))
    } else if b.starts_with(b"OggS") {
        Some(("audio", "audio/ogg"))
    } else if b.starts_with(b"ID3") || (b.len() > 1 && b[0] == 0xFF && (b[1] & 0xE0) == 0xE0) {
        Some(("audio", "audio/mpeg"))
    } else {
        None
    }
}

/// blob 列:媒体类型返回可渲染结构(含 base64),其余保持 hex 摘要
fn blob_to_json(b: &[u8]) -> serde_json::Value {
    use base64::Engine;
    use serde_json::Value as J;
    match detect_media(b) {
        Some((kind, mime)) => serde_json::json!({
            "__blob": true,
            "kind": kind,
            "mime": mime,
            "size": b.len(),
            "base64": base64::engine::general_purpose::STANDARD.encode(b),
        }),
        None => J::String(format_blob(b)),
    }
}

/// 把 DuckDB 列类型映射为通用 SQL 建表类型
fn sql_type(t: &str) -> &'static str {
    let u = t.to_uppercase();
    // 数组 / 结构 / MAP 等复杂类型先降级为 VARCHAR,避免被标量规则误匹配
    if u.contains('[')
        || u.contains("STRUCT")
        || u.contains("MAP")
        || u.contains("LIST")
        || u.contains("UNION")
    {
        return "VARCHAR";
    }
    if u.contains("TIMESTAMP") {
        "TIMESTAMP"
    } else if u.contains("DATE") {
        "DATE"
    } else if u.contains("TIME") {
        "TIME"
    } else if u.contains("BOOLEAN") {
        "BOOLEAN"
    } else if u.contains("DOUBLE") {
        "DOUBLE"
    } else if u.contains("FLOAT") || u.contains("REAL") {
        "FLOAT"
    } else if u.contains("BIGINT") {
        "BIGINT"
    } else if u.contains("INT") {
        "INTEGER"
    } else if u.contains("BLOB") || u.contains("BINARY") {
        "BLOB"
    } else if u.contains("VARCHAR") || u.contains("TEXT") || u.contains("CHAR") {
        "VARCHAR"
    } else {
        // LIST / STRUCT / MAP 等复杂类型降级为 VARCHAR
        "VARCHAR"
    }
}

/// 参考原版功能:从 parquet schema 生成 CREATE TABLE 语句
#[tauri::command]
fn generate_sql_schema(
    path: String,
    state: tauri::State<LangState>,
) -> Result<String, String> {
    let lang = state.get();
    let conn = open_conn(&path, &lang)?;
    let mut stmt = conn.prepare("DESCRIBE parquet_view").map_err(|e| {
        tr(
            &lang,
            &format!("读取 schema 失败: {e}"),
            &format!("Failed to read schema: {e}"),
        )
    })?;
    let mut rows = stmt.query([]).map_err(|e| {
        tr(
            &lang,
            &format!("读取 schema 失败: {e}"),
            &format!("Failed to read schema: {e}"),
        )
    })?;
    let mut cols = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let name: String = row.get(0).map_err(|e| e.to_string())?;
        let ty: String = row.get(1).map_err(|e| e.to_string())?;
        cols.push((name, ty));
    }
    drop(rows);
    drop(stmt);
    if cols.is_empty() {
        return Err(tr(&lang, "schema 为空", "Schema is empty"));
    }
    let width = cols.iter().map(|(n, _)| n.len()).max().unwrap_or(0);
    let body: Vec<String> = cols
        .iter()
        .map(|(name, ty)| format!("    {name:<width$} {}", sql_type(ty)))
        .collect();
    Ok(format!(
        "-- Generated from: {path}\nCREATE TABLE parquet_table (\n{}\n);\n",
        body.join(",\n")
    ))
}

/// 导出媒体数据:弹保存对话框并把 base64 内容写入文件
///
/// 必须是 async command:阻塞式保存对话框 `blocking_save_file()` 若在同步 command
/// (主线程)中调用会阻塞事件循环,导致整个应用卡死(转菊花)。async command 跑在
/// 独立线程池,阻塞的是工作线程,主线程照常处理对话框与 UI。
#[tauri::command]
async fn export_base64(
    app: tauri::AppHandle,
    base64_data: String,
    default_name: String,
    state: tauri::State<'_, LangState>,
) -> Result<Option<String>, String> {
    use base64::Engine;
    use tauri_plugin_dialog::DialogExt;
    // 先把语言取出并释放锁,避免跨 await 持有 MutexGuard
    let lang = state.get();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&base64_data)
        .map_err(|e| {
            tr(
                &lang,
                &format!("base64 解码失败: {e}"),
                &format!("base64 decode failed: {e}"),
            )
        })?;
    let Some(fp) = app
        .dialog()
        .file()
        .set_file_name(&default_name)
        .blocking_save_file()
    else {
        return Ok(None); // 用户取消
    };
    let Some(path) = fp.as_path() else {
        return Err(tr(
            &lang,
            "无法解析保存路径",
            "Unable to resolve save path",
        ));
    };
    std::fs::write(path, &bytes).map_err(|e| {
        tr(
            &lang,
            &format!("写入失败: {e}"),
            &format!("Write failed: {e}"),
        )
    })?;
    Ok(Some(path.display().to_string()))
}

#[cfg(test)]
mod tests {
    use super::{detect_media, sql_type, tr};

    #[test]
    fn tr_picks_language() {
        assert_eq!(tr("en", "中文", "English"), "English");
        assert_eq!(tr("zh-CN", "中文", "English"), "中文");
        // 未知语言回退英文(默认语言)
        assert_eq!(tr("fr", "中文", "English"), "English");
    }

    #[test]
    fn detects_png() {
        let b = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert_eq!(detect_media(&b), Some(("image", "image/png")));
    }

    #[test]
    fn detects_jpeg() {
        assert_eq!(
            detect_media(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00]),
            Some(("image", "image/jpeg"))
        );
    }

    #[test]
    fn detects_wav() {
        let mut b = b"RIFF".to_vec();
        b.extend_from_slice(&[0x24, 0x00, 0x00, 0x00]);
        b.extend_from_slice(b"WAVE");
        assert_eq!(detect_media(&b), Some(("audio", "audio/wav")));
    }

    #[test]
    fn detects_mp3() {
        assert_eq!(detect_media(b"ID3\x04\x00"), Some(("audio", "audio/mpeg")));
    }

    #[test]
    fn non_media_blob() {
        assert_eq!(detect_media(&[0x00, 0x01, 0x02, 0x03]), None);
        assert_eq!(detect_media(b"hello world"), None);
    }

    #[test]
    fn type_mapping() {
        assert_eq!(sql_type("VARCHAR"), "VARCHAR");
        assert_eq!(sql_type("BIGINT"), "BIGINT");
        assert_eq!(sql_type("DOUBLE"), "DOUBLE");
        assert_eq!(sql_type("BOOLEAN"), "BOOLEAN");
        assert_eq!(sql_type("TIMESTAMP WITH TIME ZONE"), "TIMESTAMP");
        assert_eq!(sql_type("BLOB"), "BLOB");
        assert_eq!(sql_type("INTEGER[]"), "VARCHAR"); // 复杂类型降级
    }
}

/// 返回关于对话框所需的应用信息
#[tauri::command]
fn about_info() -> serde_json::Value {
    serde_json::json!({
        "name": "Parquet Viewer",
        "version": env!("CARGO_PKG_VERSION"),
        "license": env!("CARGO_PKG_LICENSE"),
    })
}

/// 前端初始化/切换时同步语言到后端:更新状态并重建原生菜单(勾选态)。
/// 不 emit change-language(前端已自行应用),避免回环。
#[tauri::command]
fn set_app_language(app: tauri::AppHandle, lang: String) {
    if lang != "en" && lang != "zh-CN" {
        return;
    }
    if let Some(st) = app.try_state::<LangState>() {
        if let Ok(mut g) = st.0.lock() {
            *g = lang.clone();
        }
    }
    if let Ok(menu) = build_menu(&app, &lang) {
        let _ = app.set_menu(menu);
    }
}

/// 依据语言构建原生菜单。Help 下含 About 与 Language 子菜单(简体中文/English 勾选)。
/// Edit 菜单必须保留,否则 macOS 上 Cmd+C/V/X/Z 等编辑快捷键失效。
fn build_menu(
    app: &tauri::AppHandle,
    lang: &str,
) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let about_text = tr(lang, "关于 Parquet Viewer", "About Parquet Viewer");
    let about = MenuItemBuilder::with_id("about", about_text.clone()).build(app)?;
    let app_menu = SubmenuBuilder::with_id(app, "app", "Parquet Viewer")
        .item(&about)
        .separator()
        .item(&PredefinedMenuItem::quit(app, None)?)
        .build()?;
    let edit = SubmenuBuilder::with_id(app, "edit", tr(lang, "编辑", "Edit"))
        .item(&PredefinedMenuItem::undo(app, None)?)
        .item(&PredefinedMenuItem::redo(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, None)?)
        .item(&PredefinedMenuItem::copy(app, None)?)
        .item(&PredefinedMenuItem::paste(app, None)?)
        .item(&PredefinedMenuItem::select_all(app, None)?)
        .build()?;
    let window = SubmenuBuilder::with_id(app, "window", tr(lang, "窗口", "Window"))
        .item(&PredefinedMenuItem::minimize(app, None)?)
        .item(&PredefinedMenuItem::maximize(app, None)?)
        .separator()
        .item(&PredefinedMenuItem::close_window(app, None)?)
        .build()?;
    // 语言子菜单:两项互斥勾选
    let lang_zh = CheckMenuItemBuilder::with_id("lang-zh-CN", "简体中文")
        .checked(lang != "en")
        .build(app)?;
    let lang_en = CheckMenuItemBuilder::with_id("lang-en", "English")
        .checked(lang == "en")
        .build(app)?;
    let language = SubmenuBuilder::with_id(app, "language", tr(lang, "语言", "Language"))
        .item(&lang_zh)
        .item(&lang_en)
        .build()?;
    let help_about = MenuItemBuilder::with_id("about", about_text).build(app)?;
    let help = SubmenuBuilder::with_id(app, "help", tr(lang, "帮助", "Help"))
        .item(&help_about)
        .separator()
        .item(&language)
        .build()?;
    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&edit)
        .item(&window)
        .item(&help)
        .build()
}

/// 菜单驱动的语言切换:更新状态 + 重建菜单 + emit 通知前端。
fn set_language(app: &tauri::AppHandle, lang: &str) {
    if let Some(st) = app.try_state::<LangState>() {
        if let Ok(mut g) = st.0.lock() {
            *g = lang.to_string();
        }
    }
    if let Ok(menu) = build_menu(app, lang) {
        let _ = app.set_menu(menu);
    }
    let _ = app.emit("change-language", lang);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(LangState(Mutex::new("en".to_string())))
        .invoke_handler(tauri::generate_handler![
            open_path,
            run_query,
            about_info,
            generate_sql_schema,
            export_base64,
            set_app_language
        ])
        .setup(|app| {
            // 初始菜单:默认英文,前端 init 会立即调用 set_app_language 同步为实际语言
            let handle = app.handle().clone();
            let menu = build_menu(&handle, "en")?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| match event.id().as_ref() {
                "about" => {
                    let _ = app.emit("show-about", ());
                }
                "lang-zh-CN" => set_language(app, "zh-CN"),
                "lang-en" => set_language(app, "en"),
                _ => {}
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
