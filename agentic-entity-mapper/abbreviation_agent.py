"""
Agent 1: PII Masking + Abbreviation Resolution Agent

A LangGraph-based agent that handles:
- PII (Personally Identifiable Information) detection and masking
- Abbreviation resolution using SciSpacy
- Abbreviation expansion using MedialPy

Tools:
- mask_pii: Detects and masks PII (called first if PII detected)
- resolve_abbreviations: SciSpacy abbreviation resolution
- expand_abbreviations_medialpy: MedialPy abbreviation expansion
"""

import re
import json
import time
import httpx
import os
import functools
from typing import TypedDict, Literal

try:
    import medialpy
except Exception as exc:
    medialpy = None
    print(f"Medical abbreviation dictionary unavailable; local text will be retained: {exc}")
from langchain_core.messages import HumanMessage
from pydantic import BaseModel, Field

# Import centralized prompts
from prompts import load_prompt, format_prompt
from schema_terminology_assets import get_biomedical_ner_model_path


USE_PII_LLM_REVIEW = os.getenv("AGENTIC_PII_LLM_REVIEW", "").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}


@functools.lru_cache(maxsize=1)
def load_privacy_ner_model():
    """Load a local general-domain NER model when one is installed."""
    import spacy

    model_name = os.getenv("AGENTIC_PII_SPACY_MODEL", "en_core_web_sm").strip()
    if not model_name:
        print("Privacy NER model is disabled; using local format recognizers.")
        return None
    print(f"Loading privacy NER model: {model_name}...")
    try:
        model = spacy.load(model_name)
        print(f"   Privacy NER model loaded: {model_name}")
        return model
    except Exception as exc:
        print(
            f"Privacy NER model '{model_name}' is unavailable; "
            f"using local format recognizers: {exc}"
        )
        return None


def _apply_privacy_spans(text: str, spans: list[tuple[int, int, str]]) -> str:
    selected = []
    for start, end, placeholder in sorted(spans, key=lambda item: (item[0], -(item[1] - item[0]))):
        if start < 0 or end <= start or end > len(text):
            continue
        if selected and start < selected[-1][1]:
            continue
        selected.append((start, end, placeholder))

    result = text
    for start, end, placeholder in reversed(selected):
        result = result[:start] + placeholder + result[end:]
    return result


def _spans_overlap(left_start: int, left_end: int, right_start: int, right_end: int) -> bool:
    return left_start < right_end and right_start < left_end


def _overlaps_protected_span(start: int, end: int, protected_spans: list[tuple[int, int]]) -> bool:
    return any(
        _spans_overlap(start, end, protected_start, protected_end)
        for protected_start, protected_end in protected_spans
    )


def _mask_organization_entities() -> bool:
    """Allow deployments to opt into stricter organization-name masking."""
    return os.getenv("AGENTIC_PII_MASK_ORGANIZATIONS", "").strip().lower() in {
        "1",
        "true",
        "yes",
        "on",
    }


@functools.lru_cache(maxsize=1)
def load_biomedical_ner_model():
    """Load the local biomedical token classifier used to protect clinical spans."""
    model_path = get_biomedical_ner_model_path()
    if model_path is None:
        print(
            "Biomedical NER model is unavailable; PERSON/clinical conflicts "
            "will use privacy-safe masking."
        )
        return None

    print(f"Loading biomedical NER model: {model_path}...")
    try:
        from transformers import (
            AutoModelForTokenClassification,
            AutoTokenizer,
            pipeline,
        )

        tokenizer = AutoTokenizer.from_pretrained(model_path, local_files_only=True)
        model = AutoModelForTokenClassification.from_pretrained(
            model_path,
            local_files_only=True,
        )
        ner_pipeline = pipeline(
            "token-classification",
            model=model,
            tokenizer=tokenizer,
            aggregation_strategy="simple",
            device=-1,
        )
        print(f"   Biomedical NER model loaded: {model_path}")
        return ner_pipeline
    except Exception as exc:
        print(
            f"Biomedical NER model could not be loaded; "
            f"using privacy-safe masking: {exc}"
        )
        return None


def _biomedical_ner_min_score() -> float:
    """Return the configurable confidence floor for clinical/PII conflicts."""
    try:
        return min(
            1.0,
            max(0.0, float(os.getenv("AGENTIC_BIOMEDICAL_NER_MIN_SCORE", "0.8"))),
        )
    except ValueError:
        return 0.8


