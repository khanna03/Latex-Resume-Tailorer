/**
 * Deterministic LaTeX Validator
 *
 * Validates LaTeX structure without any AI calls.
 * Returns a structured error report with line numbers.
 * Used before AND after AI processing to gate the repair loop.
 */

/**
 * @typedef {Object} ValidationError
 * @property {string} type - "brace" | "environment" | "special_char" | "structure" | "markdown"
 * @property {string} message - Human-readable description
 * @property {number} [line] - 1-indexed line number where error was detected
 * @property {string} [context] - Snippet of surrounding text
 */

/**
 * @typedef {Object} ValidationResult
 * @property {boolean} valid - True if no errors found
 * @property {ValidationError[]} errors
 * @property {string} summary - Short summary string
 */

/**
 * Check that all curly braces are balanced.
 * @param {string[]} lines
 * @returns {ValidationError[]}
 */
function checkBraces(lines) {
  const errors = [];
  let depth = 0;
  let lastOpenLine = 0;

  lines.forEach((line, idx) => {
    // Skip comment lines
    const stripped = line.replace(/(?<!\\)%.*$/, '');
    for (const ch of stripped) {
      if (ch === '{') {
        depth++;
        lastOpenLine = idx + 1;
      } else if (ch === '}') {
        depth--;
        if (depth < 0) {
          errors.push({
            type: 'brace',
            message: `Unexpected closing brace '}' with no matching '{'`,
            line: idx + 1,
            context: line.trim().substring(0, 80),
          });
          depth = 0;
        }
      }
    }
  });

  if (depth > 0) {
    errors.push({
      type: 'brace',
      message: `${depth} unclosed curly brace(s) '{' — last opened near line ${lastOpenLine}`,
      line: lastOpenLine,
      context: lines[lastOpenLine - 1]?.trim().substring(0, 80) || '',
    });
  }

  return errors;
}

/**
 * Check that all LaTeX environments are properly opened and closed.
 * @param {string[]} lines
 * @returns {ValidationError[]}
 */
function checkEnvironments(lines) {
  const errors = [];
  const stack = [];
  const beginRe = /\\begin\{([^}]+)\}/g;
  const endRe = /\\end\{([^}]+)\}/g;

  lines.forEach((line, idx) => {
    // Skip full comment lines
    const stripped = line.replace(/(?<!\\)%.*$/, '');

    let m;
    // Reset lastIndex for global regexes
    beginRe.lastIndex = 0;
    endRe.lastIndex = 0;

    while ((m = beginRe.exec(stripped)) !== null) {
      stack.push({ env: m[1], line: idx + 1 });
    }

    while ((m = endRe.exec(stripped)) !== null) {
      const envName = m[1];
      if (stack.length === 0) {
        errors.push({
          type: 'environment',
          message: `\\end{${envName}} has no matching \\begin{${envName}}`,
          line: idx + 1,
          context: line.trim().substring(0, 80),
        });
      } else {
        const top = stack[stack.length - 1];
        if (top.env !== envName) {
          errors.push({
            type: 'environment',
            message: `Mismatched environments: \\begin{${top.env}} (line ${top.line}) closed by \\end{${envName}}`,
            line: idx + 1,
            context: line.trim().substring(0, 80),
          });
          // Pop anyway to continue checking
          stack.pop();
        } else {
          stack.pop();
        }
      }
    }
  });

  // Anything remaining in stack is unclosed
  stack.forEach(({ env, line }) => {
    errors.push({
      type: 'environment',
      message: `\\begin{${env}} was never closed with \\end{${env}}`,
      line,
      context: '',
    });
  });

  return errors;
}

/**
 * Check for unescaped special characters in text contexts.
 * Heuristic: flag & not preceded by \ and not inside a known tabular/align environment.
 * @param {string[]} lines
 * @returns {ValidationError[]}
 */
function checkSpecialChars(lines) {
  const errors = [];
  // Track if we're inside a tabular/array/align environment (where & is valid)
  let alignDepth = 0;
  const alignEnvs = /^(?:tabular|array|align|alignat|eqnarray|matrix|pmatrix|bmatrix|vmatrix|cases|tabbing|longtable|tabulary)(?:\*)?$/;

  const beginRe = /\\begin\{([^}]+)\}/g;
  const endRe = /\\end\{([^}]+)\}/g;

  lines.forEach((line, idx) => {
    const stripped = line.replace(/(?<!\\)%.*$/, '');

    let m;
    beginRe.lastIndex = 0;
    endRe.lastIndex = 0;

    while ((m = beginRe.exec(stripped)) !== null) {
      if (alignEnvs.test(m[1])) alignDepth++;
    }
    while ((m = endRe.exec(stripped)) !== null) {
      if (alignEnvs.test(m[1])) alignDepth = Math.max(0, alignDepth - 1);
    }

    if (alignDepth === 0) {
      // Check for unescaped & in text
      const unescapedAmp = /(?<!\\)&/g;
      while ((m = unescapedAmp.exec(stripped)) !== null) {
        errors.push({
          type: 'special_char',
          message: `Unescaped '&' in text context (should be '\\&')`,
          line: idx + 1,
          context: line.trim().substring(0, 80),
        });
      }
    }

    // Check for markdown backtick contamination
    if (/`{1,3}/.test(stripped)) {
      errors.push({
        type: 'markdown',
        message: `Markdown backtick(s) detected — should not appear in LaTeX source`,
        line: idx + 1,
        context: line.trim().substring(0, 80),
      });
    }
  });

  return errors;
}

/**
 * Check that the document has the basic LaTeX structure.
 * @param {string} latex
 * @returns {ValidationError[]}
 */
function checkStructure(latex) {
  const errors = [];

  if (!/\\documentclass/.test(latex)) {
    errors.push({
      type: 'structure',
      message: 'Missing \\documentclass declaration',
      line: 1,
    });
  }
  if (!/\\begin\{document\}/.test(latex)) {
    errors.push({
      type: 'structure',
      message: 'Missing \\begin{document}',
      line: 1,
    });
  }
  if (!/\\end\{document\}/.test(latex)) {
    errors.push({
      type: 'structure',
      message: 'Missing \\end{document}',
      line: 1,
    });
  }

  return errors;
}

/**
 * Run all deterministic validation checks on a LaTeX string.
 * @param {string} latex
 * @returns {ValidationResult}
 */
export function validateLatexDeterministic(latex) {
  if (!latex || !latex.trim()) {
    return {
      valid: false,
      errors: [{ type: 'structure', message: 'Empty LaTeX document', line: 1 }],
      summary: 'Empty document',
    };
  }

  const lines = latex.split('\n');
  const errors = [
    ...checkStructure(latex),
    ...checkBraces(lines),
    ...checkEnvironments(lines),
    ...checkSpecialChars(lines),
  ];

  const valid = errors.length === 0;
  const summary = valid
    ? 'No validation errors detected'
    : `${errors.length} error(s): ${[...new Set(errors.map(e => e.type))].join(', ')}`;

  return { valid, errors, summary };
}

/**
 * Format validation errors as a concise string for passing to the AI repair prompt.
 * @param {ValidationError[]} errors
 * @returns {string}
 */
export function formatErrorsForRepair(errors) {
  return errors.map((e, i) =>
    `${i + 1}. [${e.type.toUpperCase()}] Line ${e.line || '?'}: ${e.message}${e.context ? ` — Context: "${e.context}"` : ''}`
  ).join('\n');
}
