use std::{
    fs,
    io::{Cursor, Read},
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    process::Command,
};

use quick_xml::{events::Event, Reader};
use serde::Deserialize;
use zip::ZipArchive;

use crate::{
    models::ProviderSettings, observability::ModelCallRecorder, providers::BailianClient,
    storage::ExtractedSection,
};

pub async fn extract_sections(
    path: &str,
    settings: &ProviderSettings,
    observability: Option<ModelCallRecorder>,
) -> Result<Vec<ExtractedSection>, String> {
    let source = Path::new(path);
    let extension = source
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let bytes = fs::read(source).map_err(|error| format!("无法读取资料：{error}"))?;
    match extension.as_str() {
        "txt" | "md" => Ok(vec![ExtractedSection {
            locator: "全文".to_owned(),
            content: String::from_utf8_lossy(&bytes).to_string(),
        }]),
        "pdf" => extract_pdf(source, &bytes),
        "docx" => extract_docx(&bytes),
        "pptx" => extract_pptx(&bytes),
        "xlsx" => extract_xlsx(&bytes),
        "png" => ocr_single_image("image/png", &bytes, settings, observability).await,
        "jpg" | "jpeg" => ocr_single_image("image/jpeg", &bytes, settings, observability).await,
        _ => Err("当前版本不支持该文件类型。".to_owned()),
    }
}

#[derive(Deserialize)]
struct PdfKitPage {
    page: u32,
    text: String,
}

fn extract_pdf(source: &Path, bytes: &[u8]) -> Result<Vec<ExtractedSection>, String> {
    // Some PDFs embed non-standard CMap/font metadata that can panic pdf-extract.
    // A panic must never strand a document in "indexing"; PDFKit is the native
    // macOS fallback and keeps text extraction entirely on the device.
    let extracted = catch_unwind(AssertUnwindSafe(|| {
        pdf_extract::extract_text_from_mem(bytes)
    }));
    match extracted {
        Ok(Ok(content)) if !content.trim().is_empty() => Ok(vec![ExtractedSection {
            locator: "PDF 文本层".to_owned(),
            content,
        }]),
        Ok(Ok(_)) | Ok(Err(_)) | Err(_) => extract_pdf_with_pdfkit(source),
    }
}

fn extract_pdf_with_pdfkit(source: &Path) -> Result<Vec<ExtractedSection>, String> {
    let helper = pdfkit_helper_path()?;
    let output = Command::new(helper)
        .arg(source)
        .output()
        .map_err(|error| format!("无法启动本机 PDFKit 解析器：{error}"))?;
    if !output.status.success() {
        let details = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        return Err(if details.is_empty() {
            "macOS PDFKit 无法打开此 PDF。该文件可能受密码保护或已损坏。".to_owned()
        } else {
            format!("macOS PDFKit 无法提取该 PDF：{details}")
        });
    }
    let pages = serde_json::from_slice::<Vec<PdfKitPage>>(&output.stdout)
        .map_err(|error| format!("本机 PDFKit 解析器返回无效结果：{error}"))?;
    let sections = pages
        .into_iter()
        .filter_map(|page| {
            let content = page.text.trim().to_owned();
            (!content.is_empty()).then(|| ExtractedSection {
                locator: format!("第 {} 页", page.page),
                content,
            })
        })
        .collect::<Vec<_>>();
    if sections.is_empty() {
        Err(
            "该 PDF 未检测到可提取文本，可能是扫描件或受密码保护。请转为图片后导入并使用 OCR。"
                .to_owned(),
        )
    } else {
        Ok(sections)
    }
}

fn pdfkit_helper_path() -> Result<PathBuf, String> {
    let packaged = std::env::current_exe().ok().and_then(|executable| {
        executable
            .parent()?
            .parent()?
            .join("Resources/resources/PdfTextBridge")
            .canonicalize()
            .ok()
    });
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources/PdfTextBridge");
    packaged.into_iter()
        .chain(std::iter::once(development))
        .find(|path| path.is_file())
        .ok_or_else(|| "未找到 PdfTextBridge。请重新安装包含本机 PDF 解析器的 Meeting Copilot 0.1.3 或更高版本。".to_owned())
}

