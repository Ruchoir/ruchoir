//! Name normalisation for spaces and channels.
//!
//! Channel names and space slugs are handles, not free text: they appear in URLs, in `#mentions`
//! and in the sidebar, and they carry a uniqueness constraint (channel names per space, space slugs
//! globally). Normalising them here keeps one definition of "the same name", so `#Compta 2026`,
//! `#compta-2026` and `#COMPTA_2026` cannot coexist as three channels in one space.
//!
//! Latin letters with a diacritic fold to their base letter, which matches how people type a
//! handle for an accented word (`comptabilité` -> `comptabilite`).

/// Longest handle we accept, in characters. Long enough for a descriptive name, short enough to
/// stay readable in the sidebar and in a mention.
pub const MAX_HANDLE_LEN: usize = 64;

/// Normalise a display name into a handle: lowercase, diacritics folded, anything else collapsed
/// into single dashes, trimmed of leading and trailing dashes, and capped at [`MAX_HANDLE_LEN`].
/// Returns an empty string when nothing usable is left, which callers reject.
pub fn slugify(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut pending_dash = false;
    for ch in input.trim().chars().flat_map(fold_char) {
        if ch.is_ascii_alphanumeric() {
            if pending_dash && !out.is_empty() {
                out.push('-');
            }
            pending_dash = false;
            out.push(ch.to_ascii_lowercase());
            if out.chars().count() >= MAX_HANDLE_LEN {
                break;
            }
        } else {
            // Any run of separators or unsupported characters becomes a single dash, and only if
            // something follows it, so the result never ends on a dash.
            pending_dash = true;
        }
    }
    out
}

/// Fold one character to its ASCII base letter(s). Lowercasing runs first, and over the full
/// Unicode mapping rather than the ASCII one, so an accented capital (`Â`) folds like its lowercase
/// form. Unknown characters pass through unchanged and are dropped by [`slugify`] unless they are
/// already alphanumeric.
fn fold_char(ch: char) -> std::vec::IntoIter<char> {
    let lower = ch.to_lowercase().next().unwrap_or(ch);
    let folded: Vec<char> = match lower {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => vec!['a'],
        'æ' => vec!['a', 'e'],
        'ç' => vec!['c'],
        'è' | 'é' | 'ê' | 'ë' => vec!['e'],
        'ì' | 'í' | 'î' | 'ï' => vec!['i'],
        'ñ' => vec!['n'],
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' => vec!['o'],
        'œ' => vec!['o', 'e'],
        'ù' | 'ú' | 'û' | 'ü' => vec!['u'],
        'ý' | 'ÿ' => vec!['y'],
        other => vec![other],
    };
    folded.into_iter()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folds_accents_and_separators() {
        assert_eq!(slugify("Comptabilité 2026"), "comptabilite-2026");
        assert_eq!(slugify("  Atelier   Bois  "), "atelier-bois");
        assert_eq!(slugify("#général"), "general");
        assert_eq!(slugify("Cœur & Âme"), "coeur-ame");
    }

    #[test]
    fn an_already_normalised_handle_is_unchanged() {
        assert_eq!(slugify("veille-marche"), "veille-marche");
    }

    #[test]
    fn a_name_with_nothing_usable_normalises_to_empty() {
        assert_eq!(slugify("   "), "");
        assert_eq!(slugify("///"), "");
    }

    #[test]
    fn a_long_name_is_capped() {
        let slug = slugify(&"a".repeat(MAX_HANDLE_LEN + 20));
        assert_eq!(slug.chars().count(), MAX_HANDLE_LEN);
    }
}
