//! Typesetting a printed calendar with Typst, inside the API: a template, its data, an embedded font,
//! and nothing read from the disk or the network.
//!
//! What a person typed (a title, a place) never becomes markup: the template reads it as data from a
//! JSON file (`json("data.json")`), so `#`, `*`, `[` or `$` print as themselves and cannot run.

use std::sync::LazyLock;

use typst::diag::{FileError, FileResult};
use typst::foundations::{Bytes, Datetime, Duration};
use typst::syntax::{FileId, RootedPath, Source, VirtualPath, VirtualRoot};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, LibraryExt, World};
use typst_layout::PagedDocument;

/// IBM Plex Sans (SIL Open Font License, `assets/fonts/IBMPlexSans-OFL.txt`), the interface's face,
/// complete rather than the screen's Latin subset so Polish prints too.
const FONT_FILES: [&[u8]; 2] = [
    include_bytes!("../../assets/fonts/IBMPlexSans-Regular.ttf"),
    include_bytes!("../../assets/fonts/IBMPlexSans-Bold.ttf"),
];

static LIBRARY: LazyLock<LazyHash<Library>> = LazyLock::new(|| LazyHash::new(Library::default()));

static FONTS: LazyLock<(LazyHash<FontBook>, Vec<Font>)> = LazyLock::new(|| {
    let fonts: Vec<Font> = FONT_FILES
        .iter()
        .flat_map(|data| Font::iter(Bytes::new(*data)))
        .collect();
    (LazyHash::new(FontBook::from_fonts(&fonts)), fonts)
});

fn file_id(name: &str) -> FileId {
    RootedPath::new(
        VirtualRoot::Project,
        VirtualPath::new(name).expect("a plain file name"),
    )
    .intern()
}

/// One document to typeset: the template as the main file, the data beside it.
struct PrintWorld {
    main: Source,
    data_id: FileId,
    data: Bytes,
}

impl World for PrintWorld {
    fn library(&self) -> &LazyHash<Library> {
        &LIBRARY
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &FONTS.0
    }

    fn main(&self) -> FileId {
        self.main.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.main.id() {
            Ok(self.main.clone())
        } else {
            Err(FileError::AccessDenied)
        }
    }

    fn file(&self, id: FileId) -> FileResult<Bytes> {
        if id == self.data_id {
            Ok(self.data.clone())
        } else {
            Err(FileError::AccessDenied)
        }
    }

    fn font(&self, index: usize) -> Option<Font> {
        FONTS.1.get(index).cloned()
    }

    fn today(&self, _offset: Option<Duration>) -> Option<Datetime> {
        None
    }
}

/// Lay `template` out with `data` readable as `json("data.json")`.
pub fn layout(template: &str, data: &serde_json::Value) -> Result<PagedDocument, String> {
    let world = PrintWorld {
        main: Source::new(file_id("print.typ"), template.to_owned()),
        data_id: file_id("data.json"),
        data: Bytes::new(serde_json::to_vec(data).map_err(|e| e.to_string())?),
    };
    typst::compile::<PagedDocument>(&world)
        .output
        .map_err(|errors| {
            errors
                .iter()
                .map(|e| e.message.to_string())
                .collect::<Vec<_>>()
                .join("; ")
        })
}

/// The same, as a PDF file.
pub fn pdf(template: &str, data: &serde_json::Value) -> Result<Vec<u8>, String> {
    let document = layout(template, data)?;
    typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default()).map_err(|errors| {
        errors
            .iter()
            .map(|e| e.message.to_string())
            .collect::<Vec<_>>()
            .join("; ")
    })
}

/// Every piece of text a document lays out, in order: how a test reads what was printed.
#[cfg(test)]
pub fn printed(document: &PagedDocument) -> String {
    use typst::layout::{Frame, FrameItem};
    fn walk(frame: &Frame, out: &mut String) {
        for (_, item) in frame.items() {
            match item {
                FrameItem::Group(group) => walk(&group.frame, out),
                FrameItem::Text(text) => out.push_str(&text.text),
                _ => {}
            }
        }
    }
    let mut out = String::new();
    for page in document.pages() {
        walk(&page.frame, &mut out);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const TITLE_ONLY: &str = "#let data = json(\"data.json\")\n#data.title\n";

    /// Whether every embedded face draws each letter of `text`.
    fn drawn(text: &str) -> bool {
        FONTS.1.iter().all(|font| {
            text.chars()
                .filter(|c| !c.is_whitespace())
                .all(|c| font.info().coverage.contains(c as u32))
        })
    }

    #[test]
    fn typed_signs_print_as_themselves() {
        let title = r#"#set page(width: 1pt) *gras* _x_ [y] $z$ \ "q" <l> @r // c `raw` = h"#;
        let document =
            layout(TITLE_ONLY, &serde_json::json!({ "title": title })).expect("laid out");
        let typed: String = title.split_whitespace().collect();
        assert_eq!(
            printed(&document).split_whitespace().collect::<String>(),
            typed
        );
    }

    #[test]
    fn the_font_draws_the_six_languages() {
        assert_eq!(FONTS.1.len(), 2);
        assert!(drawn(
            "Zażółć gęślą jaźń ÀÂÆÇÉÈÊËÎÏÔŒÙÛÜŸ àâæçéèêëîïôœùûüÿ «»"
        ));
        assert!(drawn(
            "ÄÖÜäöüß ÁÉÍÑÓÚÜáéíñóúü¿¡ ÀÈÉÌÒÙàèéìòù ĄĆĘŁŃÓŚŹŻąćęłńóśźż"
        ));
        // And the check can fail: no Japanese in Plex Sans.
        assert!(!drawn("日"));
    }

    #[test]
    fn a_document_becomes_a_pdf() {
        let bytes = pdf(TITLE_ONLY, &serde_json::json!({ "title": "Agenda" })).expect("pdf");
        assert!(bytes.starts_with(b"%PDF-"));
    }
}
