import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { run } from '../src/cli.js';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function cli(...argv: string[]) {
  let stdout = '';
  let stderr = '';
  const code = run(argv, { stdout: (s) => (stdout += s), stderr: (s) => (stderr += s), cwd: fixtures });
  return { code, stdout, stderr };
}

describe('ai-cost-meter price', () => {
  it('prints a breakdown and the total', () => {
    const r = cli('price', 'claude-sonnet-4-6', '--in', '1200', '--out', '300', '--cached', '5,000', '--date', '2026-10-16');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('anthropic/claude-sonnet-4-6  (2026-10-16, standard rates)');
    expect(r.stdout).toMatch(/input\s+1,200 tokens\s+x \$3\/MTok\s+= \$0\.003600/);
    expect(r.stdout).toMatch(/cached input\s+5,000 tokens\s+x \$0\.3\/MTok\s+= \$0\.001500/);
    expect(r.stdout).toMatch(/total\s+\$0\.009600/);
    expect(r.stdout).toContain('source: https://platform.claude.com/docs/en/about-claude/pricing');
    expect(r.stdout).toContain('your invoice may differ');
  });

  it('prints JSON with batch, tier and date applied', () => {
    const r = cli('price', 'gemini-2.5-pro', '--in', '250000', '--out', '1000', '--batch', '--date', '2026-10-16', '-f', 'json');
    expect(r.code).toBe(0);
    const j = JSON.parse(r.stdout);
    expect(j).toMatchObject({ date: '2026-10-16', provider: 'google-gemini-api', model: 'gemini-2.5-pro' });
    expect(j.costUsd).toBeCloseTo(0.32, 12);
    expect(j.breakdown).toMatchObject({ batch: true, tierAboveInputTokens: 200000 });
    expect(j.notes).toContain('200k');
  });

  it('uses announced prices on and after their date', () => {
    const r = cli('price', 'gemini-3.8-flash', '--in', '1000000', '--date', '2027-01-01', '-f', 'json');
    expect(JSON.parse(r.stdout).costUsd).toBeCloseTo(1.5, 12);
  });

  it('exits 1 for an unknown model and suggests close IDs', () => {
    const r = cli('price', 'gpt-4', '--in', '10');
    expect(r.code).toBe(1);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('no price for model "gpt-4"');
    expect(r.stderr).toContain('gpt-4.1');
    const j = cli('price', 'gpt-4', '-f', 'json');
    expect(j.code).toBe(1);
    expect(JSON.parse(j.stdout).costUsd).toBeNull();
  });

  it('exits 1 when the mode has no listed price', () => {
    const r = cli('price', 'gpt-3.5-turbo', '--in', '10', '--batch');
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('no batch price is listed');
  });

  it('reads custom prices', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-cost-meter-cli-'));
    try {
      const file = join(dir, 'prices.json');
      writeFileSync(file, JSON.stringify({ prices: [{ provider: 'local', model: 'my-model', input_per_mtok: 2, output_per_mtok: 4 }] }));
      const r = cli('price', 'my-model', '--in', '1000000', '--prices', file, '--no-default-prices', '-f', 'json');
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).costUsd).toBe(2);
      expect(cli('price', 'gpt-5', '--prices', file, '--no-default-prices').code).toBe(1);
      writeFileSync(file, '{"prices": [{"provider": "x"}]}');
      expect(cli('price', 'gpt-5', '--prices', file).code).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 2 on usage errors', () => {
    expect(cli('price').code).toBe(2);
    expect(cli('price', 'gpt-5', '--in', '1.5').stderr).toContain('whole number');
    expect(cli('price', 'gpt-5', '--date', '2026-02-30').stderr).toContain('YYYY-MM-DD');
    expect(cli('price', 'gpt-5', '--bogus').code).toBe(2);
    expect(cli('price', 'gpt-5', '-f', 'xml').code).toBe(2);
    expect(cli('nope').stderr).toContain('unknown command');
    expect(cli('price', 'gpt-5', '--no-default-prices').code).toBe(2);
  });
});

describe('ai-cost-meter report', () => {
  it('summarizes a log by model, flagging calls without a price', () => {
    const r = cli('report', 'calls.jsonl');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('calls.jsonl: 5 calls, $0.035050 total, 1 without a price (not in the total)');
    const lines = r.stdout.split('\n');
    expect(lines[2]).toMatch(/^\s+COST\s+CALLS\s+INPUT\s+CACHED\s+OUTPUT\s+MODEL$/);
    expect(lines[3]).toMatch(/^\s+\$0\.027975\s+2\s+18,298\s+15,000\s+803\s+anthropic\/claude-sonnet-4-6$/);
    expect(r.stdout).toMatch(/\$0\.000000\*\s+1\s+800\s+0\s+100\s+my-finetune/);
  });

  it('groups by tag prefix and by day, and filters by date (until is inclusive)', () => {
    const tag = JSON.parse(cli('report', 'calls.jsonl', '--group-by', 'tag', '--tag-prefix', 'feature:', '-f', 'json').stdout);
    expect(tag.groups.map((g: { key: string; calls: number }) => [g.key, g.calls])).toEqual([
      ['feature:summarize', 2],
      ['feature:search', 2],
      ['(untagged)', 1],
    ]);
    const day = JSON.parse(cli('report', 'calls.jsonl', '--group-by', 'day', '--since', '2026-10-15', '--until', '2026-10-15', '-f', 'json').stdout);
    expect(day.groups.map((g: { key: string }) => g.key)).toEqual(['2026-10-15']);
    expect(day.calls).toBe(2);
    expect(cli('report', 'calls.jsonl', '--group-by', 'tag').stdout).toContain('counted in each of its groups');
  });

  it('exits 2 for a missing file or a bad option', () => {
    expect(cli('report', 'missing.jsonl').stderr).toContain('cannot read log file');
    expect(cli('report').code).toBe(2);
    expect(cli('report', 'calls.jsonl', '--group-by', 'week').code).toBe(2);
  });
});

describe('ai-cost-meter models, --help and --version', () => {
  it('lists models, optionally for one provider', () => {
    const r = cli('models', '--provider', 'anthropic');
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/anthropic\/claude-haiku-5-5\s+in \$0\.1\/MTok\s+out \$0\.5\/MTok\s+cached \$0\.01\/MTok\s+tiered batch/);
    expect(r.stdout).not.toContain('openai/');
    expect(JSON.parse(cli('models', '-f', 'json').stdout).prices.length).toBeGreaterThan(50);
    expect(cli('models', '--provider', 'acme').stderr).toContain('Known: anthropic, google-gemini-api, openai');
  });

  it('prints help and the version', () => {
    expect(cli('--help').stdout).toContain('ai-cost-meter price <model>');
    expect(cli('--version').stdout).toMatch(/^\d+\.\d+\.\d+\n$/);
    expect(cli().code).toBe(2);
  });
});
