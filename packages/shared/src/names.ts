/** In-game call signs: 14 characters, no markup. Used by the API (accounts) and meta (guests). */
export function cleanName(raw: string): string {
  return raw.replace(/[<>"'`\\\u0000-\u001f]/g, '').trim().slice(0, 14) || 'оператор';
}