def _biomedical_model_spans(text: str) -> list[tuple[int, int]]:
    """Collect offsets directly from biomedical model predictions."""
    try:
        model = load_biomedical_ner_model()
    except Exception as exc:
        print(f"Biomedical NER loading failed; using privacy-safe masking: {exc}")
        return []
    if model is None:
        return []
    try:
        predictions = model(text)
    except Exception as exc:
        print(f"Biomedical NER inference failed; using privacy-safe masking: {exc}")
        return []

    spans = []
    for prediction in predictions if isinstance(predictions, list) else []:
        if not isinstance(prediction, dict):
            continue
        start = prediction.get("start")
        end = prediction.get("end")
        try:
            score = float(prediction.get("score", 0.0))
        except (TypeError, ValueError):
            continue
        if (
            score >= _biomedical_ner_min_score()
            and isinstance(start, int)
            and isinstance(end, int)
            and 0 <= start < end <= len(text)
        ):
            spans.append((start, end))
    return spans


def _privacy_model_entities(text: str):
    """Return PII model entities, or None when the optional model cannot run."""
    try:
        model = load_privacy_ner_model()
    except Exception as exc:
        print(f"Privacy NER loading failed; using local format recognizers: {exc}")
        return None
    if model is None:
        return None
    try:
        return list(model(text).ents)
    except Exception as exc:
        print(f"Privacy NER inference failed; using local format recognizers: {exc}")
        return None


def mask_pii_locally(text: str) -> str:
    """De-identify text locally before it crosses any model boundary."""
    source = str(text or "")
    if not source:
        return ""

    spans: list[tuple[int, int, str]] = []
    protected_spans = _biomedical_model_spans(source)
    privacy_entities = _privacy_model_entities(source)
    if privacy_entities is not None:
        for entity in privacy_entities:
            if entity.label_ == "PERSON":
                protected_clinical_span = _overlaps_protected_span(
                    entity.start_char,
                    entity.end_char,
                    protected_spans,
                )
                if not protected_clinical_span:
                    protected_clinical_span = bool(
                        _biomedical_model_spans(
                            source[entity.start_char : entity.end_char]
                        )
                    )
                if not protected_clinical_span:
                    spans.append((entity.start_char, entity.end_char, "[NAME]"))
            elif entity.label_ == "ORG":
                if _mask_organization_entities():
                    spans.append((entity.start_char, entity.end_char, "[PII]"))
            elif entity.label_ in {"GPE", "LOC", "FAC"}:
                spans.append((entity.start_char, entity.end_char, "[PII]"))

    format_patterns = (
        (r"\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b", "[EMAIL]", re.IGNORECASE),
        (r"(?<!\w)(?:\+?\d[\d .()\-]{7,}\d)(?!\w)", "[PHONE]", 0),
        (r"\b\d{3}-\d{2}-\d{4}\b", "[SSN]", 0),
        (r"\b(?:\d[ -]*?){13,19}\b", "[CREDIT_CARD]", 0),
        (r"\b(?:\d{1,3}\.){3}\d{1,3}\b", "[PII]", 0),
    )
    for pattern, placeholder, flags in format_patterns:
        for match in re.finditer(pattern, source, flags):
            spans.append((match.start(), match.end(), placeholder))

    # Preserve a short dotted title while masking the following proper-name span.
    titled_name = re.compile(
        r"\b[A-Z][a-z]{0,2}\.\s+(?P<name>[A-Z][a-z]+(?:[-'][A-Za-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Za-z]+)?){0,3})"
    )
    for match in titled_name.finditer(source):
        spans.append((match.start("name"), match.end("name"), "[NAME]"))

    # Privacy-safe fallback for multi-token proper nouns when general NER is unavailable.
    if privacy_entities is None:
        proper_sequence = re.compile(
            r"\b[A-Z][a-z]+(?:[-'][A-Za-z]+)?(?:\s+[A-Z][a-z]+(?:[-'][A-Za-z]+)?){2,}\b"
        )
        for match in proper_sequence.finditer(source):
            if not _overlaps_protected_span(
                match.start(),
                match.end(),
                protected_spans,
            ):
                spans.append((match.start(), match.end(), "[PII]"))

    return _apply_privacy_spans(source, spans)


