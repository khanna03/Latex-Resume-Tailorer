/**
 * Round-trip test suite for the LaTeX parser + reconstruction engine.
 *
 * Build prompt Phase 1 acceptance criteria:
 * "parser round-trips at least 10 real-world resume templates — meaning
 *  parse-then-reconstruct-with-no-edits produces a .tex file that is identical
 *  to the original."
 *
 * Test strategy:
 * 1. Parse each fixture: parseLatex(rawLatex) → ast
 * 2. Reconstruct with NO modifications: reconstructLatex(ast, {}, new Set()) → reconstructed
 * 3. Assert: reconstructed === rawLatex (byte-identical)
 *
 * Note: The reconstruction engine is designed so that with an empty sectionModifications
 * map, it returns rawFull (the original string) unchanged. These tests verify that
 * invariant holds across diverse template styles.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// We import the JS source files directly (ESM)
import { parseLatex } from '../../src/latex-parser.js';
import { reconstructLatex, buildModificationMap } from '../../src/reconstruction-engine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, '../fixtures/templates');

/**
 * Load a fixture file.
 */
function loadFixture(name) {
  return readFileSync(join(FIXTURES_DIR, name), 'utf-8');
}

/**
 * Round-trip a LaTeX string: parse → reconstruct with no edits → compare.
 * Returns { passed, original, reconstructed, diffSummary }
 */
