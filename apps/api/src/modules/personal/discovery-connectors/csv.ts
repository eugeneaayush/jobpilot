export function parseCsv(input: string) {
  const rows: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = "";
  let quoted = false;
  let closed = false;
  let line = 1;
  let start = 1;
  const pushField = () => {
    cells.push(field);
    field = "";
    closed = false;
  };
  const pushRow = () => {
    pushField();
    if (cells.length > 1 || cells[0] !== "") rows.push({ cells, line: start });
    if (rows.length > 5001) throw new Error("CSV exceeds 5000 posting rows");
    cells = [];
  };
  for (let i = 0; i < input.length; i++) {
    const character = input[i];
    if (character === '"') {
      if (quoted && input[i + 1] === '"') {
        field += '"';
        i++;
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (field || closed) throw new Error(`Unexpected CSV quote on line ${line}`);
      else quoted = true;
    } else if (character === "\n" || character === "\r") {
      const newline = character === "\r" && input[i + 1] === "\n" ? "\r\n" : character;
      if (newline.length === 2) i++;
      if (quoted) field += newline;
      else pushRow();
      line++;
      if (!quoted) start = line;
    } else if (character === "," && !quoted) pushField();
    else {
      if (closed) throw new Error(`Unexpected data after CSV quote on line ${line}`);
      field += character;
    }
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (field || closed || cells.length) pushRow();
  return rows;
}
