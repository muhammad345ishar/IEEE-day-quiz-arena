import { fileURLToPath } from 'node:url';
import { loadQuestions } from '../server/questions.js';

const filePath = fileURLToPath(new URL('../questions.json', import.meta.url));
try {
  const questions = loadQuestions(filePath);
  console.log(`Validated questions.json: ${questions.length} ${questions.length === 1 ? 'question' : 'questions'} loaded.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
