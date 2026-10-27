//! Quick actions offered after a drop. Every action writes *new* files next to the
//! originals (never overwrites) and the result can be undone by moving those outputs
//! to the Trash / Recycle Bin.

use crate::files::unique_path;
use image::{codecs::jpeg::JpegEncoder, imageops::FilterType, DynamicImage, Rgb, RgbImage};
use serde::Serialize;
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};
use tauri::{AppHandle, Emitter};

#[derive(Serialize, Debug, PartialEq)]
pub struct ActionInfo {
    pub id: &'static str,
    pub label: String,
    /// How many of the given files it will process.
    pub count: usize,
}

#[derive(Serialize, Debug)]
pub struct ActionReport {
    pub outputs: Vec<String>,
    pub message: String,
    /// Per-file problems that didn't stop the rest.
    pub skipped: Vec<String>,
}

const RASTER: &[&str] = &["jpg", "jpeg", "png", "webp", "bmp", "tif", "tiff", "gif"];
const HEIC: &[&str] = &["heic", "heif"];
/// "Compress" target.
const MAX_BYTES: usize = 1_000_000;

fn ext_of(p: &Path) -> String {
    p.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default()
}
fn with_ext(paths: &[PathBuf], exts: &[&str]) -> Vec<PathBuf> {
    paths.iter().filter(|p| p.is_file() && exts.contains(&ext_of(p).as_str())).cloned().collect()
}
fn compressible(paths: &[PathBuf]) -> Vec<PathBuf> {
    let mut v = with_ext(paths, RASTER);
    if cfg!(target_os = "macos") {
        v.extend(with_ext(paths, HEIC));
    }
    v
}

pub fn available(paths: &[PathBuf]) -> Vec<ActionInfo> {
    let mut out = Vec::new();
    let n = compressible(paths).len();
    if n > 0 {
        out.push(ActionInfo { id: "image.compress", label: plural(n, "Compress image", "Compress images") + " to under 1 MB", count: n });
    }
    let n = with_ext(paths, HEIC).len();
    if n > 0 {
        out.push(ActionInfo { id: "image.heic_to_jpg", label: "Convert HEIC to JPG".into(), count: n });
    }
    let n = with_ext(paths, &["pdf"]).len();
    if n >= 2 {
        out.push(ActionInfo { id: "pdf.merge", label: format!("Merge {n} PDFs into one"), count: n });
    }
    out
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 { one.to_string() } else { many.to_string() }
}

pub fn run(id: &str, paths: &[PathBuf]) -> Result<ActionReport, String> {
    let mut outputs = Vec::new();
    let mut skipped = Vec::new();
    match id {
        "image.compress" => {
            for p in compressible(paths) {
                match compress(&p) {
                    Ok(Some(out)) => outputs.push(out),
                    Ok(None) => skipped.push(format!("{} is already under 1 MB", name(&p))),
                    Err(e) => skipped.push(format!("{}: {e}", name(&p))),
                }
            }
        }
        "image.heic_to_jpg" => {
            for p in with_ext(paths, HEIC) {
                let out = unique_path(&p.with_extension("jpg"));
                match heic_to_jpg(&p, &out) {
                    Ok(()) => outputs.push(out),
                    Err(e) => skipped.push(format!("{}: {e}", name(&p))),
                }
            }
        }
        "pdf.merge" => {
            let pdfs = with_ext(paths, &["pdf"]);
            if pdfs.len() < 2 {
                return Err("Merging needs at least two PDFs.".into());
            }
            let dir = pdfs[0].parent().unwrap_or(Path::new("."));
            let out = unique_path(&dir.join(format!("Merged ({} files).pdf", pdfs.len())));
            merge_pdfs(&pdfs, &out)?;
            outputs.push(out);
        }
        _ => return Err(format!("Unknown action {id}")),
    }
    if outputs.is_empty() {
        return Err(skipped.first().cloned().unwrap_or_else(|| "Nothing to do.".into()));
    }
    let message = match id {
        "pdf.merge" => format!("Merged into {}", name(&outputs[0])),
        _ => format!("Created {}", plural(outputs.len(), &name(&outputs[0]), &format!("{} files", outputs.len()))),
    };
    Ok(ActionReport { outputs: outputs.iter().map(|p| p.to_string_lossy().into_owned()).collect(), message, skipped })
}

