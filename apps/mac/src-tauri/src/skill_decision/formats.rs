//! Merge short file conversion specifications whose entire contents describe
//! independent input, output and display-name fields. Every supported field
//! stands on its own: references to other fields and arbitrary prose are opaque.
use std::collections::BTreeSet;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
enum Field {
    Input,
    Output,
    Title,
}

const FORMATS: &[&str] = &[
    "CSV", "TSV", "JSON", "JSONL", "YAML", "TOML", "XML", "HTML", "Markdown",
];
const ENCODINGS: &[&str] = &["UTF-8", "UTF-16", "ASCII"];

/// A quoted single display word can be renamed independently of the I/O
/// settings. Keep names that can describe a format, such as "Jsonify", in
/// review alongside acronyms and titles that contain instructions.
fn display_name(value: &str) -> bool {
    if value.is_empty()
        || value.len() > 64
        || !value.chars().all(char::is_alphabetic)
        || value.chars().all(char::is_uppercase)
    {
        return false;
    }
    let upper = value.to_ascii_uppercase();
    !FORMATS.iter().chain(ENCODINGS).any(|term| {
        let stem = term.split('-').next().unwrap_or(term);
        upper.contains(&stem.to_ascii_uppercase())
    })
}

fn field(line: &str) -> Option<Field> {
    if let Some(value) = line.strip_prefix("Input format: ") {
        return FORMATS.contains(&value).then_some(Field::Input);
    }
    if let Some(value) = line.strip_prefix("Output format: ") {
        return FORMATS.contains(&value).then_some(Field::Output);
    }
    let title = line.strip_prefix("title = \"")?.strip_suffix('"')?;
    display_name(title).then_some(Field::Title)
}

fn instruction(line: &str) -> Option<Field> {
    let words: Vec<_> = line.strip_suffix('.')?.split(' ').collect();
    match words.as_slice() {
        ["Read", "a" | "one", "file"] => Some(Field::Input),
        ["Read", "a" | "an" | "one", encoding, "file"] if ENCODINGS.contains(encoding) => {
            Some(Field::Input)
        }
        ["Write", "a" | "the", "report"] => Some(Field::Output),
        ["Write", "a" | "the", value, "report"] | ["Return" | "Write", value]
            if FORMATS.contains(value) =>
        {
            Some(Field::Output)
        }
        _ => None,
    }
}

fn split_line(line: &str) -> (&str, &str) {
    if let Some(body) = line.strip_suffix("\r\n") {
        (body, "\r\n")
    } else if let Some(body) = line.strip_suffix('\n') {
        (body, "\n")
    } else {
        (line, "")
    }
}

struct Line<'a> {
    field: Option<Field>,
    bytes: &'a str,
    ending: &'a str,
}

fn parse(text: &str) -> Option<Vec<Line<'_>>> {
    if text.len() > 4096 {
        return None;
    }
    let mut seen = BTreeSet::new();
    let mut scope = None;
    let mut lines = Vec::new();
    for raw in text.split_inclusive('\n') {
        let (body, ending) = split_line(raw);
        let slot = match body {
            "" => None,
            "# Parser" | "# Converter" | "# Formatter" if lines.is_empty() => None,
            "# Input" | "## Input" => {
                scope = Some(Field::Input);
                None
            }
            "# Output" | "## Output" => {
                scope = Some(Field::Output);
                None
            }
            _ => {
                let slot = field(body).or_else(|| instruction(body))?;
                if scope.is_some_and(|expected| expected != slot) || !seen.insert(slot) {
                    return None;
                }
                Some(slot)
            }
        };
        lines.push(Line {
            field: slot,
            bytes: raw,
            ending,
        });
    }
    (seen.len() >= 2).then_some(lines)
}

pub(super) fn merge(base: &str, versions: &[String]) -> Option<String> {
    let original = parse(base)?;
    let mut merged: Vec<_> = original.iter().map(|line| line.bytes).collect();
    for version in versions {
        let lines = parse(version)?;
        if lines.len() != original.len() {
            return None;
        }
        for ((old, new), result) in original.iter().zip(lines).zip(&mut merged) {
            if new.bytes == old.bytes {
                continue;
            }
            if old.field.is_none()
                || old.field != new.field
                || old.ending != new.ending
                || (*result != old.bytes && *result != new.bytes)
            {
                return None;
            }
            *result = new.bytes;
        }
    }
    Some(merged.concat())
}

