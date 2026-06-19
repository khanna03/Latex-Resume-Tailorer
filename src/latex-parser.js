/**
 * Deterministic LaTeX → Structured JSON (AST) Parser
 *
 * Ground rules:
 * - The AI/LLM layer never edits raw LaTeX directly. It only reads/writes
 *   structured JSON. This parser converts .tex → JSON before any model sees it.
 * - Same input always produces same output (deterministic, no model involved).
 * - Sections store _offsetStart/_offsetEnd (absolute character offsets into the
 *   full rawFull string) so the reconstruction engine can do precise splicing
 *   instead of brittle indexOf searches.
 */

/**
 * @typedef {Object} LatexBullet
 * @property {string} id            - Unique bullet identifier e.g. "section_0_bullet_2"
 * @property {string} raw           - Full \item ... text including any nested commands
 * @property {string} text          - Plain-text approximation for AI processing
 * @property {number} _offsetStart  - Absolute offset of bullet start in rawFull
 * @property {number} _offsetEnd    - Absolute offset of bullet end in rawFull (exclusive)
 */

/**
 * @typedef {Object} LatexSection
 * @property {string} id            - Unique section identifier e.g. "section_0"
 * @property {string} type          - "section" | "subsection" | "custom" | "environment"
 * @property {string} title         - Section title (plain text)
 * @property {string} rawTitle      - Original LaTeX heading token (verbatim)
 * @property {LatexBullet[]} bullets - \item entries within this section
 * @property {string} rawContent    - Full raw LaTeX content block (heading excluded)
 * @property {number} _offsetStart  - Absolute offset where rawContent begins in rawFull
 * @property {number} _offsetEnd    - Absolute offset where rawContent ends in rawFull (exclusive)
 * @property {boolean} locked       - Protected from AI modification
 */

/**
 * @typedef {Object} ResumeAST
 * @property {string} preamble         - Everything before \begin{document}
 * @property {string} postamble        - Everything after \end{document} (inclusive)
 * @property {LatexSection[]} sections
 * @property {string[]} packages       - Detected \usepackage{...} names
 * @property {string[]} customCommands - Detected \newcommand / \renewcommand definitions
 * @property {string} rawFull          - The original full LaTeX string (never modified)
 * @property {string} plainText        - All bullet plain texts joined for ATS matching
 */

// ---------------------------------------------------------------------------
// Plain-text extraction
// ---------------------------------------------------------------------------

/**
 * Strips common LaTeX commands from a string to get approximate plain text.
 * Used to feed AI (which must never see raw LaTeX) and for ATS keyword matching.
 * @param {string} latex
 * @returns {string}
 */