fn name(p: &Path) -> String {
    p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/* ---------- images ---------- */

/// Re-encode as JPEG under MAX_BYTES, shrinking dimensions only if quality alone isn't
/// enough. Returns None if the file is already a small enough JPEG.
fn compress(src: &Path) -> Result<Option<PathBuf>, String> {
    let ext = ext_of(src);
    if matches!(ext.as_str(), "jpg" | "jpeg") && fs::metadata(src).map(|m| m.len() as usize).unwrap_or(usize::MAX) <= MAX_BYTES {
        return Ok(None);
    }
    let img = if HEIC.contains(&ext.as_str()) {
        // Decode HEIC via the OS converter into a temp JPEG first.
        let tmp = std::env::temp_dir().join(format!("fugu-{}.jpg", std::process::id()));
        heic_to_jpg(src, &tmp)?;
        let img = image::open(&tmp).map_err(|e| e.to_string());
        let _ = fs::remove_file(&tmp);
        img?
    } else {
        image::open(src).map_err(|e| format!("can't read image ({e})"))?
    };
    let mut rgb = flatten_on_white(&img);
    // Very large photos: cap the long side first; nobody needs 8K under 1 MB.
    const MAX_SIDE: u32 = 4096;
    if rgb.width().max(rgb.height()) > MAX_SIDE {
        rgb = DynamicImage::ImageRgb8(rgb).resize(MAX_SIDE, MAX_SIDE, FilterType::Triangle).to_rgb8();
    }
    let bytes = encode_under(rgb, MAX_BYTES)?;
    let stem = src.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_else(|| "image".into());
    let out = unique_path(&src.with_file_name(format!("{stem} (compressed).jpg")));
    fs::write(&out, bytes).map_err(|e| e.to_string())?;
    Ok(Some(out))
}

/// JPEG has no alpha: composite transparent pixels over white instead of black.
fn flatten_on_white(img: &DynamicImage) -> RgbImage {
    let rgba = img.to_rgba8();
    RgbImage::from_fn(img.width(), img.height(), |x, y| {
        let p = rgba.get_pixel(x, y).0;
        let a = p[3] as u32;
        let mix = |c: u8| ((c as u32 * a + 255 * (255 - a)) / 255) as u8;
        Rgb([mix(p[0]), mix(p[1]), mix(p[2])])
    })
}

fn encode_under(mut rgb: RgbImage, limit: usize) -> Result<Vec<u8>, String> {
    for _ in 0..8 {
        for q in [85u8, 75, 65, 55, 45] {
            let mut buf = Vec::new();
            JpegEncoder::new_with_quality(&mut buf, q).encode_image(&rgb).map_err(|e| e.to_string())?;
            if buf.len() <= limit {
                return Ok(buf);
            }
        }
        let (w, h) = rgb.dimensions();
        if w < 64 || h < 64 {
            break;
        }
        rgb = DynamicImage::ImageRgb8(rgb).resize(w * 3 / 4, h * 3 / 4, FilterType::Triangle).to_rgb8();
    }
    Err("couldn't get it under 1 MB".into())
}

fn heic_to_jpg(src: &Path, out: &Path) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        // `sips` ships with macOS and decodes HEIC natively.
        let status = std::process::Command::new("/usr/bin/sips")
            .args(["-s", "format", "jpeg", "-s", "formatOptions", "90"])
            .arg(src)
            .arg("--out")
            .arg(out)
            .output()
            .map_err(|e| e.to_string())?;
        if status.status.success() && out.exists() {
            Ok(())
        } else {
            Err("macOS couldn't convert this HEIC".into())
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (src, out);
        Err("HEIC conversion isn't available on Windows yet".into())
    }
}

/* ---------- PDF ---------- */

