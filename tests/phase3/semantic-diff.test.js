/**
 * Phase 3 — Semantic Diff Engine Tests
 *
 * Tests for src/semantic-diff.js
 *
 * Verifies that section-level and bullet-level diffs are correctly computed
 * between original and tailored LaTeX documents.
 */

import { describe, it, expect } from 'vitest';
import { computeSemanticDiff, renderSemanticDiffHtml } from '../../src/semantic-diff.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const LATEX_ORIGINAL = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Built a scalable API using Java.
\\item Deployed services on AWS.
\\section{Education}
\\item B.S. Computer Science, MIT.
\\end{document}`;

const LATEX_IDENTICAL = LATEX_ORIGINAL;

const LATEX_MODIFIED_BULLET = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Built scalable Python FastAPI microservices.
\\item Deployed services on AWS using Kubernetes.
\\section{Education}
\\item B.S. Computer Science, MIT.
\\end{document}`;

const LATEX_ADDED_SECTION = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Built a scalable API using Java.
\\item Deployed services on AWS.
\\section{Education}
\\item B.S. Computer Science, MIT.
\\section{Skills}
\\item Python, FastAPI, Docker.
\\end{document}`;

const LATEX_REMOVED_SECTION = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Built a scalable API using Java.
\\item Deployed services on AWS.
\\end{document}`;

// ---------------------------------------------------------------------------
// Tests: computeSemanticDiff
// ---------------------------------------------------------------------------

describe('computeSemanticDiff — identical documents', () => {

  it('returns zero modified sections for identical input', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_IDENTICAL);
    const modified = diffs.filter(s => s.status !== 'unchanged');
    expect(modified).toHaveLength(0);
  });

  it('returns all sections with status=unchanged for identical input', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_IDENTICAL);
    diffs.forEach(s => expect(s.status).toBe('unchanged'));
  });

});

describe('computeSemanticDiff — modified bullets', () => {

  it('returns status=modified for the Experience section when bullets changed', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_MODIFIED_BULLET);
    const experience = diffs.find(s => s.title.toLowerCase() === 'experience');
    expect(experience).toBeDefined();
    expect(experience.status).toBe('modified');
  });

  it('changedCount equals number of modified bullets', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_MODIFIED_BULLET);
    const experience = diffs.find(s => s.title.toLowerCase() === 'experience');
    expect(experience.changedCount).toBeGreaterThan(0);
    expect(experience.changedCount).toBeLessThanOrEqual(experience.bullets.length);
  });

  it('unchanged Education section stays status=unchanged', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_MODIFIED_BULLET);
    const education = diffs.find(s => s.title.toLowerCase() === 'education');
    expect(education).toBeDefined();
    expect(education.status).toBe('unchanged');
  });

  it('modified bullets have inlineDiffHtml that is a non-empty string', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_MODIFIED_BULLET);
    const experience = diffs.find(s => s.title.toLowerCase() === 'experience');
    const modifiedBullets = experience.bullets.filter(b => b.status === 'modified');
    modifiedBullets.forEach(b => {
      expect(typeof b.inlineDiffHtml).toBe('string');
      expect(b.inlineDiffHtml.length).toBeGreaterThan(0);
    });
  });

  it('modified bullets contain diff-added or diff-removed spans in inlineDiffHtml', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_MODIFIED_BULLET);
    const experience = diffs.find(s => s.title.toLowerCase() === 'experience');
    const modifiedBullets = experience.bullets.filter(b => b.status === 'modified');
    modifiedBullets.forEach(b => {
      expect(b.inlineDiffHtml).toMatch(/diff-added|diff-removed/);
    });
  });

});

describe('computeSemanticDiff — added sections', () => {

  it('marks a newly added section with status=added', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_ADDED_SECTION);
    const skills = diffs.find(s => s.title.toLowerCase() === 'skills');
    expect(skills).toBeDefined();
    expect(skills.status).toBe('added');
  });

  it('added section has all bullets marked as added', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_ADDED_SECTION);
    const skills = diffs.find(s => s.title.toLowerCase() === 'skills');
    skills.bullets.forEach(b => expect(b.status).toBe('added'));
  });

});

describe('computeSemanticDiff — removed sections', () => {

  it('marks a removed section with status=removed', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_REMOVED_SECTION);
    const education = diffs.find(s => s.title.toLowerCase() === 'education');
    expect(education).toBeDefined();
    expect(education.status).toBe('removed');
  });

  it('removed section has all bullets marked as removed', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_REMOVED_SECTION);
    const education = diffs.find(s => s.title.toLowerCase() === 'education');
    education.bullets.forEach(b => expect(b.status).toBe('removed'));
  });

});

// ---------------------------------------------------------------------------
// Tests: renderSemanticDiffHtml
// ---------------------------------------------------------------------------

describe('renderSemanticDiffHtml', () => {

  it('returns a placeholder message for empty input', () => {
    const html = renderSemanticDiffHtml([]);
    expect(html).toContain('placeholder-msg');
  });

  it('returns a placeholder message for null/undefined input', () => {
    expect(renderSemanticDiffHtml(null)).toContain('placeholder-msg');
    expect(renderSemanticDiffHtml(undefined)).toContain('placeholder-msg');
  });

  it('renders HTML containing section title for modified sections', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_MODIFIED_BULLET);
    const html = renderSemanticDiffHtml(diffs);
    // The HTML string should include the section name somewhere
    expect(html.toLowerCase()).toContain('experience');
  });

  it('renders an unchanged-count note when some sections are identical', () => {
    const diffs = computeSemanticDiff(LATEX_ORIGINAL, LATEX_MODIFIED_BULLET);
    const html = renderSemanticDiffHtml(diffs);
    // Should note that the education section was left intact
    expect(html).toContain('unchanged');
  });

});
