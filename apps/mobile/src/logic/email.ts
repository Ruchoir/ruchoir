/** An e-mail address as the forms accept it: something, `@`, a domain with a dot, no spaces. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmail(address: string): boolean {
  return EMAIL.test(address.trim());
}

/** The list with `address` added, trimmed, unless it is already there (case aside). */
export function addAddress(list: string[], address: string): string[] {
  const clean = address.trim();
  return list.some((a) => a.toLowerCase() === clean.toLowerCase()) ? list : [...list, clean];
}
