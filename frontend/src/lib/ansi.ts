/**
 * Terminal color codes in log output, as styled segments.
 *
 * Only SGR (`ESC[...m`): the 16 basic colors, bold and dim. Every other escape
 * is dropped. Colors are theme classes rather than the raw terminal palette so
 * they stay readable on both the light and the dark background.
 */

const ESCAPE = /\x1b\[([0-9;?]*)([A-Za-z])/g;

const FG: Record<number, string> = {
  30: 'text-muted-foreground',
  31: 'text-red-600 dark:text-red-400',
  32: 'text-green-600 dark:text-green-400',
  33: 'text-amber-600 dark:text-amber-400',
  34: 'text-blue-600 dark:text-blue-400',
  35: 'text-fuchsia-600 dark:text-fuchsia-400',
  36: 'text-cyan-600 dark:text-cyan-400',
  37: '',
};

export type AnsiSegment = { text: string; className: string };

export const stripAnsi = (text: string) => text.replace(ESCAPE, '');

export function parseAnsi(text: string): AnsiSegment[] {
  const segments: AnsiSegment[] = [];
  let fg = '';
  let bold = false;
  let dim = false;
  let last = 0;

  const push = (chunk: string) => {
    if (!chunk) return;
    const className = [fg, bold && 'font-bold', dim && 'opacity-70'].filter(Boolean).join(' ');
    const prev = segments[segments.length - 1];
    if (prev && prev.className === className) prev.text += chunk;
    else segments.push({ text: chunk, className });
  };

  for (const match of text.matchAll(ESCAPE)) {
    push(text.slice(last, match.index));
    last = match.index! + match[0].length;
    if (match[2] !== 'm') continue;

    const codes = (match[1] || '0').split(';').map(Number);
    for (let i = 0; i < codes.length; i++) {
      const code = codes[i]!;
      if (code === 0) [fg, bold, dim] = ['', false, false];
      else if (code === 1) bold = true;
      else if (code === 2) dim = true;
      else if (code === 22) [bold, dim] = [false, false];
      else if (code === 39) fg = '';
      else if (code >= 30 && code <= 37) fg = FG[code]!;
      else if (code >= 90 && code <= 97) fg = code === 90 ? FG[30]! : FG[code - 60]!;
      // ponytail: 256/truecolor (38;5;n / 38;2;r;g;b) is skipped, not drawn
      else if (code === 38 || code === 48) i += codes[i + 1] === 5 ? 2 : 4;
    }
  }
  push(text.slice(last));
  return segments;
}
