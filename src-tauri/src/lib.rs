use std::path::Path;
use std::time::Instant;

use duckdb::types::{TimeUnit, Type, Value};
use duckdb::Connection;
use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;

/// 单次查询默认返回的最大行数(前端可指定)
const DEFAULT_LIMIT: usize = 1000;

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
fn open_conn(path: &str) -> Result<Connection, String> {
    let conn = Connection::open_in_memory().map_err(|e| format!("无法创建内存数据库连接: {e}"))?;
    let escaped = path.replace('\'', "''");
    conn.execute_batch(&format!(
        "CREATE OR REPLACE VIEW parquet_view AS SELECT * FROM read_parquet('{escaped}')"
    ))
    .map_err(|e| format!("打开 Parquet 文件失败: {e}"))?;

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
fn open_path(path: String) -> Result<FileInfo, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("路径不存在: {path}"));
    }
    let is_dir = p.is_dir();
    let (file_size, file_count) = if is_dir {
        let mut size = 0u64;
        let mut count = 0usize;
        collect_parquet_files(p, &mut count, &mut size)?;
        (size, count)
    } else {
        (std::fs::metadata(p).map(|m| m.len()).unwrap_or(0), 1)
    };

    let conn = open_conn(&path)?;
    let schema = describe_schema(&conn)?;
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
fn collect_parquet_files(dir: &Path, count: &mut usize, size: &mut u64) -> Result<(), String> {
    let entries = std::fs::read_dir(dir).map_err(|e| format!("读取目录失败: {e}"))?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_parquet_files(&path, count, size)?;
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

fn describe_schema(conn: &Connection) -> Result<Vec<ColumnInfo>, String> {
    let mut stmt = conn
        .prepare("DESCRIBE parquet_view")
        .map_err(|e| format!("读取 schema 失败: {e}"))?;
    let mut rows = stmt
        .query([])
        .map_err(|e| format!("读取 schema 失败: {e}"))?;
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
fn run_query(path: String, sql: String, limit: usize) -> Result<QueryResult, String> {
    let start = Instant::now();
    let limit = if limit == 0 { DEFAULT_LIMIT } else { limit };

    let conn = open_conn(&path)?;
    let mut stmt = conn
        .prepare(&sql)
        .map_err(|e| format!("SQL 解析失败: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("SQL 执行失败: {e}"))?;

    // 通过 rows.as_ref() 获取列信息(语句已执行,且避免与 rows 的可变借用冲突)
    let (ncols, columns, column_types) = {
        let s = rows
            .as_ref()
            .ok_or_else(|| "无法获取结果集列信息".to_string())?;
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
        Value::Blob(b) => J::String(format_blob(b)),
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

/// 返回关于对话框所需的应用信息
#[tauri::command]
fn about_info() -> serde_json::Value {
    serde_json::json!({
        "name": "Parquet Viewer",
        "version": env!("CARGO_PKG_VERSION"),
        "license": env!("CARGO_PKG_LICENSE"),
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![open_path, run_query, about_info])
        .setup(|app| {
            // macOS 惯例:第一个菜单为应用名菜单,About 同时出现在应用菜单和 Help 菜单
            // (Help > About 参考原版 ParquetViewer 的布局)
            let about = MenuItemBuilder::with_id("about", "About Parquet Viewer").build(app)?;
            let app_menu = SubmenuBuilder::with_id(app, "app", "Parquet Viewer")
                .item(&about)
                .separator()
                .item(&PredefinedMenuItem::quit(app, None)?)
                .build()?;
            // Edit 菜单必须保留,否则 macOS 上 Cmd+C/V/X/Z 等编辑快捷键失效
            let edit = SubmenuBuilder::with_id(app, "edit", "Edit")
                .item(&PredefinedMenuItem::undo(app, None)?)
                .item(&PredefinedMenuItem::redo(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::cut(app, None)?)
                .item(&PredefinedMenuItem::copy(app, None)?)
                .item(&PredefinedMenuItem::paste(app, None)?)
                .item(&PredefinedMenuItem::select_all(app, None)?)
                .build()?;
            let window = SubmenuBuilder::with_id(app, "window", "Window")
                .item(&PredefinedMenuItem::minimize(app, None)?)
                .item(&PredefinedMenuItem::maximize(app, None)?)
                .separator()
                .item(&PredefinedMenuItem::close_window(app, None)?)
                .build()?;
            let help_about =
                MenuItemBuilder::with_id("about", "About Parquet Viewer").build(app)?;
            let help = SubmenuBuilder::with_id(app, "help", "Help")
                .item(&help_about)
                .build()?;
            let menu = MenuBuilder::new(app)
                .item(&app_menu)
                .item(&edit)
                .item(&window)
                .item(&help)
                .build()?;
            app.set_menu(menu)?;
            app.on_menu_event(|app, event| {
                if event.id().as_ref() == "about" {
                    let _ = app.emit("show-about", ());
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
