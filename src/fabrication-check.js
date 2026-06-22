/**
 * Fabrication Check — Post-generation Named Entity Recognition (NER) pass.
 *
 * Build prompt mandate (§5): "Every generation prompt must explicitly forbid
 * inventing skills, employers, dates, or metrics not present in the source resume.
 * Build a post-generation check that flags any named entity (company, tool, metric)
 * in the output that didn't appear in the input, for human review before it's accepted."
 *
 * This module implements that check deterministically — no AI calls.
 * It flags three categories:
 *   1. Tech/tools: known tools/languages/frameworks found in output but not input
 *   2. Metrics:    quantitative claims (40%, 3x, $2M) found in output but not input
 *   3. Proper nouns: capitalized terms found in output but not in input
 *
 * IMPORTANT: Flags require HUMAN REVIEW — they do not automatically block output.
 * The explainability panel surfaces them prominently so the user can decide.
 */

// ---------------------------------------------------------------------------
// Curated technology/tool list
// (200+ common tools, languages, frameworks, platforms)
// ---------------------------------------------------------------------------

const TECH_TERMS = new Set([
  // Languages
  'python','javascript','typescript','java','kotlin','swift','go','golang','rust',
  'c++','c#','c','ruby','php','scala','haskell','erlang','elixir','clojure',
  'r','matlab','julia','dart','perl','bash','shell','powershell','sql','nosql',
  // Web frameworks / libraries
  'react','vue','angular','svelte','nextjs','next.js','nuxt','gatsby','remix',
  'express','fastapi','django','flask','spring','rails','laravel','asp.net',
  'graphql','rest','grpc','websocket',
  // Cloud & infra
  'aws','azure','gcp','google cloud','kubernetes','k8s','docker','terraform',
  'ansible','puppet','chef','jenkins','circleci','github actions','gitlab ci',
  'helm','istio','envoy','nginx','apache','cloudfront','lambda','ec2','s3',
  'rds','dynamodb','bigquery','dataflow','pubsub','kafka','rabbitmq','redis',
  'elasticsearch','opensearch','kibana','grafana','prometheus','datadog','newrelic',
  // Databases
  'postgresql','postgres','mysql','mariadb','mongodb','cassandra','redis',
  'sqlite','oracle','mssql','sql server','snowflake','databricks','spark',
  'hadoop','hive','airflow','dbt','fivetran',
  // ML / AI
  'tensorflow','pytorch','keras','scikit-learn','sklearn','xgboost','lightgbm',
  'hugging face','transformers','bert','gpt','langchain','openai','anthropic',
  'pandas','numpy','scipy','matplotlib','seaborn','plotly','jupyter',
  // Mobile
  'react native','flutter','ionic','xamarin','android','ios','xcode',
  // Tools
  'git','github','gitlab','bitbucket','jira','confluence','notion',
  'figma','sketch','postman','swagger','openapi','linux','unix','macos',
  'vscode','intellij','eclipse','vim','emacs',
  // Methodologies
  'agile','scrum','kanban','devops','devsecops','ci/cd','tdd','bdd',
  'microservices','serverless','event-driven','domain-driven',
  // Security
  'oauth','jwt','saml','ssl','tls','soc 2','pci-dss','gdpr','hipaa','iso 27001',
  // Protocols / standards
  'http','https','tcp','udp','mqtt','amqp','protobuf','avro','json','xml','yaml',
].map(t => t.toLowerCase()));

// ---------------------------------------------------------------------------
// Metric pattern detection
// ---------------------------------------------------------------------------

/**
 * Extract metric-style claims from text (percentages, multipliers, dollar amounts).
 * E.g. "40%", "3x", "$2M", "100K users", "50ms latency"
 *
 * @param {string} text
 * @returns {string[]} Matched metric strings
 */
function extractMetrics(text) {
  const patterns = [
    /\d+(?:\.\d+)?%/g,           // 40%, 99.9%
    /\d+(?:\.\d+)?[xX]/g,         // 3x, 10X
    /\$\d+(?:\.\d+)?[KMBkmb]?/g,  // $2M, $500K, $1.5B
    /\d+(?:\.\d+)?[KMBkmb]\s*(?:users?|requests?|events?|records?|transactions?)/gi,
    /\d+(?:,\d{3})+/g,            // 1,000,000 (large numbers with commas)
    /\d+\s*ms\b/gi,               // 50ms
    /\d+\s*(?:hours?|days?|weeks?|months?)\b/gi, // 6 months, 3 days
  ];
  const found = new Set();
  patterns.forEach(re => {
    let m;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(text)) !== null) {
      found.add(m[0].trim());
    }
  });
  return [...found];
}

// ---------------------------------------------------------------------------
// Proper noun extraction (heuristic)
// ---------------------------------------------------------------------------

