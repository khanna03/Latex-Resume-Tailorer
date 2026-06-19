/**
 * Phase 3 — ATS Engine Tests
 *
 * Tests for src/ats-engine.js
 *
 * Verifies that ATS keyword scoring is deterministic, correctly computes
 * coverage percentages, outputs a valid confidence range, and surfaces the
 * correct skill gaps.
 */

import { describe, it, expect } from 'vitest';
import { computeATSScore, compareATSReports } from '../../src/ats-engine.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// A JD with known required, preferred, soft, ats keywords, and industry terms
const JD_FULL = {
  role_title: 'Backend Software Engineer',
  experience_level: 'senior',
  required_skills: ['Python', 'FastAPI', 'PostgreSQL', 'Docker'],
  preferred_skills: ['Kubernetes', 'Redis'],
  soft_skills: ['Communication', 'Leadership'],
  ats_keywords: ['Python', 'REST API', 'Microservices', 'FastAPI', 'CI/CD'],
  industry_terms: ['Backend', 'API', 'Cloud'],
  responsibilities: ['Build APIs', 'Lead team'],
};

// Resume that matches ALL required/ATS keywords
const RESUME_ALL_MATCH = `
  Python FastAPI PostgreSQL Docker Kubernetes Redis microservices REST API CI/CD
  Communication Leadership Backend API Cloud engineer
`;

// Resume that matches NOTHING from the JD
const RESUME_NO_MATCH = `
  Customer support representative. Handled phone calls and email tickets.
  Excellent interpersonal skills. Organized office supply inventory.
`;

// Resume that partially matches (only required, not ATS)
const RESUME_PARTIAL = `
  Python developer with PostgreSQL experience.
  Deployed services using Docker containers.
  Good at communication and teamwork.
`;

// ---------------------------------------------------------------------------
// Tests: computeATSScore — perfect match
// ---------------------------------------------------------------------------

describe('computeATSScore — perfect keyword match', () => {

  it('returns score = 100 when all required and ATS keywords are present', () => {
    const report = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    expect(report.score).toBe(100);
  });

  it('requiredCoverage is 100 when all required skills are present', () => {
    const report = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    expect(report.requiredCoverage).toBe(100);
  });

  it('missingRequired is empty when all required skills are found', () => {
    const report = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    expect(report.missingRequired).toHaveLength(0);
  });

  it('foundRequired contains all required skills', () => {
    const report = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    JD_FULL.required_skills.forEach(skill => {
      expect(report.foundRequired.map(s => s.toLowerCase())).toContain(skill.toLowerCase());
    });
  });

});

// ---------------------------------------------------------------------------
// Tests: computeATSScore — zero match
// ---------------------------------------------------------------------------

describe('computeATSScore — no keyword match', () => {

  it('returns a low score when no JD keywords appear in resume', () => {
    const report = computeATSScore(RESUME_NO_MATCH, JD_FULL);
    // Score should be very low — customer support keywords don't match tech JD
    expect(report.score).toBeLessThan(20);
  });

  it('missingRequired contains all required skills when resume is unrelated', () => {
    const report = computeATSScore(RESUME_NO_MATCH, JD_FULL);
    // All required skills should be missing
    JD_FULL.required_skills.forEach(skill => {
      expect(report.missingRequired.map(s => s.toLowerCase())).toContain(skill.toLowerCase());
    });
  });

  it('skillGaps is non-empty when required skills are missing', () => {
    const report = computeATSScore(RESUME_NO_MATCH, JD_FULL);
    expect(report.skillGaps.length).toBeGreaterThan(0);
  });

});

// ---------------------------------------------------------------------------
// Tests: computeATSScore — confidence range
// ---------------------------------------------------------------------------

describe('computeATSScore — confidence band', () => {

  it('scoreMin is always <= score', () => {
    const report = computeATSScore(RESUME_PARTIAL, JD_FULL);
    expect(report.scoreMin).toBeLessThanOrEqual(report.score);
  });

  it('scoreMax is always >= score', () => {
    const report = computeATSScore(RESUME_PARTIAL, JD_FULL);
    expect(report.scoreMax).toBeGreaterThanOrEqual(report.score);
  });

  it('scoreMin is never below 0', () => {
    const report = computeATSScore(RESUME_NO_MATCH, JD_FULL);
    expect(report.scoreMin).toBeGreaterThanOrEqual(0);
  });

  it('scoreMax is never above 100', () => {
    const report = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    expect(report.scoreMax).toBeLessThanOrEqual(100);
  });

  it('methodNote is a non-empty string describing scoring logic', () => {
    const report = computeATSScore(RESUME_PARTIAL, JD_FULL);
    expect(typeof report.methodNote).toBe('string');
    expect(report.methodNote.length).toBeGreaterThan(0);
    // The method note should mention keyword coverage or ATS
    expect(report.methodNote.toLowerCase()).toMatch(/keyword|ats|coverage/);
  });

});

// ---------------------------------------------------------------------------
// Tests: computeATSScore — empty JD
// ---------------------------------------------------------------------------

describe('computeATSScore — empty or minimal JD', () => {

  it('returns 100 for any resume when JD has no keywords', () => {
    const emptyJD = {
      role_title: 'Engineer',
      experience_level: 'mid',
      required_skills: [],
      preferred_skills: [],
      soft_skills: [],
      ats_keywords: [],
      industry_terms: [],
      responsibilities: [],
    };
    const report = computeATSScore(RESUME_PARTIAL, emptyJD);
    // All categories empty → all coverage 100% → composite = 100
    expect(report.score).toBe(100);
  });

});

// ---------------------------------------------------------------------------
// Tests: compareATSReports
// ---------------------------------------------------------------------------

describe('compareATSReports', () => {

  it('correctly computes a positive score delta', () => {
    const before = computeATSScore(RESUME_NO_MATCH, JD_FULL);
    const after = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    const { scoreDelta } = compareATSReports(before, after);
    expect(scoreDelta).toBeGreaterThan(0);
  });

  it('correctly computes a zero score delta for identical inputs', () => {
    const before = computeATSScore(RESUME_PARTIAL, JD_FULL);
    const after = computeATSScore(RESUME_PARTIAL, JD_FULL);
    const { scoreDelta } = compareATSReports(before, after);
    expect(scoreDelta).toBe(0);
  });

  it('newKeywordsAdded contains skills present in after but not before', () => {
    const before = computeATSScore(RESUME_NO_MATCH, JD_FULL);
    const after = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    const { newKeywordsAdded } = compareATSReports(before, after);
    expect(newKeywordsAdded.length).toBeGreaterThan(0);
  });

  it('newKeywordsAdded is empty when before and after are the same', () => {
    const before = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    const after = computeATSScore(RESUME_ALL_MATCH, JD_FULL);
    const { newKeywordsAdded } = compareATSReports(before, after);
    expect(newKeywordsAdded).toHaveLength(0);
  });

});
