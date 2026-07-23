"""Shared LLM runtime helpers for Ollama-compatible agent modules."""

from __future__ import annotations

import os
import time

import httpx


DEFAULT_LLM_MODEL = "gpt-oss:20b"
DEFAULT_LLM_BASE_URL = "http://10.10.17.55:80"
# Local Ollama endpoint. Keep disabled unless explicitly running on this machine.
# LOCAL_LLM_BASE_URL = "http://localhost:11434"
DEFAULT_LLM_TIMEOUT = 600
DEFAULT_LLM_RETRIES = 3
DEFAULT_LLM_BACKOFF = 2
DEFAULT_LLM_NUM_CTX = 8192
DEFAULT_LLM_NUM_PREDICT = 8192


def load_llm():
    """Load the shared Ollama-compatible LLM configuration."""
    from langchain_ollama import ChatOllama

    return ChatOllama(
        model=os.environ.get("LLM_MODEL", DEFAULT_LLM_MODEL),
        base_url=os.environ.get("LLM_BASE_URL", DEFAULT_LLM_BASE_URL),
        temperature=0,
        keep_alive="5m",
        num_ctx=int(os.environ.get("LLM_NUM_CTX", DEFAULT_LLM_NUM_CTX)),
        num_predict=int(os.environ.get("LLM_NUM_PREDICT", DEFAULT_LLM_NUM_PREDICT)),
        client_kwargs={"timeout": DEFAULT_LLM_TIMEOUT},
    )


def resilient_llm_invoke(llm, messages, *, retries=DEFAULT_LLM_RETRIES, backoff=DEFAULT_LLM_BACKOFF):
    """Invoke the LLM with retries for transient endpoint failures."""
    last_error = None
    for attempt in range(1, retries + 1):
        try:
            print(f"     * LLM invoke attempt {attempt}/{retries}...")
            return llm.invoke(messages)
        except Exception as exc:
            last_error = exc
            wait = backoff * attempt
            print(f"     ! LLM invoke failed on attempt {attempt}/{retries}: {exc}")
            if attempt < retries:
                print(f"       Retrying in {wait}s...")
                time.sleep(wait)
    raise last_error