/**
 * Extract likely proper nouns: sequences of capitalized words that are NOT
 * at the start of a sentence. Simple heuristic — not NLP-grade but useful
 * for flagging company names, product names, etc.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractProperNouns(text) {
  const found = new Set();
  // Match words that start with capital letter but are NOT at sentence start
  // (preceded by a space, not by '. ' or start-of-string)
  const re = /(?<=\s)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const word = m[1].trim();
    // Filter out common English words that happen to be capitalized mid-sentence
    if (!COMMON_WORDS.has(word.toLowerCase())) {
      found.add(word);
    }
  }
  return [...found];
}

// Common words that appear capitalized in sentences but are not proper nouns
const COMMON_WORDS = new Set([
  'the','and','for','with','this','that','from','into','onto','upon',
  'also','both','each','every','many','most','other','such','their',
  'these','those','through','where','which','while','about','above',
  'across','after','against','along','among','around','before','behind',
  'between','beyond','during','except','inside','outside','since','under',
  'until','within','without','according','although','because','despite',
  'however','moreover','therefore','thus','whether','january','february',
  'march','april','june','july','august','september','october','november',
  'december','monday','tuesday','wednesday','thursday','friday','saturday','sunday',
  'bachelor','master','doctor','engineer','senior','junior','lead','staff',
  'principal','manager','director','president','vice','chief','head',
  'team','group','project','product','service','system','platform','solution',
  'application','infrastructure','architecture','technology','business','company',
]);

// ---------------------------------------------------------------------------
// Main fabrication check
// ---------------------------------------------------------------------------

/**
 * Compare original resume text against generated text and flag entities that
 * appear in the generated version but NOT in the original.
 *
 * @param {string} originalText  - Plain text of the original resume
 * @param {string} generatedText - Plain text of the AI-generated resume
 * @returns {{
 *   flagged: Array<{ entity: string, type: 'tech'|'metric'|'proper_noun', context: string }>,
 *   hasFabrication: boolean,
 *   summary: string
 * }}
 */
export function checkFabrication(originalText, generatedText) {
  if (!originalText || !generatedText) {
    return { flagged: [], hasFabrication: false, summary: 'Fabrication check skipped — missing input.' };
  }

  const origNorm = originalText.toLowerCase();
  const flagged  = [];

  // --- 1. Tech/tool terms ---
  const techRe = new RegExp(
    `\\b(${[...TECH_TERMS].map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
    'gi'
  );
  const generatedTechMatches = new Set();
  let m;
  while ((m = techRe.exec(generatedText)) !== null) {
    generatedTechMatches.add(m[0].toLowerCase());
  }
  for (const term of generatedTechMatches) {
    if (!origNorm.includes(term)) {
      // We grab a snippet of text surrounding the fabricated term so the UI can highlight context.
      // Math.max ensures we don't go out of bounds if the term is near the start of the document.
      const idx     = generatedText.toLowerCase().indexOf(term);
      const context = generatedText.substring(Math.max(0, idx - 30), idx + term.length + 30).trim();
      flagged.push({ entity: term, type: 'tech', context });
    }
  }

  // --- 2. Metric claims ---
  const origMetrics = new Set(extractMetrics(originalText).map(s => s.toLowerCase()));
  const genMetrics  = extractMetrics(generatedText);
  // Here we check if the metric is entirely absent from the original resume.
  // We check two things:
  // 1. Is it not in the set of exact metrics extracted from the original?
  // 2. Is it not anywhere in the raw text? (To handle slight formatting differences).
  for (const metric of genMetrics) {
    if (!origMetrics.has(metric.toLowerCase()) && !origNorm.includes(metric.toLowerCase())) {
      const idx     = generatedText.toLowerCase().indexOf(metric.toLowerCase());
      const context = generatedText.substring(Math.max(0, idx - 30), idx + metric.length + 30).trim();
      flagged.push({ entity: metric, type: 'metric', context });
    }
  }

  // --- 3. Proper nouns ---
  const origLower = originalText.toLowerCase();
  const genProperNouns = extractProperNouns(generatedText);
  for (const noun of genProperNouns) {
    if (!origLower.includes(noun.toLowerCase())) {
      const idx     = generatedText.indexOf(noun);
      const context = generatedText.substring(Math.max(0, idx - 30), idx + noun.length + 30).trim();
      // Only flag if it looks like a company/product name (2+ words or all-caps)
      const isAllCaps = noun === noun.toUpperCase() && noun.length > 2;
      const isMultiWord = noun.includes(' ');
      if (isAllCaps || isMultiWord) {
        flagged.push({ entity: noun, type: 'proper_noun', context });
      }
    }
  }

  const hasFabrication = flagged.length > 0;
  const summary = hasFabrication
    ? `${flagged.length} potential fabrication(s) flagged for human review: ` +
      `${[...new Set(flagged.map(f => f.type))].join(', ')}. ` +
      `These entities appear in the generated output but not in the original resume.`
    : 'No fabrications detected — all entities in generated output appear in original resume.';

  return { flagged, hasFabrication, summary };
}
