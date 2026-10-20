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

/** Empty an instance's downloads, or every instance's without one. */
export function clearDownloads(origin?: string): void {
  const dir = origin ? new Directory(Paths.cache, "ruchoir-files", folderOf(origin)) : new Directory(Paths.cache, "ruchoir-files");
  if (dir.exists) dir.delete();
}
