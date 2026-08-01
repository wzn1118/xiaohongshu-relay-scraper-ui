import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  createDraftQualityChecker,
  DraftQualityCheckError,
} from './lib/draft-quality-checker.mjs';

function fakeChild(onInput) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on('data', (chunk) => onInput?.(chunk));
  child.kill = (signal) => {
    child.killedWith = signal;
    queueMicrotask(() => child.emit('close', null, signal));
    return true;
  };
  return child;
}

const validReport = {
  score: 92,
  rubric: {
    role_relevance: 23,
    evidence: 23,
    first_person: 14,
    concision: 14,
    credibility: 9,
    action_readiness: 9,
  },
  strengths: ['Grounded'],
  problems: [],
  rewrite_instructions: [],
  threshold: 90,
  passed: true,
  attempt: 1,
  attempts: 1,
};

test('passes the draft on stdin and AI configuration only through environment variables', async () => {
  let command;
  let args;
  let options;
  let input = '';
  const child = fakeChild((chunk) => { input += chunk.toString('utf8'); });
  const checker = createDraftQualityChecker({
    pythonBin: 'fixture-python',
    scriptPath: 'C:/repo/scripts/recheck_application_draft.py',
    spawnImpl(nextCommand, nextArgs, nextOptions) {
      command = nextCommand;
      args = nextArgs;
      options = nextOptions;
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify(validReport));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const payload = { record: { id: 'note-1' }, draft: { greeting: 'hello' }, threshold: 90 };
  const result = await checker(payload, {
    provider: 'openai-compatible',
    apiKey: 'top-secret',
    baseUrl: 'https://ai.example.test/v1',
    model: 'fixture-model',
    wireApi: 'responses',
  });

  assert.deepEqual(result, validReport);
  assert.equal(command, 'fixture-python');
  assert.deepEqual(args, ['C:\\repo\\scripts\\recheck_application_draft.py']);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(JSON.parse(input), payload);
  assert.equal(options.env.XHS_AI_PROVIDER, 'openai-compatible');
  assert.equal(options.env.XHS_AI_API_KEY, 'top-secret');
  assert.equal(options.env.XHS_AI_BASE_URL, 'https://ai.example.test/v1');
  assert.equal(options.env.XHS_AI_MODEL, 'fixture-model');
  assert.equal(options.env.XHS_AI_WIRE_API, 'responses');
  assert.equal(input.includes('top-secret'), false);
  assert.equal(args.includes('top-secret'), false);
});

test('redacts AI secrets from child process errors', async () => {
  const child = fakeChild();
  const checker = createDraftQualityChecker({
    scriptPath: 'C:/repo/scripts/recheck_application_draft.py',
    spawnImpl() {
      queueMicrotask(() => {
        child.stderr.end('provider rejected key top-secret');
        child.emit('close', 2, null);
      });
      return child;
    },
  });

  await assert.rejects(
    checker({ record: {}, draft: {} }, { apiKey: 'top-secret' }),
    (error) => {
      assert.ok(error instanceof DraftQualityCheckError);
      assert.equal(error.code, 'DRAFT_QUALITY_PROCESS_FAILED');
      assert.equal(error.message.includes('top-secret'), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});

test('rejects invalid successful output', async () => {
  const child = fakeChild();
  const checker = createDraftQualityChecker({
    scriptPath: 'C:/repo/scripts/recheck_application_draft.py',
    spawnImpl() {
      queueMicrotask(() => {
        child.stdout.end('{"score":92}');
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  await assert.rejects(
    checker({ record: {}, draft: {} }),
    (error) => error.code === 'DRAFT_QUALITY_OUTPUT_INVALID',
  );
});

test('kills and rejects a timed-out process', async () => {
  const child = fakeChild();
  const checker = createDraftQualityChecker({
    scriptPath: 'C:/repo/scripts/recheck_application_draft.py',
    timeoutMs: 5,
    spawnImpl: () => child,
  });

  await assert.rejects(
    checker({ record: {}, draft: {} }),
    (error) => error.code === 'DRAFT_QUALITY_TIMEOUT',
  );
  assert.equal(child.killedWith, 'SIGKILL');
});

test('enforces a bounded stdout buffer', async () => {
  const child = fakeChild();
  const checker = createDraftQualityChecker({
    scriptPath: 'C:/repo/scripts/recheck_application_draft.py',
    maxOutputBytes: 16,
    spawnImpl() {
      queueMicrotask(() => child.stdout.write('x'.repeat(17)));
      return child;
    },
  });

  await assert.rejects(
    checker({ record: {}, draft: {} }),
    (error) => error.code === 'DRAFT_QUALITY_OUTPUT_LIMIT',
  );
  assert.equal(child.killedWith, 'SIGKILL');
});