@functools.lru_cache(maxsize=1)
def load_spacy_model():
    """Load spaCy model with abbreviation detector."""
    import spacy
    from scispacy.abbreviation import AbbreviationDetector
    model_names = ["en_core_sci_sm", "en_core_web_sm"]
    nlp = None
    for model_name in model_names:
        print(f"Loading spaCy language model: {model_name}...")
        try:
            nlp = spacy.load(model_name)
            print(f"   spaCy language model loaded: {model_name}")
            break
        except OSError as exc:
            print(f"   spaCy language model unavailable: {model_name} ({exc})")
            continue

    if nlp is None:
        print("⚠ spaCy model not found; using blank English pipeline without abbreviation detection.")
        nlp = spacy.blank("en")
        print("   Blank spaCy English pipeline loaded.")

    if "abbreviation_detector" not in nlp.pipe_names:
        try:
            nlp.add_pipe("abbreviation_detector")
            print("   spaCy abbreviation detector loaded.")
        except Exception:
            print("⚠ Could not attach abbreviation detector; continuing without abbreviation resolution.")
    return nlp


def load_llm():
    """Load Ollama LLM with resilient connection settings."""
    from langchain_ollama import ChatOllama
    model = os.environ.get("LLM_MODEL", "gpt-oss:20b")
    base_url = os.environ.get("LLM_BASE_URL", "http://10.10.17.55:80")
    # Local Ollama endpoint alternative. Keep disabled unless explicitly requested.
    # local_base_url = "http://localhost:11434"
    print(f"Configuring abbreviation LLM client for model: {model}...")
    client = ChatOllama(
        model=model,
        base_url=base_url,
        temperature=0,
        keep_alive="5m",
        num_predict=2048,
        client_kwargs={"timeout": 600},
    )
    print("   Abbreviation LLM client configured; availability is checked on first invocation.")
    return client


def resilient_llm_invoke(llm, messages, *, retries=3, backoff=2):
    """Invoke the LLM with automatic retry on transient connection errors."""
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            return llm.invoke(messages)
        except Exception as exc:
            last_error = exc
            wait = backoff * attempt
            print(f"   \u26a0 LLM connection/parsing error (attempt {attempt}/{retries}): {exc}")
            print(f"     Retrying in {wait}s...")
            time.sleep(wait)
    raise last_error