#[cfg(test)]
mod tests {
    use super::merge;

    fn reconcile(base: &str, shared: &str, local: &str) -> Option<String> {
        merge(base, &[shared.into(), base.into(), local.into()])
    }

    #[test]
    fn skill_decision_format_fields_preserve_bytes_and_editor_order() {
        for (base, a, b, expected) in [
            (
                "Output format: XML\r\nInput format: CSV\r\n",
                "Output format: XML\r\nInput format: TSV\r\n",
                "Output format: TOML\r\nInput format: CSV\r\n",
                "Output format: TOML\r\nInput format: TSV\r\n",
            ),
            (
                "# Converter\nRead one ASCII file.\n\n## Output\nWrite a YAML report.",
                "# Converter\nRead one UTF-16 file.\n\n## Output\nWrite a YAML report.",
                "# Converter\nRead one ASCII file.\n\n## Output\nWrite a TSV report.",
                "# Converter\nRead one UTF-16 file.\n\n## Output\nWrite a TSV report.",
            ),
            (
                "title = \"Export\"\n\n# Output\nReturn HTML.",
                "title = \"Résumé\"\n\n# Output\nReturn HTML.",
                "title = \"Export\"\n\n# Output\nReturn XML.",
                "title = \"Résumé\"\n\n# Output\nReturn XML.",
            ),
        ] {
            assert_eq!(reconcile(base, a, b).as_deref(), Some(expected));
            assert_eq!(reconcile(base, b, a).as_deref(), Some(expected));
        }
    }

    #[test]
    fn skill_decision_format_fields_hold_unproved_and_contradictory_changes() {
        for (base, a, b) in [
            ("Input format: CSV\nOutput format: XML", "Input format: CSV\nOutput format: YAML", "Input format: CSV\nOutput format: TOML"),
            ("Read one file.\nReturn XML.", "Read one ASCII file.\nReturn XML.", "Read one file.\nReturn the input format."),
            ("Read one file.\nReturn XML.", "Read one ASCII file.\nReturn XML.", "Read one file.\nReturn XML.\nValidate JSON."),
            ("title = \"Export\"\nReturn XML.", "title = \"JSON only\"\nReturn XML.", "title = \"Export\"\nReturn CSV."),
            ("title = \"Export\"\nReturn XML.", "title = \"Jsonify\"\nReturn XML.", "title = \"Export\"\nReturn CSV."),
            ("title = \"Export\"\nReturn XML.", "title = \"PDF\"\nReturn XML.", "title = \"Export\"\nReturn CSV."),
            ("Read one file.\nReturn XML.", "Read one ASCII file.\r\nReturn XML.", "Read one file.\nReturn JSON."),
            ("# Output\nRead one file.\nReturn XML.", "# Output\nRead one ASCII file.\nReturn XML.", "# Output\nRead one file.\nReturn CSV."),
            ("Read one file.\nReturn XML.\nOutput format: XML", "Read one ASCII file.\nReturn XML.\nOutput format: XML", "Read one file.\nReturn YAML.\nOutput format: XML"),
            ("## Receive\nCollect input.\n## Archive\nRemove copies.", "## Receive\nReceive material that must never be stored.\n## Archive\nRemove copies.", "## Receive\nCollect input.\n## Archive\nKeep a permanent copy."),
            ("## Output\nProduce a report.\n## Check\nRead the results.", "## Output\nSerialize a YAML report.\n## Check\nRead the results.", "## Output\nProduce a report.\n## Check\nFail unless it parses as XML."),
            ("## Generate\nCreate a report.\n## Deliver\nSend the report.", "## Generate\nCreate new.txt.\n## Deliver\nSend the report.", "## Generate\nCreate a report.\n## Deliver\nSend old.txt exclusively."),
            ("Objet.\r\n\r\nArchive.\r\n", "Objet confidentiel.\r\n\r\nArchive.\r\n", "Objet.\r\n\r\nArchivage obligatoire.\r\n"),
            ("Entrada.\n\nSalida.", "Entrada privada.\n\nSalida.", "Entrada.\n\nPublicación obligatoria."),
        ] {
            assert!(reconcile(base, a, b).is_none(), "{a:?} and {b:?}");
        }
    }
}
