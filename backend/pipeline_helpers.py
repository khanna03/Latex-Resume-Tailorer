# ==============================================================================
# LaTeX Resume Tailorer — Core Pipeline Algorithms Helper
# ==============================================================================
# This module implements the Python translations of our core resume tailoring
# pipeline algorithms. It is written to be clean, modular, and extensively
# commented for developer learning.
# ==============================================================================

import re
import math
from typing import Dict, List, Any, Set, Tuple
from sqlalchemy.orm import Session

# Tech terms list identical to fabrication-check.js
TECH_TERMS = {
    'python','javascript','typescript','java','kotlin','swift','go','golang','rust',
    'c++','c#','c','ruby','php','scala','haskell','erlang','elixir','clojure',
    'r','matlab','julia','dart','perl','bash','shell','powershell','sql','nosql',
    'react','vue','angular','svelte','nextjs','next.js','nuxt','gatsby','remix',
    'express','fastapi','django','flask','spring','rails','laravel','asp.net',
    'graphql','rest','grpc','websocket','aws','azure','gcp','google cloud','kubernetes',
    'k8s','docker','terraform','ansible','puppet','chef','jenkins','circleci',
    'github actions','gitlab ci','helm','istio','envoy','nginx','apache','cloudfront',
    'lambda','ec2','s3','rds','dynamodb','bigquery','dataflow','pubsub','kafka',
    'rabbitmq','redis','elasticsearch','opensearch','kibana','grafana','prometheus',
    'datadog','newrelic','postgresql','postgres','mysql','mariadb','mongodb',
    'cassandra','sqlite','oracle','mssql','sql server','snowflake','databricks',
    'spark','hadoop','hive','airflow','dbt','fivetran','tensorflow','pytorch',
    'keras','scikit-learn','sklearn','xgboost','lightgbm','hugging face',
    'transformers','bert','gpt','langchain','openai','anthropic','pandas','numpy',
    'scipy','matplotlib','seaborn','plotly','jupyter','react native','flutter',
    'ionic','xamarin','android','ios','xcode','git','github','gitlab','bitbucket',
    'jira','confluence','notion','figma','sketch','postman','swagger','openapi',
    'linux','unix','macos','vscode','intellij','eclipse','vim','emacs','agile',
    'scrum','kanban','devops','devsecops','ci/cd','tdd','bdd','microservices',
    'serverless','event-driven','domain-driven','oauth','jwt','saml','ssl','tls',
    'soc 2','pci-dss','gdpr','hipaa','iso 27001','http','https','tcp','udp',
    'mqtt','amqp','protobuf','avro','json','xml','yaml'
}

COMMON_WORDS = {
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
    'application','infrastructure','architecture','technology','business','company'
}

# --------------------------------------------------------------------------
# 1. LaTeX Escaping
# --------------------------------------------------------------------------

def escape_latex(text: str) -> str:
    """
    Escapes reserved LaTeX special characters inside a text block.
    Only call this on plain text bullet edits from the AI.
    """
    if not text:
        return ""
    # Maintain character replacement sequences matching reconstruction-engine.js
    replacements = [
        (re.compile(r"\\"), r"\\textbackslash{}"),
        (re.compile(r"&"), r"\&"),
        (re.compile(r"%"), r"\%"),
        (re.compile(r"\$"), r"\$"),
        (re.compile(r"#"), r"\#"),
        (re.compile(r"_"), r"\_"),
        (re.compile(r"\{"), r"\{"),
        (re.compile(r"\}"), r"\}"),
        (re.compile(r"~"), r"\\textasciitilde{}"),
        (re.compile(r"\^"), r"\\textasciicircum{}"),
    ]
    result = text
    for regex, repl in replacements:
        result = regex.sub(repl, result)
    return result

# --------------------------------------------------------------------------
# 2. Offset-Based LaTeX Reconstruction
# --------------------------------------------------------------------------

