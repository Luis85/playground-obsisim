import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'check-quality.mjs');

interface FileScore {
  path: string;
  maintainability_index: number;
}

/** Minimal stand-in for the slice of `fallow --format json` the gate reads. */
function report(fileScores: FileScore[], overrides: Record<string, number> = {}) {
  return {
    check: {
      summary: {
        total_issues: overrides.deadCodeIssues ?? 0,
        circular_dependencies: overrides.circularDependencies ?? 0,
        re_export_cycles: overrides.reExportCycles ?? 0,
        boundary_violations: overrides.boundaryViolations ?? 0,
      },
    },
    dupes: { stats: { clone_groups: overrides.cloneGroups ?? 0, duplicated_lines: overrides.duplicatedLines ?? 0 } },
    health: {
      summary: {
        functions_above_threshold: overrides.complexFunctions ?? 0,
        severity_critical_count: overrides.criticalComplexity ?? 0,
      },
      file_scores: fileScores,
    },
  };
}

/** The shape of the repo today: two src files, one of them the worst at 82.1. */
const SRC = [
  { path: 'src/app/views/WorldView.vue', maintainability_index: 82.1 },
  { path: 'src/engine/world.ts', maintainability_index: 82.5 },
  { path: 'src/shared/haul.ts', maintainability_index: 95.0 },
];
const TESTS = [{ path: 'tests/engine/content.test.ts', maintainability_index: 85.0 }];
const SCRIPTS = [{ path: 'scripts/check-loc.mjs', maintainability_index: 96.4 }];

const BASELINE = {
  deadCodeIssues: 0,
  circularDependencies: 0,
  reExportCycles: 0,
  boundaryViolations: 0,
  cloneGroups: 0,
  duplicatedLines: 0,
  complexFunctions: 0,
  criticalComplexity: 0,
  worstSrcFileMaintainability: 82.1,
  reported: { srcMean: 89.87, testsMean: 85.0, overallMean: 88.2 },
};

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'obsisim-gate-'));
  mkdirSync(join(dir, 'scripts'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(
  fileScores: FileScore[],
  opts: { overrides?: Record<string, number>; baseline?: unknown; args?: string[]; skipBaseline?: boolean } = {},
) {
  writeFileSync(join(dir, 'reports.json'), JSON.stringify(report(fileScores, opts.overrides ?? {})));
  if (!opts.skipBaseline) {
    writeFileSync(join(dir, 'scripts', 'quality-baseline.json'), JSON.stringify(opts.baseline ?? BASELINE, null, 2));
  }
  const result = spawnSync('node', [GATE, ...(opts.args ?? [])], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, FALLOW_REPORT_JSON: join(dir, 'reports.json') },
  });
  return { code: result.status, out: result.stdout ?? '', err: result.stderr ?? '' };
}

const lockedBaseline = () => JSON.parse(readFileSync(join(dir, 'scripts', 'quality-baseline.json'), 'utf8'));

