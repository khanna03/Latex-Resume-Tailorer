/**
 * Phase 3 — Protected Sections (Locked Section Enforcement) Tests
 *
 * Tests for src/reconstruction-engine.js — locked section behavior.
 *
 * Verifies that sections marked as locked are not modified by the reconstruction
 * engine, even when a modification map is provided that targets them.
 */

import { describe, it, expect } from 'vitest';
import { reconstructLatex, buildModificationMap, validateLockedSections } from '../../src/reconstruction-engine.js';
import { parseLatex } from '../../src/latex-parser.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LATEX_TWO_SECTIONS = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Developed REST APIs in Java.
\\item Deployed on AWS EC2.
\\section{Education}
\\item B.S. Computer Science, MIT.
\\end{document}`;

const LATEX_THREE_SECTIONS = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Built Java microservices.
\\item Deployed on AWS.
\\section{Education}
\\item M.S. Computer Science, Stanford.
\\section{Skills}
\\item Java, Python, Docker.
\\end{document}`;

// ---------------------------------------------------------------------------
// Tests: reconstructLatex — locked section prevention
// ---------------------------------------------------------------------------

describe('reconstructLatex — locked sections are not modified', () => {

  it('locked section bullet is NOT changed even when mod map targets it', () => {
    const ast = parseLatex(LATEX_TWO_SECTIONS);
    const educationId = ast.sections.find(s => s.title.toLowerCase() === 'education').id;

    const mods = buildModificationMap([
      { id: educationId, bullets: ['Hacked education entry'] }
    ]);
    const locked = new Set([educationId]);
    const result = reconstructLatex(ast, mods, locked);

    expect(result).toContain('B.S. Computer Science, MIT');
    expect(result).not.toContain('Hacked education entry');
  });

  it('unlocked section IS changed when mod map targets it', () => {
    const ast = parseLatex(LATEX_TWO_SECTIONS);
    const experienceId = ast.sections.find(s => s.title.toLowerCase() === 'experience').id;

    const mods = buildModificationMap([
      { id: experienceId, bullets: ['Built Python FastAPI microservices.', 'Deployed on Kubernetes.'] }
    ]);
    const result = reconstructLatex(ast, mods, new Set());

    expect(result).toContain('Python FastAPI microservices');
    expect(result).not.toContain('Developed REST APIs in Java');
  });

  it('mixed sections: locked one preserved, unlocked one changed', () => {
    const ast = parseLatex(LATEX_THREE_SECTIONS);
    const educationId = ast.sections.find(s => s.title.toLowerCase() === 'education').id;
    const experienceId = ast.sections.find(s => s.title.toLowerCase() === 'experience').id;

    const mods = buildModificationMap([
      { id: educationId, bullets: ['Hacked education'] },
      { id: experienceId, bullets: ['Led Python backend team.', 'Used Docker and Kubernetes.'] },
    ]);
    const locked = new Set([educationId]);
    const result = reconstructLatex(ast, mods, locked);

    // Education should be unchanged (locked)
    expect(result).toContain('M.S. Computer Science, Stanford');
    expect(result).not.toContain('Hacked education');

    // Experience should be changed (unlocked)
    expect(result).toContain('Led Python backend team');
  });

  it('locking all sections produces identical output to original', () => {
    const ast = parseLatex(LATEX_TWO_SECTIONS);
    const allIds = new Set(ast.sections.map(s => s.id));

    const mods = buildModificationMap(ast.sections.map(s => ({
      id: s.id,
      bullets: s.bullets.map(() => 'OVERRIDDEN CONTENT')
    })));

    const result = reconstructLatex(ast, mods, allIds);
    expect(result).toBe(LATEX_TWO_SECTIONS);
  });

  it('empty locked set allows all modifications', () => {
    const ast = parseLatex(LATEX_TWO_SECTIONS);
    const educationId = ast.sections.find(s => s.title.toLowerCase() === 'education').id;

    const mods = buildModificationMap([
      { id: educationId, bullets: ['Modified education entry'] }
    ]);
    const result = reconstructLatex(ast, mods, new Set());
    expect(result).toContain('Modified education entry');
  });

});

// ---------------------------------------------------------------------------
// Tests: validateLockedSections — reversion enforcement
// ---------------------------------------------------------------------------

describe('validateLockedSections — content reversion', () => {

  it('returns the same LaTeX if no sections are locked', () => {
    const ast = parseLatex(LATEX_TWO_SECTIONS);
    const { latex: result, reverted } = validateLockedSections(ast, LATEX_TWO_SECTIONS, new Set());
    expect(result).toBe(LATEX_TWO_SECTIONS);
    expect(reverted).toHaveLength(0);
  });

  it('reverts locked section content if AI modified it in the tailored LaTeX', () => {
    const ast = parseLatex(LATEX_TWO_SECTIONS);
    const educationId = ast.sections.find(s => s.title.toLowerCase() === 'education').id;

    // Simulate the AI having modified the Education section
    const tampered = LATEX_TWO_SECTIONS.replace(
      'B.S. Computer Science, MIT.',
      'Ph.D. Computer Science, Harvard.'
    );
    const { latex: result, reverted } = validateLockedSections(ast, tampered, new Set([educationId]));
    // Original content should be restored
    expect(result).toContain('B.S. Computer Science, MIT');
    expect(result).not.toContain('Ph.D. Computer Science, Harvard');
    expect(reverted).toContain(educationId);
  });

  it('does not revert unlocked sections even if content drifts', () => {
    const ast = parseLatex(LATEX_TWO_SECTIONS);
    const educationId = ast.sections.find(s => s.title.toLowerCase() === 'education').id;

    const modified = LATEX_TWO_SECTIONS.replace(
      'Developed REST APIs in Java.',
      'Built Python FastAPI microservices.'
    );
    // Lock only Education, not Experience
    const { latex: result } = validateLockedSections(ast, modified, new Set([educationId]));
    // Experience change should remain
    expect(result).toContain('Python FastAPI microservices');
  });

});