def reconstruct_section_content(original_section: Dict[str, Any], new_bullet_texts: List[str]) -> str:
    """
    Surgically splices updated bullet points into a section's LaTeX block.
    Preserves document layout environments, commands, and formatting spacing.
    """
    if not new_bullet_texts:
        return original_section.get("rawContent", "")

    original_bullets = original_section.get("bullets", [])
    count = min(len(original_bullets), len(new_bullet_texts))
    replacements = []
    
    # Section offset start to compute local character positions
    section_abs_start = original_section.get("_offsetStart", 0)

    for i in range(count):
        orig_bullet = original_bullets[i]
        new_text = new_bullet_texts[i]
        if new_text is None:
            continue

        # Compute offsets relative to rawContent
        rel_start = orig_bullet["_offsetStart"] - section_abs_start
        rel_end = orig_bullet["_offsetEnd"] - section_abs_start

        # Match the bullet's item macro structure (e.g., \item[label] or \resumeItem)
        leading_match = re.match(r"^(\\item(?:\[[^\]]*\])?\s*)", orig_bullet["raw"])
        leading_prefix = leading_match.group(1) if leading_match else "\\item "

        # Escape the text if it is pure plain text (doesn't contain backslash commands)
        escaped_content = new_text if "\\" in new_text else escape_latex(new_text)
        new_raw = f"{leading_prefix}{escaped_content}"

        replacements.append((rel_start, rel_end, new_raw))

    # Sort replacements in reverse order of relative offsets.
    # This prevents early character splices from altering index positions of later splices!
    replacements.sort(key=lambda x: x[0], reverse=True)

    result = original_section.get("rawContent", "")
    for start, end, new_raw in replacements:
        result = result[:start] + new_raw + result[end:]

    # Append any extra bullets generated by the AI
    if len(new_bullet_texts) > len(original_bullets):
        extra_texts = new_bullet_texts[len(original_bullets):]
        extra_items = "\n".join([f"\\item {escape_latex(t)}" for t in extra_texts])
        
        # Insert before the environment closing sequence if found
        end_env = re.search(r"\\end\{(?:itemize|enumerate|description)\}", result)
        if end_env:
            result = result[:end_env.start()] + extra_items + "\n" + result[end_env.startCustom():] if hasattr(end_env, "startCustom") else result[:end_env.start()] + extra_items + "\n" + result[end_env.start():]
        else:
            result = result.rstrip() + "\n" + extra_items + "\n"

    return result

def reconstruct_latex(original_ast: Dict[str, Any], section_modifications: Dict[str, Any], locked_section_ids: Set[str] = None) -> str:
    """
    Surgically splices tailored section contents into the original LaTeX document.
    """
    if locked_section_ids is None:
        locked_section_ids = set()

    result = original_ast.get("rawFull", "")
    
    # Process sections in reverse order of absolute start offsets
    sections_to_process = [
        s for s in original_ast.get("sections", [])
        if s["id"] not in locked_section_ids and not s.get("locked", False)
    ]
    sections_to_process.sort(key=lambda s: s["_offsetStart"], reverse=True)

    for section in sections_to_process:
        mod = section_modifications.get(section["id"])
        if not mod or not mod.get("bullets"):
            continue
            
        new_content = reconstruct_section_content(section, mod["bullets"])
        
        # Splice section content into result string
        result = result[:section["_offsetStart"]] + new_content + result[section["_offsetEnd"]:]

    return result

# --------------------------------------------------------------------------
# 3. Locked Section Enforcement
# --------------------------------------------------------------------------

def validate_locked_sections(original_ast: Dict[str, Any], tailored_latex: str, locked_section_ids: Set[str]) -> Tuple[str, List[str]]:
    """
    Byte-for-byte comparison of locked sections. Reverts any modifications.
    """
    if not locked_section_ids:
        return tailored_latex, []

    from backend.routes.parser import parse_latex_to_ast
    tailored_ast = parse_latex_to_ast(tailored_latex)
    reverted = []
    result = tailored_latex

    # Map tailored sections by lowercase title for comparison
    tailored_by_title = {s["title"].lower().strip(): s for s in tailored_ast.get("sections", [])}

    for orig_sec in original_ast.get("sections", []):
        if orig_sec["id"] not in locked_section_ids and not orig_sec.get("locked", False):
            continue

        tailored = tailored_by_title.get(orig_sec["title"].lower().strip())
        if not tailored:
            continue

        # If the content drifted, splice the original content back
        if tailored.get("rawContent") != orig_sec.get("rawContent"):
            result = result[:tailored["_offsetStart"]] + orig_sec["rawContent"] + result[tailored["_offsetEnd"]:]
            reverted.append(orig_sec["id"])

    return result, reverted

