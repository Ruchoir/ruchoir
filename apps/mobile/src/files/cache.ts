/**
 * The one place downloaded files are kept: a folder of the app's cache, emptied at sign-out so the
 * next person on the phone finds nothing of the last one's documents.
 */
import { Directory, Paths } from "expo-file-system";

export function downloadsDirectory(): Directory {
  const dir = new Directory(Paths.cache, "ruchoir-files");
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export function clearDownloads(): void {
  const dir = new Directory(Paths.cache, "ruchoir-files");
  if (dir.exists) dir.delete();
}
