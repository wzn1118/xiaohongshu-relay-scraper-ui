# Runner fixtures and artifact acceptance

This directory provides a deterministic substitute for the local Xiaohongshu
relay runner. It is intended for backend process, log-streaming, cancellation,
and artifact-delivery tests. It does not contact Xiaohongshu or read a token.

## Files

- `fixtures/mock_xiaohongshu_runner.py`: standard-library-only Python runner.
- `mock-runner.test.mjs`: end-to-end Node test for all fixture scenarios.
- `../scripts/verify-artifacts.mjs`: independent artifact and path validator.

## Mock runner contract

The mock accepts the real runner's common arguments, including `--keyword`,
`--search-url`, `--output-dir`, `--limit`, `--relay-port`, `--browser-profile`,
`--resume`, and `--fresh`. Unknown real-runner options are ignored so the same
Node spawn adapter can be used for production and fixture runs.

Select a scenario with `--mock-scenario` or `MOCK_RUNNER_SCENARIO`:

| Scenario | Exit | Behaviour |
| --- | ---: | --- |
| `success` | `0` | Streams realistic progress and publishes JSON, CSV, XLSX, and a SHA-256 manifest. |
| `failure` | `1` | Streams the normal failure markers and publishes a `failed` manifest only. |
| `long` | `130` after cancellation | Streams heartbeats, keeps a partial card checkpoint, and waits for a signal or cancellation file. |

The useful fixture-only controls are:

- `--mock-records N`
- `--mock-delay-seconds N`
- `--mock-long-seconds N`
- `--mock-cancel-file PATH`
- `--mock-failure-exit-code N`

The environment equivalents `MOCK_RUNNER_RECORDS`,
`MOCK_RUNNER_DELAY_SECONDS`, and `MOCK_RUNNER_LONG_SECONDS` are also supported.
Runner output is line-buffered for direct use with Node `spawn()` stdout events.

## Quick start

From the repository root in PowerShell:

```powershell
$out = Join-Path $PWD 'output\fixture-success'
python tests\fixtures\mock_xiaohongshu_runner.py `
  --mock-scenario success `
  --mock-records 3 `
  --keyword '实习继任' `
  --output-dir $out

node scripts\verify-artifacts.mjs `
  --output-dir $out `
  --allowed-root (Join-Path $PWD 'output') `
  --expect-count 3
```

The verifier exits `0` only when all of the following pass:

- the output's lexical and resolved paths remain under `--allowed-root`;
- the output and artifacts are regular paths rather than symbolic links;
- the success manifest lists every required artifact with the correct size and SHA-256;
- latest and deduplicated JSON contain matching, unique note IDs;
- both CSV files have the same record count as JSON;
- both XLSX files are non-empty ZIP containers with the required workbook entries.

Use `--json` for a machine-readable verifier result.

## Long task cancellation

Start the mock in one terminal:

```powershell
$out = Join-Path $PWD 'output\fixture-long'
$cancel = Join-Path $PWD 'output\fixture.cancel'
python tests\fixtures\mock_xiaohongshu_runner.py `
  --mock-scenario long `
  --mock-cancel-file $cancel `
  --output-dir $out
```

Create the cancellation marker from another terminal:

```powershell
New-Item -ItemType File -Path (Join-Path $PWD 'output\fixture.cancel') -Force
```

The process emits `[cancelled]`, records `status: "cancelled"`, leaves only its
partial checkpoint, and exits `130`. `SIGINT`, `SIGTERM`, and Windows `SIGBREAK`
are handled on platforms where Python exposes them.

## Automated self-test

```powershell
node --test tests\mock-runner.test.mjs
```

Set `PYTHON_BIN` when Python is not discoverable as `python`, `python3`, or
`py -3`. The test creates a private OS-temporary directory, exercises success,
failure, cancellation, allowed-root rejection, and checksum tamper rejection,
then removes only that verified temporary directory.

For backend tests, point the server's allow-listed runner path at the absolute
path to `tests/fixtures/mock_xiaohongshu_runner.py`. Keep scenario selection in
test configuration rather than adding arbitrary command execution to the API.
