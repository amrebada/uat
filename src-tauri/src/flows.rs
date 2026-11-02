//! Flows run in the frontend; Rust keeps them on disk (`flows.json`) and
//! writes the sheets their steps make, as .xlsx or .csv, and their reports.

use std::fs;
use std::path::{Path, PathBuf};

use rust_xlsxwriter::{Format, Workbook};
use serde::Deserialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::collections::{load_doc, save_doc};
use crate::docker::{expand_home, CmdResult};

const FILE: &str = "flows.json";
/// Where a sheet or report with a relative path goes
const OUT_DIR: &str = "~/Documents/UAT";
/// The most an .xlsx cell holds
const CELL_MAX: usize = 32_767;

#[tauri::command]
pub fn flows_load(app: AppHandle) -> CmdResult<Option<Value>> {
    load_doc(&app, FILE)
}

#[tauri::command]
pub fn flows_save(app: AppHandle, flows: Value) -> CmdResult<()> {
    save_doc(&app, FILE, &flows)
}

#[derive(Deserialize)]
pub struct Sheet {
    path: String,
    columns: Vec<String>,
    rows: Vec<Vec<Value>>,
}

/// Writes the sheet, replacing the file if it's there. Returns its full path.
#[tauri::command]
pub async fn flow_write_sheet(sheet: Sheet) -> CmdResult<String> {
    tauri::async_runtime::spawn_blocking(move || write_sheet(&sheet))
        .await
        .map_err(|e| e.to_string())?
        .map(|p| p.display().to_string())
}

/// Writes a run's report, made by the frontend as HTML or Markdown. Returns its full path.
#[tauri::command]
pub fn flow_write_report(path: String, text: String) -> CmdResult<String> {
    let path = out_path(&path);
    replace(&path, |tmp| fs::write(tmp, &text).map_err(|e| e.to_string()))?;
    Ok(path.display().to_string())
}

/// Opens a file the way Finder would, or shows it in Finder.
#[tauri::command]
pub fn flow_open(path: String, reveal: bool) -> CmdResult<()> {
    let done = if reveal {
        tauri_plugin_opener::reveal_item_in_dir(&path)
    } else {
        tauri_plugin_opener::open_path(&path, None::<&str>)
    };
    done.map_err(|e| e.to_string())
}

fn out_path(path: &str) -> PathBuf {
    let path = expand_home(path);
    if path.is_absolute() {
        path
    } else {
        expand_home(OUT_DIR).join(path)
    }
}

/// Writes `path` through a temp file beside it, so a half-written file never
/// replaces a whole one
fn replace(path: &Path, write: impl FnOnce(&Path) -> CmdResult<()>) -> CmdResult<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("Couldn't make {}: {e}", dir.display()))?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{name}.tmp"));
    if let Err(e) = write(&tmp).and_then(|_| fs::rename(&tmp, path).map_err(|e| e.to_string())) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("Couldn't write {}: {e}", path.display()));
    }
    Ok(())
}

fn write_sheet(sheet: &Sheet) -> CmdResult<PathBuf> {
    let path = out_path(&sheet.path);
    let kind = path.extension().and_then(|e| e.to_str()).map(str::to_ascii_lowercase);
    if !matches!(kind.as_deref(), Some("xlsx" | "csv")) {
        return Err(format!("{} should end in .xlsx or .csv", path.display()));
    }
    replace(&path, |tmp| match kind.as_deref() {
        Some("csv") => fs::write(tmp, csv(sheet)).map_err(|e| e.to_string()),
        _ => xlsx(sheet, tmp),
    })?;
    Ok(path)
}