pub fn chunk_sections(sections: Vec<ExtractedSection>) -> Vec<ExtractedSection> {
    let mut output = Vec::new();
    for section in sections {
        let normalized = section
            .content
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if normalized.is_empty() {
            continue;
        }
        let chars = normalized.chars().collect::<Vec<_>>();
        let mut start = 0;
        let mut part = 1;
        while start < chars.len() {
            let end = (start + 900).min(chars.len());
            let content = chars[start..end].iter().collect::<String>();
            output.push(ExtractedSection {
                locator: if chars.len() <= 900 {
                    section.locator.clone()
                } else {
                    format!("{} · 片段 {}", section.locator, part)
                },
                content,
            });
            if end == chars.len() {
                break;
            }
            start = end.saturating_sub(140);
            part += 1;
        }
    }
    output
}

async fn ocr_single_image(
    mime: &str,
    bytes: &[u8],
    settings: &ProviderSettings,
    observability: Option<ModelCallRecorder>,
) -> Result<Vec<ExtractedSection>, String> {
    let client = match observability {
        Some(recorder) => BailianClient::with_observability(settings.clone(), recorder)?,
        None => BailianClient::new(settings.clone())?,
    };
    let content = client.ocr_image(mime, bytes).await?;
    Ok(vec![ExtractedSection {
        locator: "OCR 图片页".to_owned(),
        content,
    }])
}

fn extract_docx(bytes: &[u8]) -> Result<Vec<ExtractedSection>, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("DOCX 解压失败：{error}"))?;
    let xml = read_zip_file(&mut archive, "word/document.xml")?;
    Ok(vec![ExtractedSection {
        locator: "正文".to_owned(),
        content: xml_text(&xml),
    }])
}

fn extract_pptx(bytes: &[u8]) -> Result<Vec<ExtractedSection>, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("PPTX 解压失败：{error}"))?;
    let mut names = archive
        .file_names()
        .filter(|name| name.starts_with("ppt/slides/slide") && name.ends_with(".xml"))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    names.sort_by_key(|name| slide_number(name));
    let mut sections = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let xml = read_zip_file(&mut archive, name)?;
        let content = xml_text(&xml);
        if !content.trim().is_empty() {
            sections.push(ExtractedSection {
                locator: format!("第 {} 页幻灯片", index + 1),
                content,
            });
        }
    }
    if sections.is_empty() {
        Err("PPTX 中没有检测到可索引文字。".to_owned())
    } else {
        Ok(sections)
    }
}

fn extract_xlsx(bytes: &[u8]) -> Result<Vec<ExtractedSection>, String> {
    let mut archive =
        ZipArchive::new(Cursor::new(bytes)).map_err(|error| format!("XLSX 解压失败：{error}"))?;
    let shared_strings = read_zip_file(&mut archive, "xl/sharedStrings.xml")
        .map(|xml| xml_text(&xml))
        .unwrap_or_default();
    let mut names = archive
        .file_names()
        .filter(|name| name.starts_with("xl/worksheets/sheet") && name.ends_with(".xml"))
        .map(ToOwned::to_owned)
        .collect::<Vec<_>>();
    names.sort();
    let mut sections = Vec::new();
    for (index, name) in names.iter().enumerate() {
        let xml = read_zip_file(&mut archive, name)?;
        let mut content = xml_text(&xml);
        if !shared_strings.is_empty() {
            content = format!("{} {}", shared_strings, content);
        }
        if !content.trim().is_empty() {
            sections.push(ExtractedSection {
                locator: format!("工作表 {}", index + 1),
                content,
            });
        }
    }
    if sections.is_empty() {
        Err("XLSX 中没有检测到可索引文字。".to_owned())
    } else {
        Ok(sections)
    }
}

fn read_zip_file(archive: &mut ZipArchive<Cursor<&[u8]>>, name: &str) -> Result<Vec<u8>, String> {
    let mut file = archive
        .by_name(name)
        .map_err(|error| format!("Office 文件缺少 {name}：{error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("无法读取 Office 内容：{error}"))?;
    Ok(bytes)
}

fn xml_text(bytes: &[u8]) -> String {
    let mut reader = Reader::from_reader(bytes);
    reader.config_mut().trim_text(true);
    let mut buffer = Vec::new();
    let mut output = String::new();
    loop {
        match reader.read_event_into(&mut buffer) {
            Ok(Event::Text(text)) => {
                output.push_str(&String::from_utf8_lossy(text.as_ref()));
                output.push(' ');
            }
            Ok(Event::CData(text)) => {
                output.push_str(&String::from_utf8_lossy(text.as_ref()));
                output.push(' ');
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buffer.clear();
    }
    output
}

fn slide_number(name: &str) -> u32 {
    name.rsplit('/')
        .next()
        .and_then(|value| value.strip_prefix("slide"))
        .and_then(|value| value.strip_suffix(".xml"))
        .and_then(|value| value.parse().ok())
        .unwrap_or(u32::MAX)
}