export function latexToPlainText(latex) {
  if (!latex) return '';
  return latex
    // Formatting commands that wrap text: \textbf{foo} → foo
    .replace(/\\(?:textbf|textit|texttt|emph|underline|textsf|textsc|text|mbox|hbox)\{([^}]*)\}/g, '$1')
    // \href{url}{text} → text
    .replace(/\\(?:href|url)\{[^}]*\}\{([^}]*)\}/g, '$1')
    // \href{url} → url
    .replace(/\\(?:href|url)\{([^}]*)\}/g, '$1')
    // Generic single-arg commands: \foo{bar} → bar
    .replace(/\\[a-zA-Z]+\{([^}]*)\}/g, '$1')
    // Standalone commands: \foo → space
    .replace(/\\[a-zA-Z]+\*/g, ' ')
    .replace(/\\[a-zA-Z]+/g, ' ')
    // Brace leftovers
    .replace(/[{}]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Preamble extraction helpers
// ---------------------------------------------------------------------------

/**
 * Extract \usepackage{...} package names from preamble.
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
 * Extract \newcommand / \renewcommand definition names from preamble.
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

// ---------------------------------------------------------------------------
// Comment-aware body preparation
// ---------------------------------------------------------------------------

/**
 * Return a version of the LaTeX body with comment content blanked out
 * (replaced with spaces of same length) so that section regexes don't
 * false-match commands inside comments.
 * IMPORTANT: we blank rather than remove so all character offsets remain valid.
 *
 * @param {string} body
 * @returns {string}
 */
function blankComments(body) {
  // Replace everything from an unescaped % to end-of-line with spaces
  return body.replace(/((?<!\\)%[^\n]*)/g, match => ' '.repeat(match.length));
}

// ---------------------------------------------------------------------------
// Section detection
// ---------------------------------------------------------------------------

/**
 * Comprehensive section command regex covering the most common LaTeX resume
 * template families:
 *
 * Standard:     \section, \subsection, \subsubsection (with optional *)
 * Jake's:       \resumeSection, \resumeSubheading
 * Awesome-CV:   \cvsection, \cvsubsection
 * ModernCV:     \cventry, \cvitem, \cvline, \cvsection
 * Deedy:        \datedsubsection, \namesection
 * AltaCV:       \cvsection, \cvevent
 * Twenty Seconds: \section (standard)
 * Friggeri:     \section (standard) + custom environments
 * Plasmati:     \section (standard)
 * EuropassCV:   \ecvsection, \ecvtitle
 * General custom: \roSection, \workSection, \skillsSection, \projectSection
 *
 * The regex captures:
 *   sm[1] = command name (e.g. "section", "cvsection", "cventry")
 *   sm[2] = optional [short-title] content (may be undefined)
 *   sm[3] = primary {title} content
 */
const SECTION_RE = /\\(section|subsection|subsubsection|cvsection|cvsubsection|cventry|cvitem|cvline|datedsubsection|namesection|resumeSection|resumeSubheading|resumeSubItem|roSection|workexp|education|skills?[Ss]ection|project[Ss]ection|ecvsection|ecvtitle|cvevent|cvachievement|cvskill|cvref)(?:\*)?(?:\[([^\]]*)\])?\{([^}]*)\}/gi;

/**
 * Find all section heading matches in the (comment-blanked) body, returning
 * an array of match descriptors with absolute offsets.
 *
 * @param {string} body         - Raw body text (between \begin{document} and \end{document})
 * @param {string} blankedBody  - Comment-blanked version of body (same length)
 * @returns {Array<{type, rawTitle, title, bodyOffset}>}
 */
function findSectionMatches(body, blankedBody) {
  const matches = [];
  const re = new RegExp(SECTION_RE.source, SECTION_RE.flags);
  let m;
  while ((m = re.exec(blankedBody)) !== null) {
    const rawTitle = body.substring(m.index, m.index + m[0].length);
    const titleText = latexToPlainText(m[3] || m[2] || '');
    matches.push({
      type: m[1].toLowerCase(),
      rawTitle,
      title: titleText,
      bodyOffset: m.index, // offset within body string
    });
  }
  return matches;
}

// ---------------------------------------------------------------------------
// Bullet extraction
// ---------------------------------------------------------------------------

/**
 * Find all \item entries within a content block, recording their absolute
 * offsets within the full rawFull string.
 *
 * @param {string} content         - The rawContent of a section
 * @param {string} sectionId       - For generating stable bullet IDs
 * @param {number} contentAbsStart - Absolute offset of content start in rawFull
 * @returns {LatexBullet[]}
 */
function extractBullets(content, sectionId, contentAbsStart) {
  const bullets = [];
  // Match \item occurrences (with optional [] argument)
  const itemRe = /\\item(?:\[[^\]]*\])?/g;
  let m;
  const itemStarts = [];

  while ((m = itemRe.exec(content)) !== null) {
    itemStarts.push(m.index);
  }

  itemStarts.forEach((start, idx) => {
    const end = idx + 1 < itemStarts.length ? itemStarts[idx + 1] : content.length;
    const raw = content.substring(start, end).trimEnd();
    // Plain text of the item body (strip the \item prefix itself)
    const itemBody = raw.replace(/^\\item(?:\[[^\]]*\])?\s*/, '').trim();
    bullets.push({
      id: `${sectionId}_bullet_${idx}`,
      raw,
      text: latexToPlainText(itemBody),
      _offsetStart: contentAbsStart + start,
      _offsetEnd: contentAbsStart + end,
    });
  });

  return bullets;
}

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