/// Concatenate PDFs in the given order (bookmarks/outlines are dropped).
fn merge_pdfs(inputs: &[PathBuf], out: &Path) -> Result<(), String> {
    use lopdf::{Document, Object, ObjectId};
    let mut max_id = 1;
    let mut pages: Vec<(ObjectId, Object)> = Vec::new(); // in reading order
    let mut objects: BTreeMap<ObjectId, Object> = BTreeMap::new();
    for path in inputs {
        let mut doc = Document::load(path).map_err(|e| format!("{}: {e}", name(path)))?;
        if doc.is_encrypted() {
            return Err(format!("{} is password-protected", name(path)));
        }
        doc.renumber_objects_with(max_id);
        max_id = doc.max_id + 1;
        for (_, id) in doc.get_pages() {
            let page = with_inherited(&doc, id).map_err(|e| e.to_string())?;
            pages.push((id, Object::Dictionary(page)));
        }
        objects.extend(doc.objects);
    }

    let mut merged = Document::with_version("1.5");
    let mut catalog: Option<(ObjectId, Object)> = None;
    let mut pages_root: Option<(ObjectId, Object)> = None;
    for (id, obj) in objects {
        match obj.type_name().unwrap_or(b"") {
            b"Catalog" => catalog = Some(catalog.map_or((id, obj.clone()), |(cid, _)| (cid, obj))),
            b"Pages" => {
                if let Ok(dict) = obj.as_dict() {
                    let mut dict = dict.clone();
                    if let Some((_, Ok(old))) = pages_root.as_ref().map(|(i, o)| (i, o.as_dict())) {
                        dict.extend(old);
                    }
                    let keep = pages_root.as_ref().map_or(id, |(i, _)| *i);
                    pages_root = Some((keep, Object::Dictionary(dict)));
                }
            }
            b"Page" | b"Outlines" | b"Outline" => {}
            _ => {
                merged.objects.insert(id, obj);
            }
        }
    }
    let (pages_id, pages_obj) = pages_root.ok_or("no pages found")?;
    let (catalog_id, catalog_obj) = catalog.ok_or("no document catalog found")?;
    for (id, page) in &pages {
        if let Ok(dict) = page.as_dict() {
            let mut dict = dict.clone();
            dict.set("Parent", pages_id);
            merged.objects.insert(*id, Object::Dictionary(dict));
        }
    }
    let mut pages_dict = pages_obj.as_dict().map_err(|e| e.to_string())?.clone();
    pages_dict.set("Count", pages.len() as u32);
    pages_dict.set("Kids", pages.iter().map(|(id, _)| Object::Reference(*id)).collect::<Vec<_>>());
    merged.objects.insert(pages_id, Object::Dictionary(pages_dict));
    let mut catalog_dict = catalog_obj.as_dict().map_err(|e| e.to_string())?.clone();
    catalog_dict.set("Pages", pages_id);
    catalog_dict.remove(b"Outlines");
    merged.objects.insert(catalog_id, Object::Dictionary(catalog_dict));
    merged.trailer.set("Root", catalog_id);
    merged.max_id = merged.objects.keys().map(|(n, _)| *n).max().unwrap_or(0);
    merged.renumber_objects();
    merged.compress();
    merged.save(out).map_err(|e| e.to_string())?;
    Ok(())
}

/// Page attributes a page may inherit from its ancestors (PDF 1.7 §7.7.3.4). Merging
/// re-parents pages, so copy these onto the page itself or they'd be lost.
const INHERITABLE: [&[u8]; 4] = [b"MediaBox", b"CropBox", b"Resources", b"Rotate"];

fn with_inherited(doc: &lopdf::Document, page_id: lopdf::ObjectId) -> lopdf::Result<lopdf::Dictionary> {
    let mut page = doc.get_dictionary(page_id)?.clone();
    let mut parent = page.get(b"Parent").and_then(|p| p.as_reference()).ok();
    let mut depth = 0;
    while let Some(pid) = parent {
        let Ok(node) = doc.get_dictionary(pid) else { break };
        for key in INHERITABLE {
            if !page.has(key) {
                if let Ok(v) = node.get(key) {
                    page.set(key, v.clone());
                }
            }
        }
        parent = node.get(b"Parent").and_then(|p| p.as_reference()).ok();
        depth += 1;
        if depth > 64 {
            break; // malformed cycle
        }
    }
    Ok(page)
}

/* ---------- commands ---------- */

#[tauri::command]
pub fn actions_for(paths: Vec<PathBuf>) -> Vec<ActionInfo> {
    available(&paths)
}

/// Runs an action. The fish shows the "working" state meanwhile.
#[tauri::command]
pub async fn run_action(app: AppHandle, id: String, paths: Vec<PathBuf>) -> Result<ActionReport, String> {
    let _ = app.emit("pet://work", "start");
    let result = tauri::async_runtime::spawn_blocking(move || run(&id, &paths))
        .await
        .map_err(|e| e.to_string())
        .and_then(|r| r);
    let _ = app.emit("pet://work", if result.is_ok() { "done" } else { "error" });
    result
}

