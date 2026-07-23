"""
Prompt Loader Utility

Centralized prompt management for the medical text processing pipeline.
Each prompt is stored in a separate .txt file for easy editing and improvement.
"""

from pathlib import Path

# Directory containing prompt files
PROMPTS_DIR = Path(__file__).parent


def load_prompt(name: str) -> str:
    """
    Load a prompt template from file.
    
    Args:
        name: Name of the prompt (without .txt extension)
        
    Returns:
        The prompt template string
        
    Raises:
        FileNotFoundError: If the prompt file doesn't exist
    """
    prompt_path = PROMPTS_DIR / f"{name}.txt"
    
    if not prompt_path.exists():
        raise FileNotFoundError(f"Prompt file not found: {prompt_path}")
    
    with open(prompt_path, 'r', encoding='utf-8') as f:
        return f.read()


def format_prompt(name: str, **kwargs) -> str:
    """
    Load a prompt template and format it with provided variables.
    
    Args:
        name: Name of the prompt (without .txt extension)
        **kwargs: Variables to substitute in the template
        
    Returns:
        The formatted prompt string
        
    Example:
        prompt = format_prompt("pii_masking", text="Patient John Smith...")
    """
    template = load_prompt(name)
    return template.format(**kwargs)


def list_prompts() -> list:
    """
    List all available prompt names.
    
    Returns:
        List of prompt names (without .txt extension)
    """
    return [p.stem for p in PROMPTS_DIR.glob("*.txt")]