def run_abbreviation_agent(
    input_text: str,
    add_flow_step_callback=None,
    render_flow_callback=None,
    flow_placeholder=None
) -> tuple[str, list]:
    """
    Run Agent 1: PII Masking + Abbreviation Resolution using LangGraph.
    
    Args:
        input_text: The text to process
        add_flow_step_callback: Optional callback to add flow steps for UI
        render_flow_callback: Optional callback to render flow diagram
        flow_placeholder: Optional Streamlit placeholder for flow rendering
        
    Returns:
        Tuple of (processed_text, logs)
        - processed_text: The text after PII masking and abbreviation resolution
        - logs: List of log messages from the agent execution
    """
    
    # Log container for tracking execution
    logs = []
    try:
        nlp = load_spacy_model()
    except Exception as exc:
        nlp = None
        message = (
            "⚠ spaCy initialization failed; abbreviation detection will be skipped "
            f"and privacy masking will continue: {exc}"
        )
        print(message)
        logs.append(message)
    try:
        llm = load_llm()
    except Exception as exc:
        llm = None
        message = (
            "⚠ Abbreviation LLM initialization failed; local processing will continue "
            f"without model-assisted expansion: {exc}"
        )
        print(message)
        logs.append(message)
    
    # Helper to add flow step if callback provided
    def add_flow_step(name, status="active"):
        if add_flow_step_callback:
            add_flow_step_callback(name, status)
        if render_flow_callback and flow_placeholder:
            render_flow_callback(flow_placeholder)
    
    # -------------------------------------------------------------------------
    # Disambiguation LLM
    # -------------------------------------------------------------------------
    class DisambiguationResult(BaseModel):
        selected_meaning: str = Field(description="The most appropriate meaning for the abbreviation based on context")
    
    def disambiguate_abbreviation(text: str, abbreviation: str, meanings: list) -> str:
        """Uses LLM to disambiguate an abbreviation with multiple meanings."""
        meanings_text = chr(10).join([f'{i+1}. {m}' for i, m in enumerate(meanings)])
        prompt = format_prompt("disambiguation", text=text, abbreviation=abbreviation, meanings=meanings_text)
        
        logs.append(f"🧠 LLM Disambiguation for '{abbreviation}'")
        logs.append(f"   Options: {meanings}")
        
        response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
        selected = response.content.strip()
        
        # Validate response
        selected_lower = selected.lower()
        for meaning in meanings:
            if meaning.lower() in selected_lower or selected_lower in meaning.lower():
                logs.append(f"   Selected: {meaning}")
                return meaning
        
        logs.append(f"   Selected (default): {meanings[0]}")
        return meanings[0]

    def fallback_llm_expand(text: str, abbreviation: str) -> str:
        """Uses LLM to explicitly expand an abbreviation when MedialPy fails."""
        prompt = (
            "You are a medical abbreviation expert. Expand the supplied abbreviation only when "
            "the surrounding text supports one clinically equivalent long form. Return only that "
            "expanded form, without explanation or punctuation. If the token is not an abbreviation "
            "or its meaning is not supported by context, return it unchanged.\n\n"
            f"Abbreviation: {abbreviation}\n"
            f"Context: {text}"
        )
        
        try:
            response = resilient_llm_invoke(llm, [HumanMessage(content=prompt)])
            expansion = response.content.strip()
            # If the LLM just returns the same thing or is too long, reject it
            if len(expansion) > len(abbreviation) + 50 or expansion.lower() == abbreviation.lower():
                return abbreviation
            return expansion
        except Exception:
            return abbreviation
    
    # -------------------------------------------------------------------------
    # Define Pipeline Steps (formerly Tools)
    # -------------------------------------------------------------------------
    def resolve_abbreviations(text: str) -> str:
        """
        Resolves abbreviations in the input text using scispacy abbreviation detector.
        """
        add_flow_step("SciSpacy")
        logs.append("🔧 Step: resolve_abbreviations (SciSpacy)")
        
        try:
            doc = nlp(text)
            detected_abbreviations = list(doc._.abbreviations)
        except Exception as exc:
            logs.append(
                f"   ⚠️ SciSpacy abbreviation resolution unavailable; "
                f"retained input text: {exc}"
            )
            return text
        replacements = []
        abbreviations_found = []

        for abrv in detected_abbreviations:
            abbr_start = abrv.start_char
            abbr_end = abrv.end_char
            lf = abrv._.long_form
            lf_start = lf.start_char
            lf_end = lf.end_char
            
            abbr_text = text[abbr_start:abbr_end]
            abbreviations_found.append({"abbreviation": abbr_text, "long_form": str(lf)})
            
            if abs(abbr_start - lf_end) <= 5 or abs(lf_start - abbr_end) <= 5:
                replacements.append((abbr_start, abbr_end, ""))
            else:
                replacements.append((abbr_start, abbr_end, str(lf)))
        
        replacements.sort(key=lambda x: x[0], reverse=True)
        
        result = text
        for start, end, repl in replacements:
            result = result[:start] + repl + result[end:]
        result = re.sub(r"\(\s*\)", "", result)
        result = re.sub(r"\s{2,}", " ", result).strip()
        
        if abbreviations_found:
            for ab in abbreviations_found:
                logs.append(f"   {ab['abbreviation']} → {ab['long_form']}")
        else:
            logs.append("   No abbreviations detected by SciSpacy")
        
        return result
    
    def expand_abbreviations_medialpy(text: str) -> str:
        """
        Expands abbreviations using MedialPy medical abbreviation database.
        """
        add_flow_step("MedialPy")
        logs.append("🔧 Step: expand_abbreviations_medialpy (MedialPy + LLM Fallback)")
        if llm is None:
            logs.append("   ⚠️ Model-assisted abbreviation expansion unavailable; retained local text.")
            return text
        
        identify_prompt = format_prompt("identify_abbreviations", text=text)
        logs.append("   🧠 Using LLM to identify abbreviations...")
        
        abbreviations = []
        try:
            response = resilient_llm_invoke(llm, [HumanMessage(content=identify_prompt)])
            response_text = response.content.strip()
            
            json_match = re.search(r'\{[^{}]*"abbreviations"[^{}]*\[.*?\][^{}]*\}', response_text, re.DOTALL)
            if json_match:
                result = json.loads(json_match.group())
                abbreviations = result.get("abbreviations", [])
            else:
                try:
                    result = json.loads(response_text)
                    abbreviations = result.get("abbreviations", [])
                except:
                    pass
            
        except Exception as e:
            logs.append(f"   ⚠️ LLM identification failed: {str(e)}")
            
        if abbreviations:
            logs.append(f"   📋 Identified abbreviations to expand: {abbreviations}")
        else:
            logs.append("   No abbreviations identified by the context-aware extractor")
            return text
        
        result_text = text
        for abbr in abbreviations:
            normalized = re.sub(r"[^A-Za-z0-9]", "", abbr).upper()
            if not normalized:
                continue
                
            try:
                expansion = None
                term = medialpy.find(normalized)
                if term:
                    meanings = term.meaning
                    if len(meanings) == 1:
                        expansion = meanings[0]
                        logs.append(f"   {abbr} → {expansion} (MedialPy)")
                    else:
                        expansion = disambiguate_abbreviation(text, abbr, meanings)
                        logs.append(f"   {abbr} → {expansion} (MedialPy Disambiguated)")
                else:
                    # MedialPy failed, use explicit LLM fallback
                    expansion = fallback_llm_expand(text, abbr)
                    if expansion and expansion.lower() != abbr.lower():
                        logs.append(f"   {abbr} → {expansion} (LLM Fallback)")
                    else:
                        logs.append(f"   ⚠️ Could not expand '{abbr}' (Not found in MedialPy or LLM)")
                        continue
                
                if expansion:
                    def replace_overlap(match):
                        start = match.start()
                        context_before = match.string[max(0, start-100):start]
                        
                        lower_exp = expansion.lower()
                        lower_abbr = abbr.lower()
                        
                        # Check if the full expansion is already right before it
                        if context_before.rstrip().lower().endswith(lower_exp):
                            return match.group(0)
                            
                        # Check if expansion ends with the abbreviation, and the prefix is right before it
                        if lower_exp.endswith(lower_abbr) and len(lower_exp) > len(lower_abbr):
                            prefix = expansion[:-len(abbr)].strip()
                            if prefix and context_before.rstrip().lower().endswith(prefix.lower()):
                                return match.group(0)
                                
                        return expansion
                        
                    pattern = re.compile(r'\b' + re.escape(abbr) + r'\b', re.IGNORECASE)
                    result_text = pattern.sub(replace_overlap, result_text)
                    
            except Exception as e:
                logs.append(f"   ⚠️ Lookup/Expand failed for {abbr}: {str(e)}")
        
        result_text = re.sub(r'\s{2,}', ' ', result_text).strip()
        return result_text
    
    def mask_pii(text: str) -> str:
        """
        Detect and mask PII locally before any optional model review.
        """
        add_flow_step("PII Masking")
        logs.append("🔧 Step: mask_pii")

        try:
            locally_masked = mask_pii_locally(text)
        except Exception as exc:
            locally_masked = "[TEXT REDACTED: LOCAL PRIVACY PROCESSING UNAVAILABLE]"
            logs.append(
                "   ⚠️ Local privacy processing failed; the text was fully redacted "
                f"instead of being sent across a model boundary: {exc}"
            )
        logs.append(f"   Local masked output: {locally_masked[:100]}...")
        if not USE_PII_LLM_REVIEW:
            return locally_masked

        pii_prompt = format_prompt("pii_masking", text=locally_masked)
        try:
            response = resilient_llm_invoke(llm, [HumanMessage(content=pii_prompt)])
            masked_text = response.content.strip()
            if masked_text:
                logs.append(f"   Reviewed masked output: {masked_text[:100]}...")
                return masked_text
            logs.append("   PII review returned empty output; retained local masking.")
            return locally_masked
        except Exception as e:
            logs.append(f"   ⚠️ Optional PII review failed; retained local masking: {str(e)}")
            return locally_masked
    
    # -------------------------------------------------------------------------
    # Execute Pipeline
    # -------------------------------------------------------------------------
    add_flow_step("Agent 1")
    
    logs.append("=" * 50)
    logs.append("🚀 STARTING AGENT 1: PII Masking + Abbreviation Resolution (Procedural)")
    logs.append("=" * 50)
    logs.append(f"📝 Input received ({len(input_text)} characters)")
    
    # Step 1: PII Masking
    masked_text = mask_pii(input_text)
    
    # Step 2: SciSpacy Abbreviation Resolution
    scispacy_text = resolve_abbreviations(masked_text)
    
    # Step 3: MedialPy Abbreviation Expansion
    final_text = expand_abbreviations_medialpy(scispacy_text)
    
    logs.append("=" * 50)
    logs.append("🏁 AGENT 1 COMPLETE")
    logs.append("=" * 50)
    logs.append(f"📤 Output: {final_text}")
    
    return final_text, logs