# --------------------------------------------------------------------------
# 4. Fabrication Check
# --------------------------------------------------------------------------

def extract_metrics(text: str) -> List[str]:
    """Helper to detect metric patterns in text."""
    patterns = [
        r"\d+(?:\.\d+)?%",           # 40%, 99.9%
        r"\d+(?:\.\d+)?[xX]",         # 3x, 10X
        r"\$\d+(?:\.\d+)?[KMBkmb]?",  # $2M, $500K
        r"\d+(?:\.\d+)?[KMBkmb]\s*(?:users?|requests?|events?|records?)",
        r"\d+(?:,\d{3})+",            # 1,000,000
        r"\d+\s*ms\b",                # 50ms
        r"\d+\s*(?:hours?|days?|weeks?|months?)\b" # 6 months
    ]
    found = set()
    for pat in patterns:
        for m in re.finditer(pat, text, re.IGNORECASE):
            found.add(m.group(0).strip())
    return list(found)

def extract_proper_nouns(text: str) -> List[str]:
    """Extract sequences of capitalized words that are not starting a sentence."""
    found = set()
    # Find words with capital letter preceded by space (not a period/start of sentence)
    for m in re.finditer(r"(?<=\s)([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)", text):
        word = m.group(1).strip()
        if word.lower() not in COMMON_WORDS:
            found.add(word)
    return list(found)

def check_fabrication(original_text: str, generated_text: str) -> Tuple[List[Dict[str, Any]], bool, str]:
    """
    Compares the original resume text against tailored text.
    Flags metrics, technology keywords, and proper nouns that appear in the
    output but did not exist in the source input.
    """
    if not original_text or not generated_text:
        return [], False, "Missing input text."

    orig_norm = original_text.lower()
    flagged = []

    # Check technology terms
    gen_tech = set()
    tech_pattern = re.compile(r"\b(" + "|".join([re.escape(t) for t in TECH_TERMS]) + r")\b", re.IGNORECASE)
    for m in tech_pattern.finditer(generated_text):
        gen_tech.add(m.group(0).lower())
        
    for term in gen_tech:
        if term not in orig_norm:
            idx = generated_text.lower().find(term)
            context = generated_text[max(0, idx - 30) : idx + len(term) + 30].strip()
            flagged.append({"entity": term, "type": "tech", "context": context})

    # Check metrics
    orig_metrics = {m.lower() for m in extract_metrics(original_text)}
    gen_metrics = extract_metrics(generated_text)
    for metric in gen_metrics:
        if metric.lower() not in orig_metrics and metric.lower() not in orig_norm:
            idx = generated_text.lower().find(metric.lower())
            context = generated_text[max(0, idx - 30) : idx + len(metric) + 30].strip()
            flagged.append({"entity": metric, "type": "metric", "context": context})

    # Check proper nouns
    gen_nouns = extract_proper_nouns(generated_text)
    for noun in gen_nouns:
        if noun.lower() not in orig_norm:
            idx = generated_text.find(noun)
            context = generated_text[max(0, idx - 30) : idx + len(noun) + 30].strip()
            is_all_caps = noun == noun.upper() and len(noun) > 2
            is_multi_word = " " in noun
            if is_all_caps or is_multi_word:
                flagged.append({"entity": noun, "type": "proper_noun", "context": context})

    has_fab = len(flagged) > 0
    summary = f"Flagged {len(flagged)} potential fabrications for review." if has_fab else "No fabrications detected."
    return flagged, has_fab, summary

# --------------------------------------------------------------------------
# 5. Deterministic LaTeX Validator
# --------------------------------------------------------------------------

