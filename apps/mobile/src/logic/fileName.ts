/**
 * A file of the phone's name as it is sent: the document picker can hand a name with its extension
 * twice ("Bulletin.pdf.pdf"), which then reads as "Bulletin.pdf (1).pdf" when both are kept. The same
 * extension said twice in a row is said once; any other name stays as it is.
 */
export function pickedName(name: string): string {
  const match = /^(.+)(\.[^.\s]+)(\.[^.\s]+)$/.exec(name);
  if (!match || match[2].toLowerCase() !== match[3].toLowerCase()) return name;
  return `${match[1]}${match[3]}`;
}
