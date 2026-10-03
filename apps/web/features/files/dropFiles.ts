/**
 * What was dropped from the desktop, or picked with "Upload a folder", as files with their path
 * inside what was chosen ("Photos/2026/a.jpg"), plus the folders that came with nothing in them.
 */

/** A file to send, and where it sits inside what was dropped (its own name for a loose file). */
export type Incoming = { file: File; path: string };

export type Dropped = { files: Incoming[]; emptyDirs: string[] };

/** Whether a drag carries files from the desktop (an upload), as opposed to entries moved inside the list. */
export function carriesFiles(dt: DataTransfer | null): boolean {
  return !!dt && Array.from(dt.types).includes("Files");
}

/** Files picked through an input, a folder input giving each its path inside the folder. */
export function fromInput(list: FileList | null): Incoming[] {
  return Array.from(list ?? []).map((file) => ({ file, path: file.webkitRelativePath || file.name }));
}

/**
 * Read a drop, folders included, walked to the bottom.
 *
 * The entries are taken from the event at once: a `DataTransfer` is emptied as soon as the drop
 * handler returns, and the walk that follows is asynchronous.
 */
export function readDrop(dt: DataTransfer): Promise<Dropped> {
  const roots: FileSystemEntry[] = [];
  const loose: File[] = [];
  for (const item of Array.from(dt.items)) {
    if (item.kind !== "file") continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
    else {
      const file = item.getAsFile();
      if (file) loose.push(file);
    }
  }
  return (async () => {
    const out: Dropped = { files: loose.map((file) => ({ file, path: file.name })), emptyDirs: [] };
    for (const root of roots) await walk(root, "", out);
    return out;
  })();
}

async function walk(entry: FileSystemEntry, prefix: string, out: Dropped): Promise<void> {
  const path = prefix ? `${prefix}/${entry.name}` : entry.name;
  if (entry.isFile) {
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
    out.files.push({ file, path });
    return;
  }
  if (!entry.isDirectory) return;
  const children = await readAll((entry as FileSystemDirectoryEntry).createReader());
  if (children.length === 0) out.emptyDirs.push(path);
  for (const child of children) await walk(child, path, out);
}

/** A directory reader hands its entries over in batches (100 at a time in Chrome): read until empty. */
async function readAll(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const all: FileSystemEntry[] = [];
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (batch.length === 0) return all;
    all.push(...batch);
  }
}
