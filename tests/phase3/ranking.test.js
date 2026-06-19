/**
 * Phase 3 — Candidate Ranking Pipeline Tests
 *
 * Tests for src/ranking-pipeline.js
 *
 * Verifies that the multi-generation candidate scoring and ranking produces
 * deterministic, correctly ordered results based on the weighted ATS composite.
 */

import { describe, it, expect } from 'vitest';
import { rankCandidates, pickBest } from '../../src/ranking-pipeline.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A JD analysis fixture with a clear set of required/ATS keywords
const JD_ANALYSIS = {
  role_title: 'Software Engineer',
  experience_level: 'mid',
  required_skills: ['Python', 'FastAPI', 'PostgreSQL'],
  preferred_skills: ['Docker', 'Kubernetes'],
  soft_skills: ['Communication', 'Teamwork'],
  ats_keywords: ['Python', 'REST API', 'Microservices', 'FastAPI'],
  industry_terms: ['Backend', 'API'],
  responsibilities: ['Build scalable APIs', 'Write unit tests'],
};

// Original LaTeX (minimal fixture)
const ORIGINAL_LATEX = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Built internal tools using Java and Spring.
\\item Deployed services on AWS.
\\end{document}`;

// Candidate with HIGH ATS keyword match — has Python, FastAPI, PostgreSQL, REST API, Microservices
const HIGH_ATS_LATEX = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Built scalable Python FastAPI microservices with PostgreSQL and Redis.
\\item Designed REST API endpoints for high-traffic backend systems.
\\end{document}`;

// Candidate with LOW ATS keyword match — very similar to original
const LOW_ATS_LATEX = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Built internal tools using Java and Spring Boot.
\\item Deployed services on AWS EC2.
\\end{document}`;

// Candidate with MODERATE ATS keyword match
const MEDIUM_ATS_LATEX = `\\documentclass{article}
\\begin{document}
\\section{Experience}
\\item Developed Python backend services with PostgreSQL for data storage.
\\item Deployed on AWS using Docker containers.
\\end{document}`;

// ---------------------------------------------------------------------------
// Tests: rankCandidates
// ---------------------------------------------------------------------------

describe('rankCandidates — ordering', () => {

  it('returns an array with the same number of valid candidates provided', () => {
    const candidates = [
      { mode: 'conservative', latex: LOW_ATS_LATEX },
      { mode: 'moderate', latex: MEDIUM_ATS_LATEX },
      { mode: 'aggressive', latex: HIGH_ATS_LATEX },
    ];
    const ranked = rankCandidates(ORIGINAL_LATEX, candidates, JD_ANALYSIS);
    expect(ranked).toHaveLength(3);
  });

  it('places the high ATS candidate first', () => {
    const candidates = [
      { mode: 'conservative', latex: LOW_ATS_LATEX },
      { mode: 'moderate', latex: MEDIUM_ATS_LATEX },
      { mode: 'aggressive', latex: HIGH_ATS_LATEX },
    ];
    const ranked = rankCandidates(ORIGINAL_LATEX, candidates, JD_ANALYSIS);
    expect(ranked[0].mode).toBe('aggressive');
  });

  it('ranks candidates in strictly descending order by totalScore', () => {
    const candidates = [
      { mode: 'conservative', latex: LOW_ATS_LATEX },
      { mode: 'moderate', latex: MEDIUM_ATS_LATEX },
      { mode: 'aggressive', latex: HIGH_ATS_LATEX },
    ];
    const ranked = rankCandidates(ORIGINAL_LATEX, candidates, JD_ANALYSIS);
    for (let i = 0; i < ranked.length - 1; i++) {
      expect(ranked[i].totalScore).toBeGreaterThanOrEqual(ranked[i + 1].totalScore);
    }
  });

  it('each scored candidate has all required score fields', () => {
    const candidates = [
      { mode: 'moderate', latex: MEDIUM_ATS_LATEX },
    ];
    const ranked = rankCandidates(ORIGINAL_LATEX, candidates, JD_ANALYSIS);
    const c = ranked[0];
    expect(c).toHaveProperty('totalScore');
    expect(c).toHaveProperty('atsScore');
    expect(c).toHaveProperty('preservationScore');
    expect(c).toHaveProperty('changeCount');
    expect(c).toHaveProperty('changesScore');
    expect(c).toHaveProperty('atsReport');
    expect(c).toHaveProperty('mode');
    expect(c).toHaveProperty('latex');
  });

  it('scores are in valid 0–100 range', () => {
    const candidates = [
      { mode: 'conservative', latex: LOW_ATS_LATEX },
      { mode: 'aggressive', latex: HIGH_ATS_LATEX },
    ];
    const ranked = rankCandidates(ORIGINAL_LATEX, candidates, JD_ANALYSIS);
    ranked.forEach(c => {
      expect(c.totalScore).toBeGreaterThanOrEqual(0);
      expect(c.totalScore).toBeLessThanOrEqual(100);
      expect(c.atsScore).toBeGreaterThanOrEqual(0);
      expect(c.atsScore).toBeLessThanOrEqual(100);
      expect(c.preservationScore).toBeGreaterThanOrEqual(0);
      expect(c.preservationScore).toBeLessThanOrEqual(100);
    });
  });

  it('filters out null or missing-latex candidates gracefully', () => {
    const candidates = [
      null,
      { mode: 'conservative', latex: '' },
      { mode: 'moderate', latex: MEDIUM_ATS_LATEX },
    ];
    const ranked = rankCandidates(ORIGINAL_LATEX, candidates, JD_ANALYSIS);
    // Only the valid moderate candidate should survive
    expect(ranked).toHaveLength(1);
    expect(ranked[0].mode).toBe('moderate');
  });

  it('returns empty array when all candidates are invalid', () => {
    const ranked = rankCandidates(ORIGINAL_LATEX, [null, { mode: 'x', latex: '' }], JD_ANALYSIS);
    expect(ranked).toHaveLength(0);
  });

});

// ---------------------------------------------------------------------------
// Tests: pickBest
// ---------------------------------------------------------------------------

describe('pickBest', () => {

  it('returns the first element of a ranked list', () => {
    const candidates = [
      { mode: 'conservative', latex: LOW_ATS_LATEX },
      { mode: 'aggressive', latex: HIGH_ATS_LATEX },
    ];
    const ranked = rankCandidates(ORIGINAL_LATEX, candidates, JD_ANALYSIS);
    const best = pickBest(ranked);
    expect(best).toBe(ranked[0]);
  });

  it('returns null for an empty list', () => {
    expect(pickBest([])).toBeNull();
  });

  it('returns null for an undefined input', () => {
    expect(pickBest(undefined)).toBeNull();
  });

});
