/**
 * Deterministic LaTeX → Structured JSON (AST) Parser
 * AI must never directly modify raw LaTeX — it operates on this structured representation.
 */

/**
 * @typedef {Object} LatexBullet
 * @property {string} id - Unique bullet identifier
 * @property {string} raw - The full \item ... text including any nested commands
 * @property {string} text - Plain-text approximation for AI processing
 * @property {number} lineStart
 * @property {number} lineEnd
 */

/**
 * @typedef {Object} LatexSection
 * @property {string} id - Unique section identifier (e.g. "section_0")
 * @property {string} type - "section" | "subsection" | "custom" | "environment"
 * @property {string} title - Section title (plain text)
 * @property {string} rawTitle - Original LaTeX title token
 * @property {LatexBullet[]} bullets - \item entries within this section
 * @property {string} rawContent - Full raw LaTeX content of this section block
 * @property {number} lineStart
 * @property {number} lineEnd
 * @property {boolean} locked - Protected from AI modification
 */

/**
 * @typedef {Object} ResumeAST
 * @property {string} preamble - Everything before \begin{document}
 * @property {string} postamble - Everything after \end{document}
 * @property {LatexSection[]} sections
 * @property {string[]} packages - Detected \usepackage{...} names
 * @property {string[]} customCommands - Detected \newcommand / \renewcommand definitions
 * @property {string} rawFull - The original full LaTeX string (never modified)
 * @property {string} plainText - Concatenation of all bullet plain texts for ATS matching
 */

/**
 * Strips common LaTeX commands from a string to get approximate plain text.
 * @param {string} latex
 * @returns {string}
 */
export function latexToPlainText(latex) {
  if (!latex) return '';
  return latex
    .replace(/\\(?:textbf|textit|texttt|emph|underline|textsf|textsc|text)\{([^}]*)\}/g, '$1')
    .replace(/\\(?:href|url)\{[^}]*\}\{([^}]*)\}/g, '$1')
    .replace(/\\(?:href|url)\{([^}]*)\}/g, '$1')
    .replace(/\\\w+\{([^}]*)\}/g, '$1')
    .replace(/\\\w+/g, ' ')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract packages from preamble
 * @param {string} preamble
 * @returns {string[]}
 */
function extractPackages(preamble) {
  const packages = [];
  const re = /\\usepackage(?:\[[^\]]*\])?\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(preamble)) !== null) {
    m[1].split(',').forEach(p => packages.push(p.trim()));
  }
  return packages;
}

/**
 * Extract \newcommand / \renewcommand definitions from preamble
 * @param {string} preamble
 * @returns {string[]}
 */
function extractCustomCommands(preamble) {
  const cmds = [];
  const re = /\\(?:newcommand|renewcommand|providecommand)\{([^}]+)\}/g;
  let m;
  while ((m = re.exec(preamble)) !== null) {
    cmds.push(m[1]);
  }
  return cmds;
}

/**
 * Find all \item entries within a block of LaTeX, returning structured bullets.
 * @param {string} block
 * @param {string} sectionId
 * @param {number} baseLineOffset
 * @returns {LatexBullet[]}
 */
function extractBullets(block, sectionId, baseLineOffset = 0) {
  const bullets = [];
  // Split by \item, keeping the delimiter
  const parts = block.split(/(?=\\item\b)/);
  let lineCounter = baseLineOffset;

  parts.forEach((part, idx) => {
    if (!part.startsWith('\\item')) return;
    const linesBefore = bullets.length > 0
      ? block.substring(0, block.indexOf(part)).split('\n').length
      : 0;
    const lineStart = baseLineOffset + linesBefore;
    const lineEnd = lineStart + part.split('\n').length - 1;
    const rawItemContent = part.replace(/^\\item\s*/, '').trim();
    bullets.push({
      id: `${sectionId}_bullet_${idx}`,
      raw: part.trim(),
      text: latexToPlainText(rawItemContent),
      lineStart,
      lineEnd,
    });
  });

  return bullets;
}

/**
 * Parse a LaTeX document string into a structured ResumeAST.
 * @param {string} rawLatex
 * @returns {ResumeAST}
 */