fn text(v: &Value) -> String {
    match v {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

/// RFC 4180, with a byte-order mark so Excel reads it as UTF-8
fn csv(sheet: &Sheet) -> String {
    let field = |s: &str| {
        if s.contains([',', '"', '\n', '\r']) || s.starts_with(' ') || s.ends_with(' ') {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_string()
        }
    };
    let mut out = String::from("\u{feff}");
    let header: Vec<String> = sheet.columns.iter().map(|c| field(c)).collect();
    out.push_str(&header.join(","));
    out.push_str("\r\n");
    for row in &sheet.rows {
        let cells: Vec<String> = row.iter().map(|v| field(&text(v))).collect();
        out.push_str(&cells.join(","));
        out.push_str("\r\n");
    }
    out
}

fn xlsx(sheet: &Sheet, path: &Path) -> CmdResult<()> {
    let e = |e: rust_xlsxwriter::XlsxError| e.to_string();
    let mut book = Workbook::new();
    let ws = book.add_worksheet();
    let bold = Format::new().set_bold();
    for (c, header) in sheet.columns.iter().enumerate() {
        ws.write_string_with_format(0, c as u16, clip(header), &bold).map_err(e)?;
    }
    for (r, row) in sheet.rows.iter().enumerate() {
        let r = r as u32 + 1;
        for (c, v) in row.iter().enumerate() {
            let c = c as u16;
            match v {
                Value::Null => continue,
                Value::Number(n) => ws.write_number(r, c, n.as_f64().unwrap_or_default()),
                Value::Bool(b) => ws.write_boolean(r, c, *b),
                other => ws.write_string(r, c, clip(&text(other))),
            }
            .map_err(e)?;
        }
    }
    ws.set_freeze_panes(1, 0).map_err(e)?;
    ws.autofit();
    book.save(path).map_err(e)
}

fn clip(s: &str) -> &str {
    match s.char_indices().nth(CELL_MAX) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sheet(path: &Path) -> Sheet {
        Sheet {
            path: path.display().to_string(),
            columns: vec!["Ride".into(), "Route".into(), "Fare".into(), "Paid".into()],
            rows: vec![
                vec![json!("r-1"), json!("Maarif, \"Anfa\""), json!(42.5), json!(true)],
                vec![json!("r-2"), json!(null), json!(30), json!({ "x": 1 })],
            ],
        }
    }

    #[test]
    fn writes_csv_and_xlsx() {
        let dir = std::env::temp_dir().join(format!("uat-sheet-{}", std::process::id()));
        let csv_path = dir.join("nested/rides.csv");
        assert_eq!(write_sheet(&sheet(&csv_path)).unwrap(), csv_path);
        assert_eq!(
            fs::read_to_string(&csv_path).unwrap(),
            "\u{feff}Ride,Route,Fare,Paid\r\nr-1,\"Maarif, \"\"Anfa\"\"\",42.5,true\r\nr-2,,30,\"{\"\"x\"\":1}\"\r\n"
        );

        let xlsx_path = dir.join("rides.xlsx");
        write_sheet(&sheet(&xlsx_path)).unwrap();
        let bytes = fs::read(&xlsx_path).unwrap();
        assert_eq!(&bytes[..2], b"PK", "an .xlsx is a zip");
        assert!(!dir.join(".rides.xlsx.tmp").exists());

        let err = write_sheet(&sheet(&dir.join("rides.txt"))).unwrap_err();
        assert!(err.ends_with("should end in .xlsx or .csv"), "{err}");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn writes_reports() {
        let dir = std::env::temp_dir().join(format!("uat-report-{}", std::process::id()));
        let path = dir.join("nested/Book a ride 2026-11-01 17-39.html");
        let written = flow_write_report(path.display().to_string(), "<h1>é</h1>".into()).unwrap();
        assert_eq!(written, path.display().to_string());
        assert_eq!(fs::read_to_string(&path).unwrap(), "<h1>é</h1>");
        // Again, replacing it
        flow_write_report(path.display().to_string(), "# Book a ride\n".into()).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Book a ride\n");
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1, "no temp file left");
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn puts_relative_sheets_in_documents() {
        let home = crate::docker::home_dir().unwrap();
        assert_eq!(out_path("rides.xlsx"), PathBuf::from(&home).join("Documents/UAT/rides.xlsx"));
        assert_eq!(out_path("~/x/y.csv"), PathBuf::from(&home).join("x/y.csv"));
        assert_eq!(out_path("/tmp/a.csv"), PathBuf::from("/tmp/a.csv"));
        assert_eq!(clip(&"é".repeat(CELL_MAX + 5)).chars().count(), CELL_MAX);
    }
}
