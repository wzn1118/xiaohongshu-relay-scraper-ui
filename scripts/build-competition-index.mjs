import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [sourcePath, destinationPath, datasetTaskId, workflowTaskId] = process.argv.slice(2);

if (!sourcePath || !destinationPath || !datasetTaskId || !workflowTaskId) {
  console.error('Usage: node scripts/build-competition-index.mjs <source> <destination> <dataset-task-id> <workflow-task-id>');
  process.exit(2);
}

const jobs = JSON.parse(await readFile(path.resolve(sourcePath), 'utf8'));
if (!Array.isArray(jobs)) throw new Error('The source jobs index must be a JSON array.');

const requiredIds = [datasetTaskId, workflowTaskId];
const selected = requiredIds.map((id) => {
  const job = jobs.find((candidate) => candidate?.id === id);
  if (!job) throw new Error(`Required task is missing from the jobs index: ${id}`);
  return job;
});

const output = path.resolve(destinationPath);
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(selected, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  ok: true,
  destination: output,
  defaultTaskId: selected[0].id,
  taskIds: selected.map((job) => job.id),
  statuses: Object.fromEntries(selected.map((job) => [job.id, job.status])),
}));
