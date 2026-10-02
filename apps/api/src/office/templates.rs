//! Blank documents, embedded in the API.
//!
//! Euro-Office's own empty templates (AGPL, copied from the engine image), in Ruchoir's six
//! languages, with European paper sizes (`en` uses the British template for A4).

use serde::Deserialize;
use utoipa::ToSchema;

/// What kind of blank document.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    Document,
    Spreadsheet,
    Presentation,
}

impl Kind {
    pub fn extension(self) -> &'static str {
        match self {
            Kind::Document => "docx",
            Kind::Spreadsheet => "xlsx",
            Kind::Presentation => "pptx",
        }
    }
}

macro_rules! blank {
    ($locale:literal) => {
        [
            include_bytes!(concat!("../../assets/office/", $locale, "/new.docx")).as_slice(),
            include_bytes!(concat!("../../assets/office/", $locale, "/new.xlsx")).as_slice(),
            include_bytes!(concat!("../../assets/office/", $locale, "/new.pptx")).as_slice(),
        ]
    };
}

const FR: [&[u8]; 3] = blank!("fr");
const EN: [&[u8]; 3] = blank!("en");
const ES: [&[u8]; 3] = blank!("es");
const DE: [&[u8]; 3] = blank!("de");
const IT: [&[u8]; 3] = blank!("it");
const PL: [&[u8]; 3] = blank!("pl");

/// The empty file for `kind` in `locale` (one of Ruchoir's six; French otherwise).
pub fn blank(kind: Kind, locale: Option<&str>) -> &'static [u8] {
    let set = match locale {
        Some("en") => EN,
        Some("es") => ES,
        Some("de") => DE,
        Some("it") => IT,
        Some("pl") => PL,
        _ => FR,
    };
    set[kind as usize]
}