describe('check:quality maintainability floor', () => {
  it('passes when nothing moved', () => {
    const { code, out } = run([...SRC, ...TESTS, ...SCRIPTS]);
    expect(code).toBe(0);
    expect(out).toContain('quality ratchet ok');
  });

  it('fails when the worst src file rots below the floor', () => {
    const rotted = SRC.map((f) => (f.path.endsWith('WorldView.vue') ? { ...f, maintainability_index: 81.9 } : f));
    const { code, err } = run([...rotted, ...TESTS, ...SCRIPTS]);
    expect(code).toBe(1);
    expect(err).toContain('worstSrcFileMaintainability: 82.1 -> 81.9');
    expect(err).toContain('src/app/views/WorldView.vue');
  });

  it('fails when a newly added src file lands below the floor', () => {
    const withNew = [...SRC, { path: 'src/engine/systems/new-system.ts', maintainability_index: 80.4 }];
    const { code, err } = run([...withNew, ...TESTS, ...SCRIPTS]);
    expect(code).toBe(1);
    expect(err).toContain('src/engine/systems/new-system.ts');
  });

  // OBS-4-01: the old gate floored a mean over every analysed file, so an
  // increment that added tests dropped it and went red on its own test suite.
  it('does not move when an increment adds many below-mean test files', () => {
    const manyTests = Array.from({ length: 20 }, (_, i) => ({
      path: `tests/engine/added-${i}.test.ts`,
      maintainability_index: 86.0,
    }));
    const { code, out } = run([...SRC, ...TESTS, ...manyTests, ...SCRIPTS]);
    expect(code).toBe(0);
    expect(out).toContain('quality ratchet ok');
  });

  // Pins the population: the floor is over src/, not over every analysed file.
  // A dense table-driven test can score below the worst source file without
  // that being a statement about the source code's maintainability.
  it('ignores a test file that scores below the src floor', () => {
    const denseTest = [...TESTS, { path: 'tests/engine/table-driven.test.ts', maintainability_index: 74.0 }];
    const { code, out } = run([...SRC, ...denseTest, ...SCRIPTS]);
    expect(code).toBe(0);
    expect(out).toContain('worst src/ file is 82.1');
  });

  // The other half of OBS-4-01: extracting a module used to add a below-average
  // file to the mean and drop the gate, penalising decomposition.
  it('does not move when a src module is extracted above the floor', () => {
    const extracted = [...SRC, { path: 'src/engine/save-guard.ts', maintainability_index: 88.0 }];
    const { code, out } = run([...extracted, ...TESTS, ...SCRIPTS]);
    expect(code).toBe(0);
    expect(out).toContain('quality ratchet ok');
  });

  it('reports a five-point drop in the src mean without failing on it', () => {
    const drifted = SRC.map((f) => (f.path.endsWith('haul.ts') ? { ...f, maintainability_index: 90.0 } : f));
    const { code, out } = run([...drifted, ...TESTS, ...SCRIPTS]);
    expect(code).toBe(0);
    // 89.87 -> 84.87: visible in the output, deliberately not a gate.
    expect(out).toContain('src mean 84.87 (was 89.87)');
    expect(out).toContain('not gated');
  });

  it('fails rather than passing vacuously when no src files are analysed', () => {
    const { code, err } = run([...TESTS, ...SCRIPTS]);
    expect(code).toBe(1);
    expect(err).toContain('pass vacuously');
  });

  it('fails when the baseline carries a key the gate no longer reads', () => {
    const stale = { ...BASELINE, maintainability: 90.5 };
    const { code, err } = run([...SRC, ...TESTS, ...SCRIPTS], { baseline: stale });
    expect(code).toBe(1);
    expect(err).toContain('does not read: maintainability');
  });

  it('fails when the baseline is missing a gated key', () => {
    const partial = { ...BASELINE };
    delete (partial as Partial<typeof BASELINE>).worstSrcFileMaintainability;
    const { code, err } = run([...SRC, ...TESTS, ...SCRIPTS], { baseline: partial });
    expect(code).toBe(1);
    expect(err).toContain('missing gated entries: worstSrcFileMaintainability');
  });

  // Coverage for the normal run path (no --update): the pinned-at-zero counters
  // only had coverage via `--update`'s refusal-to-lock branch, so a mutation
  // that dropped pinnedBreaches from the plain gate's `failures` list left
  // circularDependencies / reExportCycles / boundaryViolations /
  // criticalComplexity entirely ungated here and every existing test stayed
  // green.
  it('fails on the normal run when a pinned-at-zero key is breached', () => {
    const { code, err } = run([...SRC, ...TESTS, ...SCRIPTS], { overrides: { boundaryViolations: 3 } });
    expect(code).toBe(1);
    expect(err).toContain('boundaryViolations: 3');
    expect(err).toContain('pinned at 0');
  });
});

