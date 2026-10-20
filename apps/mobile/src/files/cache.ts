/**
 * The one place downloaded files are kept: a folder of the app's cache, one sub-folder per instance,
 * emptied when the phone signs out of that instance so the next person on the phone finds nothing of
 * the last one's documents there.
 */
import { Directory, Paths } from "expo-file-system";

/** An instance's folder name: its host, made safe for a file system. */
const folderOf = (origin: string) => origin.replace(/^https?:\/\//, "").replace(/[^\w.-]/g, "_") || "instance";

export function downloadsDirectory(origin: string): Directory {
  const dir = new Directory(Paths.cache, "ruchoir-files", folderOf(origin));
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

/**
 * Empty an instance's downloads, or every instance's without one. Never throws: it runs as a session
 * ends (a 401, a sign-out), which a file system that refuses must not turn into another failure.
 */
export function clearDownloads(origin?: string): void {
  try {
    const dir = origin ? new Directory(Paths.cache, "ruchoir-files", folderOf(origin)) : new Directory(Paths.cache, "ruchoir-files");
    if (dir.exists) dir.delete();
  } catch {
    // Left for the next sign-out: the cache holds nothing the instance would not hand out again.
  }
}