/**
 * Parse a LaTeX document string into a structured ResumeAST.
 * Deterministic: same input always produces same output.
 *
 * @param {string} rawLatex
 * @returns {ResumeAST}
 */
export function parseLatex(rawLatex) {
  if (!rawLatex) {
    return {
      preamble: '',
      postamble: '',
      sections: [],
      packages: [],
      customCommands: [],
      rawFull: '',
      plainText: '',
    };
  }

  // --- Split preamble / body / postamble ---
  // Use first occurrence only (search returns -1 if not found)
  const beginDocStr = '\\begin{document}';
  const endDocStr = '\\end{document}';

  const beginDocIdx = rawLatex.indexOf(beginDocStr);
  const endDocIdx   = rawLatex.indexOf(endDocStr);

  const hasPreamble  = beginDocIdx >= 0;
  const hasPostamble = endDocIdx >= 0;

  const preamble = hasPreamble
    ? rawLatex.substring(0, beginDocIdx + beginDocStr.length)
    : '';

  // postamble includes \end{document} itself
  const postamble = hasPostamble
    ? rawLatex.substring(endDocIdx)
    : '';

  // body is what lives between \begin{document} and \end{document}
  const bodyAbsStart = hasPreamble ? beginDocIdx + beginDocStr.length : 0;
  const bodyAbsEnd   = hasPostamble ? endDocIdx : rawLatex.length;
  const body         = rawLatex.substring(bodyAbsStart, bodyAbsEnd);

  const packages       = extractPackages(preamble);
  const customCommands = extractCustomCommands(preamble);

  // --- Find sections ---
  const blankedBody    = blankComments(body);
  const sectionMatches = findSectionMatches(body, blankedBody);

  const sections    = [];
  const allPlainText = [];

  sectionMatches.forEach((match, i) => {
    // Content starts right after the heading command
    const contentLocalStart = match.bodyOffset + match.rawTitle.length;
    // Content ends where the next section's heading begins (or end of body)
    const contentLocalEnd = i + 1 < sectionMatches.length
      ? sectionMatches[i + 1].bodyOffset
      : body.length;

    const rawContent = body.substring(contentLocalStart, contentLocalEnd);

    // Convert local body offsets → absolute rawFull offsets
    const absStart = bodyAbsStart + contentLocalStart;
    const absEnd   = bodyAbsStart + contentLocalEnd;

    const sectionId = `section_${i}`;
    const bullets   = extractBullets(rawContent, sectionId, absStart);

    bullets.forEach(b => allPlainText.push(b.text));

    const type = (() => {
      const t = match.type;
      if (t.includes('sub')) return 'subsection';
      if (['cventry','cvitem','cvline','cvevent','cvachievement','datedsubsection'].includes(t)) return 'custom';
      return 'section';
    })();

    sections.push({
      id: sectionId,
      type,
      title: match.title,
      rawTitle: match.rawTitle,
      bullets,
      rawContent,
      _offsetStart: absStart,
      _offsetEnd: absEnd,
      locked: false,
    });
  });

  // If no section commands found, treat the whole body as one section
  if (sections.length === 0 && body.trim()) {
    const sectionId = 'section_0';
    const bullets   = extractBullets(body, sectionId, bodyAbsStart);
    bullets.forEach(b => allPlainText.push(b.text));
    sections.push({
      id: sectionId,
      type: 'section',
      title: 'Document Body',
      rawTitle: '',
      bullets,
      rawContent: body,
      _offsetStart: bodyAbsStart,
      _offsetEnd: bodyAbsEnd,
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

// ---------------------------------------------------------------------------
// Utility exports
// ---------------------------------------------------------------------------

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
      section.bullets.forEach(b => { out += `• ${b.text}\n`; });
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