/// Undo an action: its outputs go to the Trash (recoverable), never deleted outright.
#[tauri::command]
pub fn trash_outputs(paths: Vec<PathBuf>) -> Result<(), String> {
    let existing: Vec<_> = paths.into_iter().filter(|p| p.exists()).collect();
    #[allow(unused_mut)]
    let mut ctx = trash::TrashContext::default();
    // The default asks Finder via AppleScript, which pops an automation-permission
    // prompt. NSFileManager trashes directly, no permission needed.
    #[cfg(target_os = "macos")]
    {
        use trash::macos::{DeleteMethod, TrashContextExtMacos};
        ctx.set_delete_method(DeleteMethod::NsFileManager);
    }
    ctx.delete_all(existing).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("fugu-actions-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    /// Noisy image: compresses badly, so the size loop actually has work to do.
    fn noisy_png(path: &Path, w: u32, h: u32) {
        let mut seed = 12345u32;
        let img = RgbImage::from_fn(w, h, |_, _| {
            seed = seed.wrapping_mul(1103515245).wrapping_add(12345);
            let b = seed.to_le_bytes();
            Rgb([b[1], b[2], b[3]])
        });
        img.save(path).unwrap();
    }

    #[test]
    fn offers_actions_by_type() {
        let d = tmp("offer");
        for f in ["a.png", "b.pdf", "c.pdf", "notes.txt"] {
            fs::write(d.join(f), b"x").unwrap();
        }
        let ids: Vec<_> = available(&[d.join("a.png"), d.join("b.pdf"), d.join("c.pdf"), d.join("notes.txt")]).into_iter().map(|a| a.id).collect();
        assert_eq!(ids, ["image.compress", "pdf.merge"]);
        assert!(available(&[d.join("b.pdf")]).is_empty(), "merge needs two PDFs");
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn compress_gets_under_limit_without_touching_original() {
        let d = tmp("compress");
        let src = d.join("big.png");
        noisy_png(&src, 1800, 1400);
        let before = fs::read(&src).unwrap();
        assert!(before.len() > MAX_BYTES);
        let report = run("image.compress", &[src.clone()]).unwrap();
        let out = PathBuf::from(&report.outputs[0]);
        assert_eq!(out.file_name().unwrap(), "big (compressed).jpg");
        assert!(fs::metadata(&out).unwrap().len() as usize <= MAX_BYTES);
        assert_eq!(fs::read(&src).unwrap(), before);
        fs::remove_dir_all(d).unwrap();
    }

    #[test]
    fn merges_pdfs_in_order() {
        use lopdf::{content::{Content, Operation}, dictionary, Document, Object, Stream};
        fn one_page(path: &Path, text: &str) {
            let mut doc = Document::with_version("1.5");
            let pages_id = doc.new_object_id();
            let font = doc.add_object(dictionary! { "Type" => "Font", "Subtype" => "Type1", "BaseFont" => "Courier" });
            let res = doc.add_object(dictionary! { "Font" => dictionary! { "F1" => font } });
            let content = Content { operations: vec![
                Operation::new("BT", vec![]), Operation::new("Tf", vec!["F1".into(), 24.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]), Operation::new("ET", vec![]),
            ]};
            let c = doc.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
            // MediaBox and Resources live on the Pages node and are inherited, as many
            // real-world PDFs do; merging must carry them over.
            let page = doc.add_object(dictionary! { "Type" => "Page", "Parent" => pages_id, "Contents" => c });
            doc.objects.insert(pages_id, Object::Dictionary(dictionary! { "Type" => "Pages", "Kids" => vec![page.into()], "Count" => 1, "Resources" => res, "MediaBox" => vec![0.into(), 0.into(), 300.into(), 300.into()] }));
            let cat = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
            doc.trailer.set("Root", cat);
            doc.save(path).unwrap();
        }
        let d = tmp("merge");
        let (a, b, c) = (d.join("1.pdf"), d.join("2.pdf"), d.join("3.pdf"));
        one_page(&a, "first");
        one_page(&b, "second");
        one_page(&c, "third");
        let report = run("pdf.merge", &[a, b, c]).unwrap();
        let merged = Document::load(&report.outputs[0]).unwrap();
        let texts: Vec<String> = merged.get_pages().keys().map(|n| merged.extract_text(&[*n]).unwrap().trim().to_string()).collect();
        assert_eq!(texts, ["first", "second", "third"]);
        for id in merged.get_pages().values() {
            let page = merged.get_dictionary(*id).unwrap();
            assert!(page.has(b"MediaBox") && page.has(b"Resources"), "inherited attributes kept");
        }
        fs::remove_dir_all(d).unwrap();
    }
}