describe('check:quality --update', () => {
  it('refuses to lock a regression, leaving the baseline untouched', () => {
    const { code, err } = run([...SRC, ...TESTS, ...SCRIPTS], {
      overrides: { complexFunctions: 1 },
      args: ['--update'],
    });
    expect(code).toBe(1);
    expect(err).toContain('loosens the ratchet');
    expect(lockedBaseline().complexFunctions).toBe(0);
  });

  it('locks a regression when --allow-regression is passed explicitly', () => {
    const { code } = run([...SRC, ...TESTS, ...SCRIPTS], {
      overrides: { complexFunctions: 1 },
      args: ['--update', '--allow-regression'],
    });
    expect(code).toBe(0);
    expect(lockedBaseline().complexFunctions).toBe(1);
  });

  it('refuses a pinned-at-zero breach even with --allow-regression', () => {
    const { code, err } = run([...SRC, ...TESTS, ...SCRIPTS], {
      overrides: { criticalComplexity: 2 },
      args: ['--update', '--allow-regression'],
    });
    expect(code).toBe(1);
    expect(err).toContain('pinned-at-zero');
    expect(lockedBaseline().criticalComplexity).toBe(0);
  });

  it('locks an improvement and records the reported means', () => {
    const better = SRC.map((f) => (f.path.endsWith('WorldView.vue') ? { ...f, maintainability_index: 84.0 } : f));
    const { code } = run([...better, ...TESTS, ...SCRIPTS], { args: ['--update'] });
    expect(code).toBe(0);
    const locked = lockedBaseline();
    expect(locked.worstSrcFileMaintainability).toBe(82.5);
    expect(locked.reported.srcMean).toBeCloseTo(87.17, 2);
  });

  // A baseline missing a gated key poisons every comparison against it with
  // undefined (current[key] > undefined and current[key] < undefined are both
  // false), so --update would otherwise see no regression and silently re-lock
  // whatever the current number is — defeating the ratchet with no
  // --allow-regression in sight. Refuse instead, same as a plain run would.
  it('refuses to re-lock a baseline missing a gated key, leaving the file unchanged', () => {
    const partial = { ...BASELINE };
    delete (partial as Partial<typeof BASELINE>).complexFunctions;
    const { code, err } = run([...SRC, ...TESTS, ...SCRIPTS], {
      baseline: partial,
      args: ['--update'],
    });
    expect(code).toBe(1);
    expect(err).toContain('missing gated entries: complexFunctions');
    // The property that matters: the file on disk was never touched.
    expect(lockedBaseline()).toEqual(partial);
  });

  it('re-locks a baseline missing a gated key when --allow-regression is passed', () => {
    const partial = { ...BASELINE };
    delete (partial as Partial<typeof BASELINE>).complexFunctions;
    const { code } = run([...SRC, ...TESTS, ...SCRIPTS], {
      baseline: partial,
      args: ['--update', '--allow-regression'],
    });
    expect(code).toBe(0);
    expect(lockedBaseline().complexFunctions).toBe(0);
  });

  // Same malformed-baseline refusal applies to a stale key the gate no longer
  // reads, not just a missing one — --update should not silently drop it
  // without the operator acknowledging the baseline was off.
  it('refuses to re-lock a baseline with a key the gate does not read', () => {
    const stale = { ...BASELINE, maintainability: 90.5 };
    const { code, err } = run([...SRC, ...TESTS, ...SCRIPTS], {
      baseline: stale,
      args: ['--update'],
    });
    expect(code).toBe(1);
    expect(err).toContain('does not read: maintainability');
    expect(lockedBaseline()).toEqual(stale);
  });

  // Guards the first-lock path: with no baseline file at all, hasBaseline is
  // false, schemaErrors stays empty, and --update must still be able to
  // create one from nothing.
  it('still succeeds on the very first --update, when no baseline file exists yet', () => {
    const { code, out } = run([...SRC, ...TESTS, ...SCRIPTS], {
      args: ['--update'],
      skipBaseline: true,
    });
    expect(code).toBe(0);
    expect(out).toContain('quality baseline locked');
    expect(lockedBaseline().worstSrcFileMaintainability).toBe(82.1);
  });
});