def validate_latex_deterministic(latex: str) -> Dict[str, Any]:
    """Runs structural checks on a LaTeX string to identify syntax compiler errors."""
    if not latex or not latex.strip():
        return {
            "valid": False,
            "errors": [{"type": "structure", "message": "Empty LaTeX document", "line": 1}],
            "summary": "Empty document"
        }

    lines = latex.split("\n")
    errors = []

    # 1. Check Structure
    if not re.search(r"\\documentclass", latex):
        errors.append({"type": "structure", "message": "Missing \\documentclass declaration", "line": 1})
    if not re.search(r"\\begin\{document\}", latex):
        errors.append({"type": "structure", "message": "Missing \\begin{document}", "line": 1})
    if not re.search(r"\\end\{document\}", latex):
        errors.append({"type": "structure", "message": "Missing \\end{document}", "line": len(lines)})

    # 2. Check Braces
    brace_depth = 0
    last_open = 0
    for idx, line in enumerate(lines):
        # Strip comments
        stripped = re.sub(r"(?<!\\)%.*$", "", line)
        for char in stripped:
            if char == "{":
                brace_depth += 1
                last_open = idx + 1
            elif char == "}":
                brace_depth -= 1
                if brace_depth < 0:
                    errors.append({
                        "type": "brace",
                        "message": "Unexpected closing brace '}' with no matching '{'",
                        "line": idx + 1,
                        "context": line.strip()[:80]
                    })
                    brace_depth = 0
    if brace_depth > 0:
        errors.append({
            "type": "brace",
            "message": f"{brace_depth} unclosed brace(s) '{{' — last opened near line {last_open}",
            "line": last_open,
            "context": lines[last_open - 1].strip()[:80] if last_open <= len(lines) else ""
        })

    # 3. Check Environments
    env_stack = []
    begin_re = re.compile(r"\\begin\{([^}]+)\}")
    end_re = re.compile(r"\\end\{([^}]+)\}")
    align_envs = re.compile(r"^(?:tabular|array|align|alignat|eqnarray|matrix|pmatrix|bmatrix|vmatrix|cases|tabbing|longtable|tabulary)(?:\*)?$")
    align_depth = 0

    for idx, line in enumerate(lines):
        stripped = re.sub(r"(?<!\\)%.*$", "", line)
        
        # Track begin commands
        for m in begin_re.finditer(stripped):
            env_name = m.group(1)
            env_stack.append((env_name, idx + 1))
            if align_envs.match(env_name):
                align_depth += 1
                
        # Track end commands
        for m in end_re.finditer(stripped):
            env_name = m.group(1)
            if align_envs.match(env_name):
                align_depth = max(0, align_depth - 1)
                
            if not env_stack:
                errors.append({
                    "type": "environment",
                    "message": f"\\end{{{env_name}}} has no matching \\begin",
                    "line": idx + 1,
                    "context": line.strip()[:80]
                })
            else:
                top_env, top_line = env_stack.pop()
                if top_env != env_name:
                    errors.append({
                        "type": "environment",
                        "message": f"Mismatched environments: \\begin{{{top_env}}} (line {top_line}) closed by \\end{{{env_name}}}",
                        "line": idx + 1,
                        "context": line.strip()[:80]
                    })

        # 4. Check Special Characters
        if align_depth == 0:
            # Check for unescaped '&' outside tabular/align equations
            for m in re.finditer(r"(?<!\\)&", stripped):
                errors.append({
                    "type": "special_char",
                    "message": "Unescaped '&' in text context (should be '\\&')",
                    "line": idx + 1,
                    "context": line.strip()[:80]
                })

        # Check markdown backtick leaks
        if "`" in stripped:
            errors.append({
                "type": "markdown",
                "message": "Markdown backtick detected — should not appear in LaTeX source",
                "line": idx + 1,
                "context": line.strip()[:80]
            })

    for env_name, start_line in env_stack:
        errors.append({
            "type": "environment",
            "message": f"\\begin{{{env_name}}} on line {start_line} was never closed",
            "line": start_line,
            "context": ""
        })

    valid = len(errors) == 0
    summary = "No validation errors detected" if valid else f"{len(errors)} error(s) found."
    return {"valid": valid, "errors": errors, "summary": summary}

