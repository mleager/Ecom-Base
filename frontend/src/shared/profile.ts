export function normalizeProfileName(value: string): string | null {
  if (value.includes('\0') || Array.from(value).some((character) => {
    const point = character.codePointAt(0)!;
    return point >= 0xd800 && point <= 0xdfff;
  })) return null;

  // Match Go strings.TrimSpace, including U+0085 and excluding BOM.
  const name = value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '');
  const length = Array.from(name).length;
  return length >= 1 && length <= 200 ? name : null;
}