export function parseLatex(rawLatex) {
  const lines = rawLatex.split('\n');

  // --- Split preamble / body / postamble ---
  const beginDocMatch = rawLatex.search(/\\begin\{document\}/);
  const endDocMatch = rawLatex.search(/\\end\{document\}/);

  const preamble = beginDocMatch >= 0
    ? rawLatex.substring(0, beginDocMatch + '\\begin{document}'.length)
    : '';
  const postamble = endDocMatch >= 0
    ? rawLatex.substring(endDocMatch)
    : '';
  const body = (beginDocMatch >= 0 && endDocMatch >= 0)
    ? rawLatex.substring(beginDocMatch + '\\begin{document}'.length, endDocMatch)
    : rawLatex;

  const packages = extractPackages(preamble);
  const customCommands = extractCustomCommands(preamble);

  // --- Section detection ---
  // Matches: \section{Title}, \subsection{Title}, \section*{Title},
  //          common custom resume sectioning like \resumeSection{Title}
  const sectionRe = /\\(section|subsection|subsubsection|resumeSection|cvSection|cvsection|roSection|workexp|education|skills?section|project)(?:\*)?(?:\[([^\]]*)\])?\{([^}]*)\}/gi;

  const sectionMatches = [];
  let sm;
  while ((sm = sectionRe.exec(body)) !== null) {
    sectionMatches.push({
      type: sm[1].toLowerCase(),
      rawTitle: sm[0],
      title: latexToPlainText(sm[3] || sm[2] || ''),
      index: sm.index,
    });
  }

  const sections = [];
  const allPlainText = [];

  sectionMatches.forEach((match, i) => {
    const contentStart = match.index + match.rawTitle.length;
    const contentEnd = i + 1 < sectionMatches.length
      ? sectionMatches[i + 1].index
      : body.length;

    const rawContent = body.substring(contentStart, contentEnd);
    const bodyUpToHere = body.substring(0, contentStart);
    const lineStart = preamble.split('\n').length + bodyUpToHere.split('\n').length - 1;
    const lineEnd = lineStart + rawContent.split('\n').length - 1;

    const sectionId = `section_${i}`;
    const bullets = extractBullets(rawContent, sectionId, lineStart);

    const plainTexts = bullets.map(b => b.text);
    allPlainText.push(...plainTexts);

    sections.push({
      id: sectionId,
      type: match.type.includes('sub') ? 'subsection' : 'section',
      title: match.title,
      rawTitle: match.rawTitle,
      bullets,
      rawContent,
      lineStart,
      lineEnd,
      locked: false,
    });
  });

  // If no section commands found, treat the whole body as one section
  if (sections.length === 0 && body.trim()) {
    const sectionId = 'section_0';
    const bullets = extractBullets(body, sectionId, preamble.split('\n').length);
    allPlainText.push(...bullets.map(b => b.text));
    sections.push({
      id: sectionId,
      type: 'section',
      title: 'Document Body',
      rawTitle: '',
      bullets,
      rawContent: body,
      lineStart: preamble.split('\n').length,
      lineEnd: lines.length,
      locked: false,
    });
  }

  return {
    preamble,
    postamble,
    sections,
    packages,
    customCommands,
    rawFull: rawLatex,
    plainText: allPlainText.join(' '),
  };
}

/**
 * Convert the AST back into a plain text summary for AI analysis.
 * Sections are labeled and bullets are listed as plain text.
 * @param {ResumeAST} ast
 * @returns {string}
 */
export function astToTextSummary(ast) {
  let out = '';
  ast.sections.forEach(section => {
    out += `\n=== ${section.title} ===\n`;
    if (section.bullets.length > 0) {
      section.bullets.forEach(b => {
        out += `• ${b.text}\n`;
      });
    } else {
      out += latexToPlainText(section.rawContent) + '\n';
    }
  });
  return out.trim();
}

/**
 * Get the canonical section names in the AST for display purposes.
 * @param {ResumeAST} ast
 * @returns {string[]}
 */
export function getSectionNames(ast) {
  return ast.sections.map(s => s.title);
}
