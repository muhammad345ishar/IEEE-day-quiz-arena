import { readFileSync } from 'node:fs';
import { findNodeAtLocation, parseTree, printParseErrorCode } from 'jsonc-parser';

const syntaxMessages = {
  InvalidSymbol: 'Unexpected character or token; use strict JSON syntax.',
  InvalidNumberFormat: 'Invalid JSON number.',
  PropertyNameExpected: 'Expected a property name in double quotes (trailing commas are not allowed).',
  ValueExpected: 'Expected a JSON value (trailing commas are not allowed).',
  ColonExpected: 'Expected a colon after the property name.',
  CommaExpected: 'Expected a comma between values.',
  CloseBraceExpected: 'Expected a closing brace (}).',
  CloseBracketExpected: 'Expected a closing bracket (]).',
  EndOfFileExpected: 'Unexpected content after the JSON value.',
  InvalidCommentToken: 'Comments are not allowed; questions.json must be strict JSON.',
  UnexpectedEndOfComment: 'Comments are not allowed; questions.json must be strict JSON.',
  UnexpectedEndOfString: 'Unterminated string; close the text with a double quote.',
  UnexpectedEndOfNumber: 'Incomplete JSON number.',
  InvalidUnicode: 'Invalid Unicode escape in string.',
  InvalidEscapeCharacter: 'Invalid escape sequence in string.',
  InvalidCharacter: 'Invalid character in string; escape line breaks and control characters.',
};

/** Collect line starts once so a large bank does not rescan the file for every error. */
function sourceLocations(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\r') {
      if (source[i + 1] === '\n') i += 1;
      starts.push(i + 1);
    } else if (source[i] === '\n') starts.push(i + 1);
  }
  return (offset) => {
    let low = 0;
    let high = starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle;
    }
    const end = starts[low + 1] ?? source.length;
    return {
      line: low + 1,
      column: offset - starts[low] + 1,
      sourceLine: source.slice(starts[low], end).replace(/[\r\n]+$/, ''),
    };
  };
}

export class QuestionsValidationError extends Error {
  constructor(fileName, diagnostics) {
    const details = diagnostics.map(({ line, column, message, sourceLine }) => {
      // Keep tabs before the caret aligned with tabs in the actual source line.
      const caretPrefix = sourceLine.slice(0, column - 1).replace(/[^\t]/g, ' ');
      return `${fileName}:${line}:${column}: ${message}\n  ${sourceLine}\n  ${caretPrefix}^`;
    }).join('\n\n');
    super(`Invalid question bank (${diagnostics.length} ${diagnostics.length === 1 ? 'error' : 'errors'}):\n${details}`);
    this.name = 'QuestionsValidationError';
    this.diagnostics = diagnostics;
  }
}

/** Validate strict JSON and return only the supported question fields. No size cap. */
export function validateQuestions(source, fileName = 'questions.json') {
  if (typeof source !== 'string') throw new TypeError('Question source must be a JSON string.');
  const locate = sourceLocations(source);
  const syntaxErrors = [];
  const tree = parseTree(source, syntaxErrors, { disallowComments: true, allowTrailingComma: false });
  if (syntaxErrors.length) {
    const unique = new Map();
    for (const { error, offset } of syntaxErrors) {
      const code = printParseErrorCode(error);
      unique.set(`${offset}:${code}`, {
        ...locate(offset),
        message: syntaxMessages[code] ?? `Invalid JSON (${code}).`,
      });
    }
    throw new QuestionsValidationError(fileName, [...unique.values()]);
  }

  let value;
  try {
    // JSON.parse is the final strict-syntax authority; the tree supplies source offsets.
    value = JSON.parse(source);
  } catch (error) {
    const offsetMatch = error.message.match(/position (\d+)/i);
    const offset = offsetMatch ? Number(offsetMatch[1]) : Math.max(0, source.length - 1);
    throw new QuestionsValidationError(fileName, [{ ...locate(offset), message: error.message }]);
  }

  const diagnostics = [];
  const fail = (path, message, fallbackPath = []) => {
    const node = findNodeAtLocation(tree, path) ?? findNodeAtLocation(tree, fallbackPath) ?? tree;
    diagnostics.push({ ...locate(node?.offset ?? 0), message });
  };
  if (!Array.isArray(value)) {
    fail([], 'Root must be a non-empty array of question objects.');
  } else if (!value.length) {
    fail([], 'Root must contain at least one question.');
  } else {
    value.forEach((item, index) => {
      const label = `Question ${index + 1}`;
      if (item === null || Array.isArray(item) || typeof item !== 'object') {
        fail([index], `${label} must be an object with question, options and correctIndex fields.`);
        return;
      }
      if (typeof item.question !== 'string' || !item.question.trim()) {
        fail([index, 'question'], `${label}, question: expected non-empty text.`, [index]);
      }
      if (!Array.isArray(item.options) || item.options.length !== 4) {
        fail([index, 'options'], `${label}, options: expected an array of exactly 4 options.`, [index]);
      }
      if (Array.isArray(item.options)) {
        item.options.forEach((option, optionIndex) => {
          if (typeof option !== 'string' || !option.trim()) {
            fail([index, 'options', optionIndex], `${label}, options[${optionIndex}]: expected non-empty text.`, [index, 'options']);
          }
        });
      }
      if (!Number.isInteger(item.correctIndex) || item.correctIndex < 0 || item.correctIndex > 3) {
        fail([index, 'correctIndex'], `${label}, correctIndex: expected an integer from 0 to 3.`, [index]);
      }
    });
  }
  if (diagnostics.length) throw new QuestionsValidationError(fileName, diagnostics);
  return value.map(({ question, options, correctIndex }) => ({
    question: question.trim(),
    options: options.map((option) => option.trim()),
    correctIndex,
  }));
}

export function loadQuestions(filePath) {
  let source;
  try {
    source = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new Error(`Cannot read question bank ${filePath}: ${error.message}`, { cause: error });
  }
  return validateQuestions(source, String(filePath));
}
