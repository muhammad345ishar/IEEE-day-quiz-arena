import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadQuestions, QuestionsValidationError, validateQuestions } from '../server/questions.js';

const question = { question: 'Which option?', options: ['A', 'B', 'C', 'D'], correctIndex: 2 };
const validate = (value) => validateQuestions(JSON.stringify(value));

test('validates and normalizes text without exposing unrelated fields', () => {
  assert.deepEqual(validate([{ ...question, question: '  Text? \n', options: [' A ', ' B ', 'C', 'D'], extra: true }]), [
    { ...question, question: 'Text?' },
  ]);
});

test('supports arbitrarily many questions without a fixed cap', () => {
  const bank = Array.from({ length: 10000 }, (_, i) => ({ ...question, question: `Question ${i + 1}` }));
  assert.equal(validate(bank).length, 10000);
});

test('rejects missing, empty and non-array roots', () => {
  for (const value of [[], {}, null, 'text', 4, true]) {
    assert.throws(() => validate(value), QuestionsValidationError);
  }
  assert.throws(() => validateQuestions(''), QuestionsValidationError);
  assert.throws(() => validateQuestions(null), /source must be a JSON string/);
});

test('requires each item to be an object', () => {
  for (const value of [null, [], 'question', 1, true]) {
    assert.throws(() => validate([value]), /Question 1 must be an object/);
  }
});

test('question text must be present and a non-empty string', () => {
  for (const value of [undefined, null, '', ' \n\t', 2, true, [], {}]) {
    assert.throws(() => validate([{ ...question, question: value }]), /Question 1, question: expected non-empty text/);
  }
});

test('requires exactly four non-empty string options', () => {
  for (const options of [undefined, null, {}, 'ABCD', [], ['A'], ['A', 'B', 'C'], ['A', 'B', 'C', 'D', 'E']]) {
    assert.throws(() => validate([{ ...question, options }]), /options: expected an array of exactly 4/);
  }
  for (const option of [null, '', ' \t', 4, false, {}, []]) {
    assert.throws(() => validate([{ ...question, options: ['A', option, 'C', 'D'] }]), /options\[1\]: expected non-empty text/);
  }
});

test('requires correctIndex to be an integer from zero through three', () => {
  for (const correctIndex of [undefined, null, -1, 4, 0.5, '2', true, {}, [], Infinity, NaN]) {
    assert.throws(() => validate([{ ...question, correctIndex }]), /correctIndex: expected an integer from 0 to 3/);
  }
  for (const correctIndex of [0, 1, 2, 3]) assert.equal(validate([{ ...question, correctIndex }])[0].correctIndex, correctIndex);
});

test('rejects comments, trailing commas and other non-JSON syntax', () => {
  const valid = JSON.stringify([question]);
  for (const source of [
    `// comment\n${valid}`,
    `/* comment */${valid}`,
    valid.replace('}]', '},]'),
    valid.replace('"correctIndex":2', '"correctIndex":2,'),
    "[{question: 'wrong'}]",
    valid + ' true',
    valid.replace('Which option?', 'Bad\nstring'),
    valid.replace('Which option?', 'Bad\\xescape'),
    valid.replace('"correctIndex":2', '"correctIndex":02'),
  ]) {
    assert.throws(() => validateQuestions(source), QuestionsValidationError, source);
  }
});

test('reports precise source locations and contextual errors for multiple bad fields', () => {
  const source = '[\n  {\n    "question": "  ",\n    "options": ["A", "", "C", "D"],\n    "correctIndex": 4\n  }\n]';
  assert.throws(() => validateQuestions(source, '/event/questions.json'), (error) => {
    assert.ok(error instanceof QuestionsValidationError);
    assert.equal(error.diagnostics.length, 3);
    assert.deepEqual(error.diagnostics.map(({ line, column }) => [line, column]), [[3, 17], [4, 22], [5, 21]]);
    assert.match(error.message, /\/event\/questions.json:3:17: Question 1, question/);
    assert.match(error.message, /"correctIndex": 4\n\s+\^/);
    return true;
  });
});

test('missing fields use the containing object location, with CRLF support', () => {
  assert.throws(() => validateQuestions('[\r\n  {}\r\n]'), (error) => {
    assert.equal(error.diagnostics.length, 3);
    for (const diagnostic of error.diagnostics) {
      assert.equal(diagnostic.line, 2);
      assert.equal(diagnostic.column, 3);
    }
    return true;
  });
});

test('malformed JSON points to the actual bad line', () => {
  assert.throws(() => validateQuestions('[\n  {\n    "question": @\n  }\n]', 'quiz.json'), (error) => {
    assert.match(error.message, /quiz.json:3:17:/);
    assert.match(error.message, /"question": @/);
    return true;
  });
});

test('loadQuestions re-reads the file and reports missing files clearly', () => {
  const folder = mkdtempSync(join(tmpdir(), 'quiz-questions-test-'));
  const file = join(folder, 'questions.json');
  try {
    writeFileSync(file, JSON.stringify([question]));
    assert.equal(loadQuestions(file).length, 1);
    writeFileSync(file, JSON.stringify([question, question]));
    assert.equal(loadQuestions(file).length, 2);
    writeFileSync(file, '[broken');
    assert.throws(() => loadQuestions(file), QuestionsValidationError);
    assert.throws(() => loadQuestions(join(folder, 'missing.json')), /Cannot read question bank/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
