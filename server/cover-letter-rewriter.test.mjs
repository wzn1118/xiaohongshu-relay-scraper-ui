import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import {
  CoverLetterRewriteError,
  createCoverLetterRewriter,
} from './lib/cover-letter-rewriter.mjs';

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

const fixtureScriptPath = path.resolve('fixtures', 'rewrite_cover_letter.py');

function validOutput() {
  const coverLetter = '我'.repeat(800);
  return {
    result: {
      email_subject: '内容运营实习申请｜示例用户',
      cover_letter: coverLetter,
      used_evidence_ids: ['evidence-1'],
      evidence_coverage: [{ evidence_id: 'evidence-1', evidence_sentence: coverLetter }],
      responsibility_coverage: [{ responsibility_id: 'responsibility-1' }],
      char_count: 800,
      attempts: 1,
      prompt_version: 'cover-letter-rewrite-v1',
    },
    runtime: {
      provider: 'openai-compatible',
      model: 'advanced-cover-model',
      wireApi: 'responses',
    },
  };
}

test('passes rewrite context on stdin and the selected advanced model only through environment variables', async () => {
  let command;
  let args;
  let options;
  let input = '';
  const child = fakeChild((chunk) => { input += chunk.toString('utf8'); });
  const rewriter = createCoverLetterRewriter({
    pythonBin: 'fixture-python',
    scriptPath: fixtureScriptPath,
    spawnImpl(nextCommand, nextArgs, nextOptions) {
      command = nextCommand;
      args = nextArgs;
      options = nextOptions;
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify(validOutput()));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const payload = {
    record: { id: 'note-1', application_info: { role_name: '内容运营实习生' } },
    outreach: { cover_letter: '当前求职信' },
    instructions: '重点突出用户洞察与数据复盘，不要使用套话。',
  };
  const result = await rewriter(payload, {
    provider: 'openai-compatible',
    apiKey: 'top-secret',
    baseUrl: 'https://ai.example.test/v1',
    model: 'advanced-cover-model',
    wireApi: 'responses',
    maxOutputTokens: 2_048,
  });

  assert.equal(result.cover_letter, '我'.repeat(800));
  assert.equal(result.runtime.model, 'advanced-cover-model');
  assert.equal(command, 'fixture-python');
  assert.deepEqual(args, [fixtureScriptPath]);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(JSON.parse(input), payload);
  assert.equal(options.env.XHS_AI_PROVIDER, 'openai-compatible');
  assert.equal(options.env.XHS_AI_API_KEY, 'top-secret');
  assert.equal(options.env.XHS_AI_BASE_URL, 'https://ai.example.test/v1');
  assert.equal(options.env.XHS_AI_MODEL, 'advanced-cover-model');
  assert.equal(options.env.XHS_AI_WIRE_API, 'responses');
  assert.equal(options.env.XHS_AI_MAX_OUTPUT_TOKENS, '4096');
  assert.equal(input.includes('top-secret'), false);
  assert.equal(args.includes('top-secret'), false);
});

test('passes a local model session to Python and preserves the local multi-stage metadata', async () => {
  let options;
  const child = fakeChild();
  const rewriter = createCoverLetterRewriter({
    pythonBin: 'fixture-python',
    scriptPath: fixtureScriptPath,
    spawnImpl(_command, _args, nextOptions) {
      options = nextOptions;
      queueMicrotask(() => {
        const output = validOutput();
        output.result.generation_strategy = 'local_plan_write_review';
        output.result.model_calls = 3;
        output.result.review_score = 94;
        output.runtime = {
          provider: 'local_qwen',
          model: 'qwen3.5:4b',
          wireApi: 'chat_completions',
        };
        child.stdout.end(JSON.stringify(output));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  const result = await rewriter({ record: {}, outreach: {}, instructions: '逐项回应岗位职责' }, {
    provider: 'local_qwen',
    apiKey: '',
    baseUrl: 'http://127.0.0.1:11434/v1',
    model: 'qwen3.5:4b',
    wireApi: 'chat_completions',
  });

  assert.equal(options.env.XHS_AI_PROVIDER, 'local_qwen');
  assert.equal(options.env.XHS_AI_MODEL, 'qwen3.5:4b');
  assert.equal(options.env.XHS_AI_API_KEY, '');
  assert.equal(result.runtime.provider, 'local_qwen');
  assert.equal(result.generation_strategy, 'local_plan_write_review');
  assert.equal(result.model_calls, 3);
  assert.equal(result.review_score, 94);
});

test('rejects a successful child response when the cover letter is shorter than 800 characters', async () => {
  const child = fakeChild();
  const rewriter = createCoverLetterRewriter({
    scriptPath: fixtureScriptPath,
    spawnImpl() {
      queueMicrotask(() => {
        child.stdout.end(JSON.stringify({
          result: {
            cover_letter: '太短',
            used_evidence_ids: [],
            responsibility_coverage: [],
            char_count: 2,
          },
        }));
        child.emit('close', 0, null);
      });
      return child;
    },
  });

  await assert.rejects(
    rewriter({ record: {}, outreach: {}, instructions: '重写' }),
    (error) => error.code === 'COVER_LETTER_REWRITE_OUTPUT_INVALID',
  );
});

test('redacts the AI key from rewrite process errors', async () => {
  const child = fakeChild();
  const rewriter = createCoverLetterRewriter({
    scriptPath: fixtureScriptPath,
    spawnImpl() {
      queueMicrotask(() => {
        child.stderr.end('provider rejected key top-secret');
        child.emit('close', 2, null);
      });
      return child;
    },
  });

  await assert.rejects(
    rewriter({ record: {}, outreach: {} }, { apiKey: 'top-secret' }),
    (error) => {
      assert.ok(error instanceof CoverLetterRewriteError);
      assert.equal(error.code, 'COVER_LETTER_REWRITE_PROCESS_FAILED');
      assert.equal(error.message.includes('top-secret'), false);
      assert.match(error.message, /\[REDACTED\]/);
      return true;
    },
  );
});
