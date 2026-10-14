/** Columns and budgets count UTF-16 code units; continuation never splits a surrogate pair. */
export function textPage(
  text: string,
  startLine: number,
  maxLines: number,
  startColumn: number,
  maxChars: number,
) {
  const lines = text ? text.split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  let line = startLine - 1;
  let column = startColumn - 1;
  const parts: string[] = [];
  let length = 0;
  while (line < lines.length && parts.length < maxLines) {
    const value = lines[line]!.replace(/\r$/, '');
    if (column > value.length)
      throw new Error('start_column exceeds the line length; read the line from column 1');
    if (
      column > 0 &&
      /[\uDC00-\uDFFF]/.test(value[column] ?? '') &&
      /[\uD800-\uDBFF]/.test(value[column - 1]!)
    )
      throw new Error('start_column splits a Unicode character; use the returned next_column');
    const prefix = `${line + 1}: `;
    const room = maxChars - length - prefix.length - (parts.length ? 1 : 0);
    if (room <= 0) break;
    let end = Math.min(value.length, column + room);
    if (
      end < value.length &&
      /[\uD800-\uDBFF]/.test(value[end - 1] ?? '') &&
      /[\uDC00-\uDFFF]/.test(value[end]!)
    )
      end--;
    if (end === column && end < value.length) break;
    const rendered = prefix + value.slice(column, end);
    length += rendered.length + (parts.length ? 1 : 0);
    parts.push(rendered);
    if (end < value.length) {
      column = end;
      break;
    }
    line++;
    column = 0;
  }
  const more = line < lines.length;
  return {
    total_lines: lines.length,
    start_line: startLine,
    start_column: startColumn,
    next_line: more ? line + 1 : null,
    next_column: more ? column + 1 : null,
    content: parts.join('\n'),
    truncated: more,
    encoding: 'utf-8',
    bom: text.startsWith('\ufeff'),
    line_ending: text.includes('\r\n')
      ? /(^|[^\r])\n/.test(text)
        ? 'mixed'
        : 'crlf'
      : text.includes('\n')
        ? 'lf'
        : 'none',
  };
}
