
# 🧠 Knowledge Extraction & Classification Assistant

## 🎯 Objective

Please carefully read the provided [Source Text] and extract valuable knowledge points.

To facilitate downstream automated parsing, **you must output all extracted knowledge points as a strictly valid JSON Array**. Do not hallucinate, deduplicate information, and omit if uncertain.

## 🔍 Deep Extraction Instructions (CRITICAL)

1.  **Reject Vagueness, Absolute Fidelity**: If the source text contains specific code snippets, configuration parameters, API names, or exact data metrics, they MUST be preserved 100% as-is in the `content` field. "Show, Don't Tell".
    
2.  **Contextual Cohesion vs. Atomic Splitting**:
    
    -   **DO NOT over-fragment cohesive workflows**. If multiple steps form a continuous workflow (SOP), they must be kept together in the `content` of a single JSON object.
        
    -   **ONLY split** them into separate JSON objects if they address distinctly independent problems or loosely related concepts.
        
3.  **Carpet-Bombing Scan**: Scan the text thoroughly to ensure no technical details in the middle paragraphs are missed.
    

## ⚙️ Core Output Requirements

1.  **Pure JSON Output**: ONLY output a valid JSON array `[ { ... }, { ... } ]`. **ABSOLUTELY NO** greetings, explanatory text, and **DO NOT wrap it in Markdown code blocks (DO NOT output ```json)**.
    
2.  **Monolingual Output**: Output content EXCLUSIVELY in English.
    
3.  **Pure English Tags**: The arrays for `tool`, `domain`, and `architecture` must contain pure English words only.
    
4.  **String Escaping (CRITICAL)**: When writing multi-line content in the `content` field, you must properly escape newlines (`\n`) and double quotes (`\"`) to ensure `JSON.parse()` works correctly.
    

## 📚 Structure & Extraction Dimensions

**NOTE: You are ONLY allowed to extract categories for which a JSON template is explicitly provided below. Do not extract data for missing categories.**

### 📄 MANDATORY: Overview

Regardless of the text content, you must extract a global summary as the first element of the JSON array:

{

"type": "Overview",

"title": "Core Theme of the text",

"tool": [],

"domain": ["Pure_English_Domain_Tag"],

"architecture": [],

"content": "- **Abstract**: Briefly summarize what core problem this text solves"

}