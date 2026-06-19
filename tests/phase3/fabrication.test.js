/**
 * Phase 3 — Fabrication Check Tests
 *
 * Tests for src/fabrication-check.js
 *
 * Verifies that the deterministic NER post-generation check correctly identifies
 * tech terms, metric claims, and proper nouns that appear in the AI output but
 * did NOT exist in the original source resume.
 */

import { describe, it, expect } from 'vitest';
import { checkFabrication } from '../../src/fabrication-check.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORIGINAL_WITH_PYTHON = `
  Led development of Python-based microservices architecture.
  Worked with PostgreSQL and Redis for caching.
  Improved team velocity by 20% over 6 months.
  Collaborated with Google team on cloud integrations.
`;

const TAILORED_SAME = `
  Led development of Python-based microservices architecture.
  Worked with PostgreSQL and Redis for caching.
  Improved team velocity by 20% over 6 months.
  Collaborated with Google team on cloud integrations.
`;

const TAILORED_NEW_TECH = `
  Led development of Python and Kubernetes-based microservices architecture.
  Worked with PostgreSQL, Redis, and Kafka for caching and messaging.
  Improved team velocity by 20% over 6 months.
  Collaborated with Google team on cloud integrations.
`;

const TAILORED_NEW_METRIC = `
  Led development of Python-based microservices architecture.
  Worked with PostgreSQL and Redis for caching.
  Reduced latency by 3x and improved team velocity by 20% over 6 months.
  Collaborated with Google team on cloud integrations.
`;

const TAILORED_NEW_PROPER_NOUN = `
  Led development of Python-based microservices architecture.
  Worked with PostgreSQL and Redis for caching.
  Improved team velocity by 20% over 6 months.
  Collaborated with Google and Amazon Web Services team.
`;

// ---------------------------------------------------------------------------
// Tests: hasFabrication = false (no new entities)
// ---------------------------------------------------------------------------

describe('checkFabrication — no fabrication', () => {

  it('returns hasFabrication=false when original and generated are identical', () => {
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_SAME);
    expect(result.hasFabrication).toBe(false);
    expect(result.flagged).toHaveLength(0);
  });

  it('returns hasFabrication=false for empty inputs', () => {
    const result = checkFabrication('', '');
    expect(result.hasFabrication).toBe(false);
  });

  it('does NOT flag a tech term that already exists in the original', () => {
    // Python and PostgreSQL are in the original — should not be flagged
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_SAME);
    const techFlags = result.flagged.filter(f => f.type === 'tech');
    expect(techFlags.every(f => !['python', 'postgresql', 'redis'].includes(f.entity))).toBe(true);
  });

  it('does NOT flag a metric that already appears in the original', () => {
    // "20%" is in both original and tailored
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_SAME);
    const metricFlags = result.flagged.filter(f => f.type === 'metric');
    expect(metricFlags.find(f => f.entity === '20%')).toBeUndefined();
  });

});

// ---------------------------------------------------------------------------
// Tests: hasFabrication = true (new entities found)
// ---------------------------------------------------------------------------

describe('checkFabrication — fabrication detected', () => {

  it('flags a new tech term (Kubernetes) not in the original', () => {
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_NEW_TECH);
    expect(result.hasFabrication).toBe(true);
    const flaggedEntities = result.flagged.map(f => f.entity.toLowerCase());
    expect(flaggedEntities).toContain('kubernetes');
  });

  it('flags a new metric claim (3x) not in the original', () => {
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_NEW_METRIC);
    expect(result.hasFabrication).toBe(true);
    const metricFlags = result.flagged.filter(f => f.type === 'metric');
    expect(metricFlags.length).toBeGreaterThan(0);
    expect(metricFlags.some(f => f.entity.toLowerCase().includes('3x'))).toBe(true);
  });

  it('includes context snippet around the flagged entity', () => {
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_NEW_TECH);
    const kubFlag = result.flagged.find(f => f.entity.toLowerCase() === 'kubernetes');
    expect(kubFlag).toBeDefined();
    expect(typeof kubFlag.context).toBe('string');
    expect(kubFlag.context.length).toBeGreaterThan(0);
  });

  it('reports a human-readable summary when fabrication is found', () => {
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_NEW_TECH);
    expect(result.summary).toContain('fabrication');
  });

  it('each flagged item has entity, type, and context fields', () => {
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_NEW_TECH);
    result.flagged.forEach(flag => {
      expect(flag).toHaveProperty('entity');
      expect(flag).toHaveProperty('type');
      expect(flag).toHaveProperty('context');
      expect(['tech', 'metric', 'proper_noun']).toContain(flag.type);
    });
  });

});

// ---------------------------------------------------------------------------
// Tests: proper noun detection
// ---------------------------------------------------------------------------

describe('checkFabrication — proper noun detection', () => {

  it('flags a multi-word proper noun not in the original', () => {
    // "Amazon Web Services" is not in original (only "Google" is)
    const result = checkFabrication(ORIGINAL_WITH_PYTHON, TAILORED_NEW_PROPER_NOUN);
    const nounFlags = result.flagged.filter(f => f.type === 'proper_noun');
    const nounEntities = nounFlags.map(f => f.entity.toLowerCase());
    expect(nounEntities.some(e => e.includes('amazon'))).toBe(true);
  });

});
