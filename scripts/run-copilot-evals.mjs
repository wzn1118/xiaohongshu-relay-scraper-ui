import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runGoldenEvaluation } from '../server/copilot/evaluation-suite.mjs';

const outputPath = path.resolve(process.argv[2] || 'output/reports/data-copilot-golden-30.json');
const result = await runGoldenEvaluation();
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ outputPath, status: result.status, ...result.summary }));
if (result.status !== 'passed') process.exitCode = 1;