def format_errors_for_repair(errors: List[Dict[str, Any]]) -> str:
    """Formats validation errors into an AI repair log string."""
    lines = []
    for i, err in enumerate(errors):
        line_num = err.get("line", "?")
        context_str = f" — Context: \"{err['context']}\"" if err.get("context") else ""
        lines.append(f"{i + 1}. [{err['type'].upper()}] Line {line_num}: {err['message']}{context_str}")
    return "\n".join(lines)

# --------------------------------------------------------------------------
# 6. ATS Matching Logic (Translated from ats-engine.js)
# --------------------------------------------------------------------------

def normalize_text(text: str) -> str:
    """Standardizes text casing and layout for keyword scanning."""
    return re.sub(r"[^a-z0-9+#.\s]", " ", text.lower()).strip()

def keyword_found(keyword: str, normalized_resume: str) -> bool:
    """Regex matching to check if a keyword exists, respecting word boundaries."""
    norm_kw = normalize_text(keyword)
    if not norm_kw:
        return False
    escaped = re.escape(norm_kw)
    pattern = re.compile(r"(?:^|\s|[,;(])" + escaped + r"(?:$|\s|[,;)])", re.IGNORECASE)
    return bool(pattern.search(normalized_resume))

def partition_keywords(keywords: List[str], normalized_resume: str, resume_id: int = None, db: Session = None) -> Tuple[List[str], List[str]]:
    """
    Splits keyword lists into matches and gaps.
    Enhanced: If standard keyword match fails, uses pgvector to run a semantic
    similarity scan against the candidate's resume bullets in PostgreSQL.
    """
    found = []
    missing = []
    
    # Import check_semantic_match locally to avoid circular dependency
    from backend.embeddings import check_semantic_match
    
    for kw in keywords:
        # 1. Exact/Sub-word boundary match
        if keyword_found(kw, normalized_resume):
            found.append(kw)
        # 2. Semantic fallback (if pgvector DB is active and a resume is loaded)
        elif resume_id and db and check_semantic_match(kw, resume_id, db):
            found.append(kw)
        else:
            missing.append(kw)
            
    return found, missing

def compute_ats_score(resume_text: str, jd_analysis: Any, resume_id: int = None, db: Session = None) -> Dict[str, Any]:
    """
    Computes keyword coverage percentages and estimates an overall ATS score range.
    """
    normalized_resume = normalize_text(resume_text)

    # Partition all JD categories
    found_req, miss_req = partition_keywords(jd_analysis.required_skills, normalized_resume, resume_id, db)
    found_pref, miss_pref = partition_keywords(jd_analysis.preferred_skills, normalized_resume, resume_id, db)
    found_soft, miss_soft = partition_keywords(jd_analysis.soft_skills, normalized_resume, resume_id, db)
    found_ats, miss_ats = partition_keywords(jd_analysis.ats_keywords, normalized_resume, resume_id, db)
    found_ind, miss_ind = partition_keywords(jd_analysis.industry_terms, normalized_resume, resume_id, db)

    # Helper function to compute percentages
    def pct(found_len: int, total_len: int) -> int:
        return 100 if total_len == 0 else int(round((found_len / total_len) * 100))

    req_cov = pct(len(found_req), len(jd_analysis.required_skills))
    pref_cov = pct(len(found_pref), len(jd_analysis.preferred_skills))
    soft_cov = pct(len(found_soft), len(jd_analysis.soft_skills))
    ats_cov = pct(len(found_ats), len(jd_analysis.ats_keywords))

    # Composite score computation (weights: required 50%, ats 30%, preferred 15%, soft 5%)
    score = int(round(req_cov * 0.50 + ats_cov * 0.30 + pref_cov * 0.15 + soft_cov * 0.05))

    # Compute confidence band (larger range near the center)
    half_band = 9 if (20 < score < 80) else 5
    score_min = max(0, score - half_band)
    score_max = min(100, score + half_band)

    # Deduplicate gaps (required + ATS priority) and limit to top 10
    gaps = list(dict.fromkeys(miss_req + miss_ats))[:10]

    method_note = (
        f"{score_min}–{score_max}%, based on keyword & semantic matching "
        f"(required ×0.50, ATS keywords ×0.30, preferred ×0.15, soft ×0.05); "
        f"actual ATS behavior varies by vendor and is not guaranteed."
    )

    return {
        "score": score,
        "scoreMin": score_min,
        "scoreMax": score_max,
        "methodNote": method_note,
        "requiredCoverage": req_cov,
        "preferredCoverage": pref_cov,
        "softCoverage": soft_cov,
        "atsCoverage": ats_cov,
        "foundRequired": found_req,
        "missingRequired": miss_req,
        "foundPreferred": found_pref,
        "missingPreferred": miss_pref,
        "foundSoft": found_soft,
        "missingSoft": miss_soft,
        "foundAtsKeywords": found_ats,
        "missingAtsKeywords": miss_ats,
        "skillGaps": gaps,
        "experienceLevel": jd_analysis.experience_level,
        "industryTerms": found_ind,
        "industryTermsMissing": miss_ind
    }

