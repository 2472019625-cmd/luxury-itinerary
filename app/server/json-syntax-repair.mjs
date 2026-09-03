function stripJsonWrapper(content) {
  return String(content || "")
    .replace(/^\uFEFF/, "")
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
}

function syntaxPosition(error) {
  const match = String(error?.message || "").match(/(?:position|at position)\s+(\d+)/i);
  return match ? Number(match[1]) : null;
}

function previousSignificant(source, index) {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(source[cursor])) return source[cursor];
  }
  return "";
}

function normalizeStringEscapes(source, operations) {
  let output = "";
  let inString = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (!inString) {
      output += char;
      if (char === '"') inString = true;
      continue;
    }
    if (char === '"') {
      output += char;
      inString = false;
      continue;
    }
    if (char === "\\") {
      const next = source[index + 1];
      if (next === "u" && !/^[0-9a-fA-F]{4}$/.test(source.slice(index + 2, index + 6))) {
        output += "\\\\";
        operations.push({ type: "escaped_invalid_backslash", position: index });
        continue;
      }
      if (next && !/["\\/bfnrtu]/.test(next)) {
        output += "\\\\";
        operations.push({ type: "escaped_invalid_backslash", position: index });
        continue;
      }
      output += char;
      if (next) {
        output += next;
        index += 1;
      }
      continue;
    }
    const code = char.charCodeAt(0);
    if (code <= 0x1f) {
      const escaped = char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
      output += escaped;
      operations.push({ type: "escaped_control_character", position: index });
      continue;
    }
    output += char;
  }
  return output;
}

function removeTrailingCommas(source, operations) {
  let output = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
      continue;
    }
    if (char === ",") {
      let cursor = index + 1;
      while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1;
      if (source[cursor] === "}" || source[cursor] === "]") {
        operations.push({ type: "removed_trailing_comma", position: index });
        continue;
      }
    }
    output += char;
  }
  return output;
}

function closingDelimiters(source) {
  const stack = [];
  let inString = false;
  let escaped = false;
  for (const char of source) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const expected = char === "}" ? "{" : "[";
      if (stack.at(-1) !== expected) return null;
      stack.pop();
    }
  }
  if (inString) return null;
  const tail = source.trim().at(-1) || "";
  if (!stack.length || [":", ",", "{", "["].includes(tail)) return "";
  return stack.reverse().map((char) => char === "{" ? "}" : "]").join("");
}

function repairCandidate(source) {
  const operations = [];
  let repaired = normalizeStringEscapes(source, operations);
  repaired = removeTrailingCommas(repaired, operations);
  for (let pass = 0; pass < 20; pass += 1) {
    try {
      JSON.parse(repaired);
      return { repaired, operations };
    } catch (error) {
      const position = syntaxPosition(error);
      if (position === null || position < 0 || position > repaired.length) break;
      const current = repaired[position] || "";
      const previous = previousSignificant(repaired, position);
      const expectsComma = /Expected ',' or '[}\]]' after property value|Expected ',' or '\]' after array element/i.test(error.message);
      const nextLooksLikeValue = current === '"' || current === "{" || current === "[" || /[-0-9tfn]/.test(current);
      const previousCompletesValue = previous === '"' || previous === "}" || previous === "]" || /[0-9el]/.test(previous);
      if (expectsComma && nextLooksLikeValue && previousCompletesValue) {
        repaired = `${repaired.slice(0, position)},${repaired.slice(position)}`;
        operations.push({ type: "inserted_missing_comma", position });
        continue;
      }
      break;
    }
  }
  try {
    JSON.parse(repaired);
    return { repaired, operations };
  } catch {
    const closers = closingDelimiters(repaired);
    if (closers) {
      operations.push({ type: "appended_closing_delimiters", count: closers.length });
      repaired += closers;
    }
  }
  return { repaired, operations };
}

export function parseJsonWithSyntaxRepair(content, { allowRepair = false } = {}) {
  const source = stripJsonWrapper(content);
  try {
    return { json: JSON.parse(source), source, repairedSource: null, result: { status: "valid_json", repaired: false, operations: [], parseError: null, repairError: null } };
  } catch (parseError) {
    if (!allowRepair) {
      parseError.parseResult = { status: "invalid_json", repaired: false, operations: [], parseError: parseError.message, repairError: null };
      throw parseError;
    }
    const candidate = repairCandidate(source);
    if (!candidate.operations.length || candidate.repaired === source) {
      parseError.parseResult = { status: "invalid_json", repaired: false, operations: [], parseError: parseError.message, repairError: "没有可确定执行的纯语法修复" };
      throw parseError;
    }
    try {
      return {
        json: JSON.parse(candidate.repaired),
        source,
        repairedSource: candidate.repaired,
        result: { status: "repaired_json", repaired: true, operations: candidate.operations, parseError: parseError.message, repairError: null },
      };
    } catch (repairError) {
      parseError.parseResult = { status: "invalid_json", repaired: false, operations: candidate.operations, parseError: parseError.message, repairError: repairError.message };
      throw parseError;
    }
  }
}