function roundTrip(rawLatex) {
  const ast = parseLatex(rawLatex);
  // Pass empty modifications and empty locked set — should produce identical output
  const reconstructed = reconstructLatex(ast, {}, new Set());
  const passed = reconstructed === rawLatex;

  let diffSummary = '';
  if (!passed) {
    // Find first difference for helpful error message
    let diffIdx = 0;
    while (diffIdx < rawLatex.length && rawLatex[diffIdx] === reconstructed[diffIdx]) {
      diffIdx++;
    }
    const ctxStart = Math.max(0, diffIdx - 40);
    const ctxEnd   = Math.min(rawLatex.length, diffIdx + 40);
    diffSummary =
      `First difference at char ${diffIdx}.\n` +
      `Original:     ...${JSON.stringify(rawLatex.substring(ctxStart, ctxEnd))}...\n` +
      `Reconstructed: ...${JSON.stringify(reconstructed.substring(ctxStart, ctxEnd))}...`;
  }

  return { passed, original: rawLatex, reconstructed, diffSummary };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('LaTeX Parser Round-Trip Tests', () => {

  it('01 — Jake\'s Resume (resumeSubheading, resumeItem, standard sections)', () => {
    const raw = loadFixture('jake_resume.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('02 — Awesome-CV (cvsection, cventry, cvevent, cvskill)', () => {
    const raw = loadFixture('awesome_cv.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('03 — ModernCV (cventry, cvitem, standard sections)', () => {
    const raw = loadFixture('moderncv.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('04 — Deedy Resume (datedsubsection, two-column layout)', () => {
    const raw = loadFixture('deedy_resume.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('05 — AltaCV (cvevent, cvsection, cvtag)', () => {
    const raw = loadFixture('altacv.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('06 — Standard Article Resume (plain \\section, nested itemize)', () => {
    const raw = loadFixture('standard_article.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('07 — Subsection Resume (\\subsection headings used for entries)', () => {
    const raw = loadFixture('subsection_resume.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('08 — Special Characters Resume (& % $ in content, LaTeX comments)', () => {
    const raw = loadFixture('special_chars_resume.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('09 — Minimal No-Sections Resume (fallback Document Body section)', () => {
    const raw = loadFixture('minimal_no_sections.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

  it('10 — Dense Multi-Section Resume (many sections, nested environments)', () => {
    const raw = loadFixture('dense_multisection.tex');
    const { passed, diffSummary } = roundTrip(raw);
    expect(passed, `Round-trip failed:\n${diffSummary}`).toBe(true);
  });

});

// ---------------------------------------------------------------------------
// Additional unit tests for parser correctness
// ---------------------------------------------------------------------------

describe('Parser — Section Detection', () => {

  it('detects standard \\section commands', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n\\section{Experience}\n\\item foo\n\\section{Education}\n\\item bar\n\\end{document}`;
    const ast = parseLatex(latex);
    expect(ast.sections).toHaveLength(2);
    expect(ast.sections[0].title).toBe('Experience');
    expect(ast.sections[1].title).toBe('Education');
  });

  it('detects \\cvsection (Awesome-CV)', () => {
    const latex = `\\documentclass{awesome-cv}\n\\begin{document}\n\\cvsection{Work Experience}\n\\item foo\n\\end{document}`;
    const ast = parseLatex(latex);
    expect(ast.sections).toHaveLength(1);
    expect(ast.sections[0].title).toBe('Work Experience');
  });

  it('detects \\datedsubsection (Deedy)', () => {
    const latex = `\\documentclass{deedy}\n\\begin{document}\n\\datedsubsection{Google}{2020--2023}\n\\item foo\n\\end{document}`;
    const ast = parseLatex(latex);
    expect(ast.sections).toHaveLength(1);
    // datedsubsection title is "Google" (first arg)
    expect(ast.sections[0].title).toBe('Google');
  });

  it('does NOT match section commands inside % comments', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n% \\section{Commented Out}\n\\section{Real Section}\n\\item real bullet\n\\end{document}`;
    const ast = parseLatex(latex);
    expect(ast.sections).toHaveLength(1);
    expect(ast.sections[0].title).toBe('Real Section');
  });

  it('falls back to Document Body when no section commands found', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n\\item just a bullet\n\\end{document}`;
    const ast = parseLatex(latex);
    expect(ast.sections).toHaveLength(1);
    expect(ast.sections[0].title).toBe('Document Body');
  });

});

describe('Parser — Bullet Extraction', () => {

  it('extracts \\item bullets with correct text', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n\\section{Experience}\n\\begin{itemize}\n\\item Built a scalable API\n\\item Deployed to AWS\n\\end{itemize}\n\\end{document}`;
    const ast = parseLatex(latex);
    expect(ast.sections[0].bullets).toHaveLength(2);
    expect(ast.sections[0].bullets[0].text).toContain('Built a scalable API');
    expect(ast.sections[0].bullets[1].text).toContain('Deployed to AWS');
  });

  it('assigns stable unique IDs to bullets', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n\\section{A}\n\\item foo\n\\item bar\n\\end{document}`;
    const ast = parseLatex(latex);
    const ids = ast.sections[0].bullets.map(b => b.id);
    expect(new Set(ids).size).toBe(ids.length); // all unique
  });

  it('stores absolute _offsetStart/_offsetEnd on bullets', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n\\section{A}\n\\item hello world\n\\end{document}`;
    const ast = parseLatex(latex);
    const bullet = ast.sections[0].bullets[0];
    expect(typeof bullet._offsetStart).toBe('number');
    expect(typeof bullet._offsetEnd).toBe('number');
    expect(bullet._offsetEnd).toBeGreaterThan(bullet._offsetStart);
    // Verify the offset actually points to the bullet in rawFull
    const slice = latex.substring(bullet._offsetStart, bullet._offsetEnd);
    expect(slice).toContain('hello world');
  });

});

describe('Reconstruction Engine — No-Edit Identity', () => {

  it('reconstructLatex with empty modifications returns original unchanged', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n\\section{Experience}\n\\item Led development of API\n\\item Reduced latency by 40\\%\n\\end{document}`;
    const ast = parseLatex(latex);
    const result = reconstructLatex(ast, {}, new Set());
    expect(result).toBe(latex);
  });

  it('only changes the specific bullet that was modified', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n\\section{Experience}\n\\item Original bullet one\n\\item Original bullet two\n\\end{document}`;
    const ast = parseLatex(latex);
    const mods = buildModificationMap([
      { id: 'section_0', bullets: ['Modified bullet one', 'Original bullet two'] }
    ]);
    const result = reconstructLatex(ast, mods, new Set());
    expect(result).toContain('Modified bullet one');
    expect(result).toContain('Original bullet two');
    expect(result).not.toContain('Original bullet one');
  });

  it('skips locked sections entirely', () => {
    const latex = `\\documentclass{article}\n\\begin{document}\n\\section{Education}\n\\item B.S. Computer Science\n\\end{document}`;
    const ast = parseLatex(latex);
    const mods = buildModificationMap([
      { id: 'section_0', bullets: ['Hacked education entry'] }
    ]);
    const lockedIds = new Set(['section_0']);
    const result = reconstructLatex(ast, mods, lockedIds);
    // Should be identical to original since the only section is locked
    expect(result).toBe(latex);
  });

});
