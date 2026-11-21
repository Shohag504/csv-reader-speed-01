// Fast drop-in for csv-reader 1.0.0 (make.fun's own CSV reader).
//
// Returns exactly what csv-reader 1.0.0 returns for {text, header} ->
// {columns, rows, errors}, including all of its broken-row quirks:
// a U+FEFF at the very start is dropped; a record ends at LF or CRLF and
// a line left with no characters is no record; outside quotes a CR not
// followed by LF is dropped (stray_cr); a field opening with a quote runs
// to the next undoubled quote ("" inside is one quote, each CRLF or lone CR
// inside is read as LF); what follows its closing quote up to the next
// comma or line break is appended as it stands (quote_junk, when the field
// ends); a quote that never closes is a literal character and the text
// after it is read again as unquoted (unterminated_quote); a quote inside
// an unquoted field is literal; fields stay strings, never trimmed.
// columns is the first record when header is true, else null; rows are the
// records after it, each padded (short_row, with fields: its count) or cut
// (long_row, with extra: the cut fields) to the first record's width.
// Each error is {code, line, row}, in the order met; line is the 1-based
// line its record starts on, row its index in rows (null for the header).
//
// Speed: the reference walks one character at a time and builds every field
// a character at a time. This one instead jumps with String#indexOf (native
// memchr-style scans) and String#slice, which only copies field-sized
// pieces: an unquoted field is the slice up to the next comma or LF (a lone
// CR inside it falls back to a short character loop), a quoted field is the
// slice up to its closing quote (found by skipping doubled quotes), and a
// whole record with no quote and no stray CR is split(',') in one native
// call. Nothing here depends on locale, clock or randomness; two runs on
// the same input write byte-identical outputs.

const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const len = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The field just read (set by unquoted/quoted): its value, how it ended, and how many characters were kept.
  let fval = '';
  let fend = END;
  let fadded = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break: a CR not followed by LF is
  // dropped (stray_cr). Sets fval/fend/fadded.
  function unquoted(value) {
    let added = 0;
    if (pos >= len) {
      fval = value;
      fend = END;
      fadded = 0;
      return;
    }
    for (;;) {
      const comma = text.indexOf(',', pos);
      const nl = text.indexOf('\n', pos);
      let end;
      let isNL;
      if (comma === -1) {
        if (nl === -1) {
          end = len;
          isNL = false;
        } else {
          end = nl;
          isNL = true;
        }
      } else if (nl === -1) {
        end = comma;
        isNL = false;
      } else if (comma < nl) {
        end = comma;
        isNL = false;
      } else {
        end = nl;
        isNL = true;
      }
      // A CR just before the LF is the CRLF line ending, not field content.
      let chunkEnd = end;
      if (isNL && end > pos && text.charCodeAt(end - 1) === 13) chunkEnd = end - 1;
      const chunk = text.slice(pos, chunkEnd);
      if (chunk.indexOf('\r') === -1) {
        value += chunk;
        added += chunk.length;
        if (end === len) {
          pos = len;
          fend = END;
        } else if (isNL) {
          pos = end + 1;
          line += 1;
          fend = LINE_BREAK;
        } else {
          pos = end + 1;
          fend = COMMA;
        }
        fval = value;
        fadded = added;
        return;
      }
      // A stray CR sits inside this field: walk it a character at a time (rare).
      while (pos < len) {
        const cc = text.charCodeAt(pos);
        if (cc === 44) {
          pos += 1;
          fval = value;
          fend = COMMA;
          fadded = added;
          return;
        }
        if (cc === 10) {
          pos += 1;
          line += 1;
          fval = value;
          fend = LINE_BREAK;
          fadded = added;
          return;
        }
        if (cc === 13) {
          if (text.charCodeAt(pos + 1) === 10) {
            pos += 2;
            line += 1;
            fval = value;
            fend = LINE_BREAK;
            fadded = added;
            return;
          }
          errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          pos += 1;
          continue;
        }
        value += text[pos];
        added += 1;
        pos += 1;
      }
      fval = value;
      fend = END;
      fadded = added;
      return;
    }
  }

  // Reads a quoted field whose opening quote is at pos. Sets fval/fend/fadded.
  function quoted() {
    const open = pos;
    const openLine = line;
    // Find the closing quote: the next quote that is not doubled.
    let p = pos + 1;
    let q = -1;
    for (;;) {
      q = text.indexOf('"', p);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        p = q + 2;
        continue;
      }
      break;
    }
    if (q === -1) {
      // The quote never closes: it is a literal character, and the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      unquoted('"');
      return;
    }
    const inner = text.slice(open + 1, q);
    let value;
    if (inner.indexOf('"') === -1) {
      if (inner.indexOf('\r') === -1 && inner.indexOf('\n') === -1) {
        value = inner;
      } else {
        // Each CRLF or lone CR inside quotes is read as one LF.
        value = inner.replace(/\r\n?/g, '\n');
        let n = 0;
        let idx = -1;
        while ((idx = value.indexOf('\n', idx + 1)) !== -1) n += 1;
        line += n;
      }
    } else {
      value = inner.replace(/\r\n?/g, '\n').replace(/""/g, '"');
      let n = 0;
      let idx = -1;
      while ((idx = value.indexOf('\n', idx + 1)) !== -1) n += 1;
      line += n;
    }
    pos = q + 1;
    if (pos >= len) {
      fval = value;
      fend = END;
      fadded = 0;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fval = value;
      fend = COMMA;
      fadded = 0;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fval = value;
      fend = LINE_BREAK;
      fadded = 0;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fval = value;
      fend = LINE_BREAK;
      fadded = 0;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the next comma or line break.
    unquoted(value);
    if (fadded > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  // Finishes one record: the header, or a row padded/cut to the first record's width.
  function emit(fields) {
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record with no quote and no stray CR splits in one native call.
    const nl = text.indexOf('\n', pos);
    const recEnd = nl === -1 ? len : nl;
    const rec = text.slice(pos, recEnd);
    if (rec.indexOf('"') === -1) {
      const cr = rec.indexOf('\r');
      if (cr === -1 || (nl !== -1 && cr === rec.length - 1)) {
        const fields = (cr === -1 ? rec : rec.slice(0, -1)).split(',');
        pos = nl === -1 ? len : nl + 1;
        if (nl !== -1) line += 1;
        // A line that held only stray CRs is left with no characters: no record.
        if (fields.length === 1 && fields[0] === '') continue;
        emit(fields);
        continue;
      }
    }

    const fields = [];
    let lastQuoted = false;
    do {
      lastQuoted = text.charCodeAt(pos) === 34;
      if (lastQuoted) quoted();
      else unquoted('');
      fields.push(fval);
    } while (fend === COMMA);

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    emit(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