# --------------------------------------------------------------------------
# 7. Candidate Quality Ranking (Translated from ranking-pipeline.js)
# --------------------------------------------------------------------------

def compute_preservation_score(original_latex: str, tailored_latex: str) -> int:
    """Calculates how closely the output LaTeX matches the structure of the input."""
    if not original_latex or not tailored_latex:
        return 50
    orig_lines = len(original_latex.split("\n"))
    tail_lines = len(tailored_latex.split("\n"))
    orig_chars = len(original_latex)
    tail_chars = len(tailored_latex)

    line_pct = abs(orig_lines - tail_lines) / max(1, orig_lines)
    char_pct = abs(orig_chars - tail_chars) / max(1, orig_chars)

    score = max(0, 100 - (line_pct * 40 + char_pct * 30))
    return int(round(score))

def count_changed_bullets(original_latex: str, tailored_latex: str) -> int:
    """Compares the bullets of two resumes to count how many were modified."""
    from backend.routes.parser import parse_latex_to_ast
    orig_ast = parse_latex_to_ast(original_latex)
    tail_ast = parse_latex_to_ast(tailored_latex)
    changed = 0

    for i, orig_sec in enumerate(orig_ast.get("sections", [])):
        if i >= len(tail_ast.get("sections", [])):
            break
        tail_sec = tail_ast["sections"][i]
        for j, ob in enumerate(orig_sec.get("bullets", [])):
            if j >= len(tail_sec.get("bullets", [])):
                break
            tb = tail_sec["bullets"][j]
            if ob["text"].strip() != tb["text"].strip():
                changed += 1
                
    return changed

def rank_candidates(original_latex: str, candidates: List[Dict[str, Any]], jd_analysis: Any) -> List[Dict[str, Any]]:
    """
    Ranks multiple tailoring candidates by a quality score:
    - 60% ATS score weight.
    - 25% Changes density score (rewards modifying bullets up to a limit).
    - 15% Layout/spacing preservation score.
    Returns ranked candidates best-first.
    """
    scored = []
    
    from backend.routes.parser import latex_to_plain_text

    for c in candidates:
        if not c or not c.get("latex"):
            continue
            
        plain = latex_to_plain_text(c["latex"])
        # Run ATS scoring
        ats_rep = compute_ats_score(plain, jd_analysis)
        ats_score = ats_rep["score"]

        pres_score = compute_preservation_score(original_latex, c["latex"])
        change_count = count_changed_bullets(original_latex, c["latex"])

        # Changes density curve: rewards edits up to ~15 bullets, penalizes extreme rewrites
        changes_score = min(100, change_count * 8) - max(0, (change_count - 15) * 5)
        norm_changes = max(0, min(100, changes_score))

        # Composite formula
        total_score = int(round(
            ats_score * 0.60 +
            norm_changes * 0.25 +
            pres_score * 0.15
        ))

        scored.append({
            "mode": c["mode"],
            "latex": c["latex"],
            "totalScore": total_score,
            "atsScore": ats_score,
            "preservationScore": pres_score,
            "changeCount": change_count,
            "changesScore": norm_changes,
            "atsReport": ats_rep,
            "changes": c.get("changes", []),
            "fabricationFlags": c.get("fabricationFlags", []),
            "revertedSections": c.get("revertedSections", [])
        })

    # Sort descending
    scored.sort(key=lambda x: x["totalScore"], reverse=True)
    return scored
