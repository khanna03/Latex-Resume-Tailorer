import json
import re
import google.generativeai as genai
from openai import OpenAI
from anthropic import Anthropic

def _clean_json_response(response_text: str) -> dict:
    try:
        return json.loads(response_text.strip())
    except Exception:
        match = re.search(r"\{[\s\S]*\}", response_text)
        if match:
            return json.loads(match.group(0))
        raise ValueError("LLM returned invalid JSON structure: " + response_text[:200])

def generate_json_content(api_key: str, model_name: str, prompt: str) -> dict:
    """
    Universal wrapper for generating JSON content from various LLM providers.
    Detects provider based on API key prefix.
    """
    if not api_key:
        raise ValueError("API key is required.")

    if api_key.startswith("sk-ant-"):
        # Anthropic
        client = Anthropic(api_key=api_key)
        response = client.messages.create(
            model=model_name,
            max_tokens=4096,
            messages=[{"role": "user", "content": prompt}]
        )
        return _clean_json_response(response.content[0].text)

    elif api_key.startswith("sk-"):
        # OpenAI
        client = OpenAI(api_key=api_key)
        # Ensure model name compatibility
        if not model_name.startswith("gpt-"):
            model_name = "gpt-4o"
            
        response = client.chat.completions.create(
            model=model_name,
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": prompt}]
        )
        return _clean_json_response(response.choices[0].message.content)

    else:
        # Default to Gemini
        genai.configure(api_key=api_key)
        # Ensure model name compatibility
        if not model_name.startswith("gemini-"):
            model_name = "gemini-2.5-flash"
            
        model = genai.GenerativeModel(model_name)
        response = model.generate_content(
            prompt,
            generation_config={"response_mime_type": "application/json"}
        )
        return _clean_json_response(response.text)
