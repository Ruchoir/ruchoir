/**
 * What kind of file a name is, for its icon.
 *
 * Read from the extension first, because that is what the person who named the file meant and what
 * every file manager goes by; the MIME type only settles a name without one. Families are grouped by
 * what a reader does with the file (read it, compute in it, watch it, unpack it), and each carries the
 * colour people already associate with it where there is one: red for PDF, blue for a text document,
 * green for a spreadsheet, orange for slides.
 */

export type FileFamily =
  | "pdf"
  | "document"
  | "spreadsheet"
  | "presentation"
  | "image"
  | "vector"
  | "video"
  | "audio"
  | "archive"
  | "code"
  | "config"
  | "text"
  | "data"
  | "design"
  | "font"
  | "ebook"
  | "model"
  | "application"
  | "mail"
  | "calendar"
  | "security"
  | "map"
  | "subtitles"
  | "other";

/** Colour of each family. Written out: the icon must read the same in every theme it is drawn on. */
export const FAMILY_COLOR: Record<FileFamily, string> = {
  pdf: "#d24a3d",
  document: "#2f6fd1",
  spreadsheet: "#1e8e5a",
  presentation: "#e0782e",
  image: "#8a5cd1",
  vector: "#9b57c9",
  video: "#c8467f",
  audio: "#1597a6",
  archive: "#b7862a",
  code: "#2b6c77",
  config: "#5a6b78",
  text: "#7f7a74",
  data: "#4f5bd5",
  design: "#b14fc4",
  font: "#8c6a4f",
  ebook: "#9e3b35",
  model: "#4c7a99",
  application: "#55555c",
  mail: "#2e8b7a",
  calendar: "#d0583f",
  security: "#6b5e8c",
  map: "#4d8a3a",
  subtitles: "#6c7a3a",
  other: "#8f8a83",
};

const EXTENSIONS: Record<FileFamily, string[]> = {
  pdf: ["pdf"],
  document: ["doc", "docx", "docm", "dot", "dotx", "odt", "ott", "rtf", "pages", "wpd", "wps", "hwp", "gdoc", "fodt"],
  spreadsheet: ["xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "ods", "ots", "csv", "tsv", "numbers", "gsheet", "fods"],
  presentation: ["ppt", "pptx", "pptm", "pps", "ppsx", "pot", "potx", "odp", "otp", "key", "gslides", "fodp"],
  image: ["png", "jpg", "jpeg", "jfif", "gif", "webp", "avif", "heic", "heif", "bmp", "tif", "tiff", "ico", "icns", "jxl", "raw", "cr2", "cr3", "nef", "arw", "dng", "orf", "rw2", "tga", "exr", "hdr", "qoi"],
  vector: ["svg", "svgz", "eps", "emf", "wmf", "cdr"],
  video: ["mp4", "m4v", "mov", "mkv", "webm", "avi", "wmv", "flv", "mpg", "mpeg", "3gp", "ogv", "m2ts", "vob", "prproj", "veg"],
  audio: ["mp3", "wav", "flac", "ogg", "oga", "opus", "m4a", "aac", "wma", "aiff", "aif", "alac", "mid", "midi", "amr", "weba", "caf"],
  archive: ["zip", "rar", "7z", "tar", "gz", "tgz", "bz2", "tbz2", "xz", "txz", "zst", "lz", "lzma", "cab", "arj", "z", "sit", "sitx", "cpio", "war", "jar", "whl"],
  code: [
    "js", "mjs", "cjs", "jsx", "ts", "tsx", "mts", "cts", "py", "pyw", "ipynb", "rs", "go", "java", "kt", "kts", "scala", "groovy",
    "c", "h", "cpp", "cc", "cxx", "hpp", "hh", "cs", "fs", "vb", "rb", "php", "swift", "m", "mm", "dart", "lua", "r", "jl",
    "pl", "pm", "ex", "exs", "erl", "hs", "clj", "elm", "zig", "nim", "v", "sol", "asm", "s", "wasm", "sh", "bash", "zsh",
    "fish", "ps1", "bat", "cmd", "html", "htm", "xhtml", "css", "scss", "sass", "less", "styl", "vue", "svelte", "astro",
    "json", "jsonc", "json5", "xml", "xsl", "xslt", "graphql", "gql", "proto", "tf", "hcl", "nix", "dockerfile",
    "makefile", "cmake", "gradle",
  ],
  config: ["yaml", "yml", "toml", "ini", "cfg", "conf", "config", "env", "properties", "plist", "reg", "desktop", "service", "lock", "editorconfig", "gitignore"],
  text: ["txt", "text", "md", "markdown", "mdx", "rst", "adoc", "asciidoc", "org", "tex", "bib", "log", "nfo"],
  data: ["sql", "db", "sqlite", "sqlite3", "mdb", "accdb", "parquet", "avro", "orc", "feather", "arrow", "ndjson", "jsonl", "dbf", "sav", "dta", "sas7bdat", "h5", "hdf5", "npy", "npz", "pkl", "rds"],
  design: ["psd", "psb", "ai", "fig", "sketch", "xd", "indd", "idml", "afdesign", "afphoto", "afpub", "procreate", "kra", "xcf"],
  font: ["ttf", "otf", "woff", "woff2", "eot", "fon", "pfb", "pfm"],
  ebook: ["epub", "mobi", "azw", "azw3", "fb2", "djvu", "cbz", "cbr", "ibooks"],
  model: ["stl", "obj", "fbx", "glb", "gltf", "3ds", "dae", "ply", "blend", "usd", "usdz", "3mf", "step", "stp", "iges", "igs", "dwg", "dxf", "skp", "f3d", "ifc", "sldprt", "sldasm"],
  application: ["exe", "msi", "msix", "appx", "dmg", "pkg", "app", "apk", "aab", "ipa", "deb", "rpm", "snap", "flatpak", "appimage", "iso", "img", "bin", "run", "dll", "so", "dylib", "vhd", "vhdx", "vmdk", "qcow2", "ova", "crx", "xpi"],
  mail: ["eml", "msg", "mbox", "emlx", "oft", "pst"],
  calendar: ["ics", "ical", "ifb", "vcs", "vcf", "vcard"],
  security: ["pem", "crt", "cer", "der", "pub", "p12", "pfx", "p7b", "csr", "jks", "keystore", "gpg", "pgp", "asc", "sig", "kdbx", "ovpn"],
  map: ["gpx", "kml", "kmz", "geojson", "topojson", "shp", "shx", "gpkg", "osm", "pbf", "mbtiles"],
  subtitles: ["srt", "vtt", "ass", "ssa", "sub", "sbv", "lrc"],
  other: [],
};

const BY_EXTENSION: Record<string, FileFamily> = Object.fromEntries(
  (Object.entries(EXTENSIONS) as [FileFamily, string[]][]).flatMap(([family, exts]) =>
    exts.map((ext) => [ext, family] as const),
  ),
);

/** Names that are a whole file type on their own, with no extension to go by. */
const BY_NAME: Record<string, FileFamily> = {
  dockerfile: "code",
  makefile: "code",
  gemfile: "code",
  rakefile: "code",
  procfile: "config",
  readme: "text",
  license: "text",
  changelog: "text",
};

/** The extension of a file name, lowercased, without the dot; empty when it has none. */
export function fileExtension(name: string): string {
  const base = name.trim().split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  // A leading dot is a hidden file's name (".env"), not an extension on an empty name.
  if (dot === -1) return "";
  return base.slice(dot + 1).toLowerCase();
}

/** The family a MIME type names, for a file whose name does not say. */
function familyFromMime(mime: string): FileFamily {
  const type = mime.toLowerCase();
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("image/svg")) return "vector";
  if (type.startsWith("image/")) return "image";
  if (type.startsWith("video/")) return "video";
  if (type.startsWith("audio/")) return "audio";
  if (type.startsWith("font/")) return "font";
  if (type.includes("spreadsheet") || type.includes("excel") || type === "text/csv") return "spreadsheet";
  if (type.includes("presentation") || type.includes("powerpoint")) return "presentation";
  if (type.includes("wordprocessing") || type.includes("msword") || type.includes("opendocument.text")) return "document";
  if (type.includes("zip") || type.includes("compressed") || type.includes("tar") || type.includes("gzip")) return "archive";
  if (type.includes("json") || type.includes("javascript") || type.includes("xml")) return "code";
  if (type.startsWith("text/")) return "text";
  return "other";
}

/** The family of a file, from its name, then its MIME type. */
export function fileFamily(name: string, mime?: string): FileFamily {
  const ext = fileExtension(name);
  if (ext && BY_EXTENSION[ext]) return BY_EXTENSION[ext];
  const bare = (name.trim().split(/[\\/]/).pop() ?? "").toLowerCase().replace(/^\./, "");
  if (BY_NAME[bare]) return BY_NAME[bare];
  if (!ext && bare && BY_EXTENSION[bare]) return BY_EXTENSION[bare];
  return mime ? familyFromMime(mime) : "other";
}
