# ==============================================================================
# LaTeX Resume Tailorer — Local LLM Fine-Tuning Script (Phase 5/6)
# ==============================================================================
#
# PURPOSE:
#   This standalone script fine-tunes an open-weight Large Language Model (LLM)
#   on your exported resume-tailoring dataset. The result is a private, local
#   model that can generate tailored resumes without any external API calls.
#
# HOW IT WORKS (High-Level):
#   1. Loads the JSONL dataset exported from the Curricula AI frontend.
#   2. Filters for only high-quality examples (user-rated 4+ stars).
#   3. Formats each example into a "ChatML" prompt (system → user → assistant).
#   4. Applies QLoRA (Quantized Low-Rank Adaptation) to freeze the base model
#      and only train tiny adapter matrices — dramatically reducing VRAM usage.
#   5. Uses HuggingFace's SFTTrainer for Supervised Fine-Tuning (SFT).
#   6. Saves the trained LoRA adapter weights to disk.
#
# USAGE:
#   pip install -r requirements-ml.txt
#   python backend/scripts/fine_tune.py --data_path path/to/dataset.jsonl
#
# KEY CONCEPTS FOR STUDY:
#   - QLoRA: Combines 4-bit quantization (bitsandbytes) with LoRA adapters.
#     Instead of fine-tuning all ~8 billion parameters, we only train ~0.1% of
#     them (the low-rank adapter matrices), reducing VRAM from ~32GB to ~6GB.
#   - SFT (Supervised Fine-Tuning): The standard approach for instruction-tuning
#     LLMs. We show the model input-output pairs and train it to reproduce the
#     desired outputs (the tailored LaTeX resume).
#   - ChatML: A standardized prompt format used by modern LLMs to distinguish
#     between system instructions, user messages, and assistant responses.
# ==============================================================================

import json
import os
import argparse

# HuggingFace 'datasets' library — provides efficient, memory-mapped dataset handling.
# It wraps Apache Arrow tables under the hood for zero-copy reads.
from datasets import Dataset

# PyTorch — the deep learning framework that powers the entire training loop.
import torch

# 'transformers' — HuggingFace's main library for loading pretrained models and tokenizers.
# AutoModelForCausalLM: Auto-detects architecture (LLaMA, Mistral, etc.) from the model name.
# AutoTokenizer: Loads the correct tokenizer that matches the model's vocabulary.
# TrainingArguments: A dataclass that configures the training loop (batch size, LR, etc.).
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments

# 'peft' (Parameter-Efficient Fine-Tuning) — HuggingFace library for LoRA adapters.
# LoraConfig: Defines which layers to add adapters to and the rank/alpha hyperparameters.
# get_peft_model: Wraps a base model with LoRA adapter layers.
# prepare_model_for_kbit_training: Freezes the base model and enables gradient checkpointing
#   for quantized (4-bit) models, which is required before applying LoRA.
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training

# 'trl' (Transformer Reinforcement Learning) — HuggingFace library for alignment training.
# SFTTrainer: A specialized Trainer subclass that handles formatting text datasets
#   and running the supervised fine-tuning loop with PEFT adapters.
from trl import SFTTrainer


def parse_args():
    """
    Parse command-line arguments for the training script.
    This makes the script flexible — you can change the base model, dataset path,
    output directory, and number of epochs without editing the code.
    """
    parser = argparse.ArgumentParser(description="Fine-tune a local LLM for Resume Tailoring (Phase 5/6)")
    parser.add_argument("--data_path", type=str, default="resume_training_dataset.jsonl", help="Path to the JSONL dataset exported from the backend")
    parser.add_argument("--model_name", type=str, default="unsloth/llama-3-8b-bnb-4bit", help="Base model from HuggingFace")
    parser.add_argument("--output_dir", type=str, default="./models/resume-tailorer-lora", help="Directory to save the fine-tuned adapter")
    parser.add_argument("--num_epochs", type=int, default=3, help="Number of training epochs")
    return parser.parse_args()


def load_and_format_dataset(data_path: str):
    """
    Loads the exported JSONL dataset and formats it for instruction tuning.

    STUDY NOTES — Why ChatML Format?
    ---------------------------------
    Modern LLMs are trained to follow a specific prompt structure. The ChatML
    format uses special tokens to delineate roles:
      <|begin_of_text|>        → Start of the entire conversation
      <|start_header_id|>role  → Identifies who is speaking (system/user/assistant)
      <|eot_id|>               → End of that role's message

    By formatting our training data this way, the model learns to:
      1. Read the system prompt (its role as a resume tailorer)
      2. Parse the user's request (original LaTeX + job title)
      3. Generate the correct assistant response (tailored LaTeX)

    STUDY NOTES — Why Filter by Rating?
    ------------------------------------
    Not all generated outputs are equally good. By only training on examples
    the user rated 4+ stars, we teach the model to reproduce high-quality
    outputs and avoid reinforcing poor generations (a form of data curation).

    Parameters:
        data_path: Path to the JSONL file exported from the UI's "Export Dataset" button

    Returns:
        A HuggingFace Dataset object with a single 'text' column containing
        formatted ChatML prompts ready for SFTTrainer.
    """
    if not os.path.exists(data_path):
        raise FileNotFoundError(f"Dataset not found at {data_path}. Please export it via the UI first.")

    formatted_data = {"text": []}
    
    with open(data_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            
            record = json.loads(line)
            
            # ---- Quality Gate: Only train on user-approved outputs ----
            # This prevents the model from learning to reproduce bad tailoring.
            if record.get("rating_stars", 0) < 4:
                continue
            
            # ---- System Prompt: Defines the model's role and expertise ----
            system_msg = "You are an expert LaTeX Resume Tailorer. You rewrite resumes to match a given job title while maintaining perfect LaTeX syntax."
            
            # ---- User Prompt: Contains the original resume + target job ----
            user_msg = (
                f"Job Title: {record.get('prompt_job_title', 'Software Engineer')}\n"
                f"Mode: {record.get('mode', 'moderate')}\n\n"
                f"Original Resume LaTeX:\n```latex\n{record.get('original_latex', '')}\n```\n\n"
                "Please tailor the above resume for the job title. Return ONLY the new LaTeX source code inside a json block under a 'tailored_latex' key, following the standard format."
            )
            
            # ---- Assistant Response: The "correct answer" we want the model to learn ----
            # Wrapping in JSON matches what our backend parser expects when
            # the model is later used in production via llm_provider.py.
            assistant_response = json.dumps({"tailored_latex": record.get('tailored_latex', '')}, indent=2)
            
            # ---- Assemble the full ChatML prompt ----
            # This is the Llama-3 instruction format. Other models (Mistral, Qwen)
            # use slightly different tokens but the concept is identical.
            prompt = (
                f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{system_msg}<|eot_id|>"
                f"<|start_header_id|>user<|end_header_id|>\n\n{user_msg}<|eot_id|>"
                f"<|start_header_id|>assistant<|end_header_id|>\n\n{assistant_response}<|eot_id|>"
            )
            
            formatted_data["text"].append(prompt)
            
    print(f"Loaded {len(formatted_data['text'])} high-quality training examples.")
    
    # Convert our dict into a HuggingFace Dataset for compatibility with SFTTrainer.
    # HF Datasets are memory-efficient (backed by Apache Arrow) and support lazy loading.
    return Dataset.from_dict(formatted_data)


def main():
    args = parse_args()
    
    # ---- Step 1: Load and prepare the dataset ----
    print(f"Loading dataset from {args.data_path}...")
    dataset = load_and_format_dataset(args.data_path)
    
    if len(dataset) == 0:
        print("Dataset is empty. Exiting.")
        return

    # ---- Step 2: Load the tokenizer ----
    # The tokenizer converts text into numerical token IDs that the model understands.
    # use_fast=True loads the Rust-based tokenizer which is ~10x faster than Python.
    print(f"Loading tokenizer and model {args.model_name}...")
    tokenizer = AutoTokenizer.from_pretrained(args.model_name, use_fast=True)
    
    # STUDY NOTE: Many base models don't have a dedicated padding token.
    # We reuse the End-Of-Sequence (EOS) token as the pad token to avoid errors
    # during batched training, where sequences need to be the same length.
    tokenizer.pad_token = tokenizer.eos_token
    
    # ---- Step 3: Load the base model with 4-bit quantization ----
    # STUDY NOTE — What is 4-bit Quantization?
    # Normal model weights use 16-bit floats (2 bytes each). An 8B model = ~16GB VRAM.
    # 4-bit quantization compresses each weight to 4 bits (0.5 bytes), cutting VRAM to ~4GB.
    # This is handled by the 'bitsandbytes' library under the hood.
    # device_map="auto" automatically distributes layers across available GPUs/CPU.
    model = AutoModelForCausalLM.from_pretrained(
        args.model_name,
        device_map="auto",
        load_in_4bit=True
    )
    
    # ---- Step 4: Configure LoRA adapters ----
    # STUDY NOTE — What is LoRA (Low-Rank Adaptation)?
    # Instead of updating all 8 billion weights during training, LoRA inserts small
    # "adapter" matrices (rank r=16) into specific attention layers. Only these tiny
    # matrices are trained, while the original weights stay frozen.
    #
    # Key hyperparameters:
    #   r=16:            Rank of the adapter matrices. Higher = more capacity but more VRAM.
    #   lora_alpha=32:   Scaling factor. Rule of thumb: set to 2x the rank.
    #   lora_dropout=0.05: Dropout for regularization (prevents overfitting on small datasets).
    #   target_modules:  Which attention layers to inject adapters into.
    #                    q/k/v/o_proj are the Query, Key, Value, and Output projections
    #                    in the transformer's multi-head self-attention mechanism.
    model = prepare_model_for_kbit_training(model)
    peft_config = LoraConfig(
        r=16,
        lora_alpha=32,
        lora_dropout=0.05,
        target_modules=["q_proj", "k_proj", "v_proj", "o_proj"],
        bias="none",
        task_type="CAUSAL_LM"
    )
    model = get_peft_model(model, peft_config)
    
    # This prints something like: "trainable params: 13M || all params: 8B || trainable%: 0.16%"
    # Confirming that we're only training a tiny fraction of the total parameters!
    model.print_trainable_parameters()

    # ---- Step 5: Configure the training loop ----
    # STUDY NOTE — Key Training Hyperparameters:
    #   per_device_train_batch_size=2: Process 2 examples per GPU at a time.
    #   gradient_accumulation_steps=4: Accumulate gradients over 4 steps before updating.
    #     → Effective batch size = 2 × 4 = 8 (simulates larger batches without extra VRAM).
    #   warmup_ratio=0.03: Slowly ramp up learning rate for the first 3% of training steps.
    #     → Prevents early instability when gradients are noisy.
    #   learning_rate=2e-4: Standard LR for LoRA fine-tuning (much higher than full fine-tuning).
    #   fp16/bf16: Uses half-precision floats for faster training. BF16 is preferred on
    #     newer GPUs (Ampere+) as it has better numerical range than FP16.
    #   optim="paged_adamw_8bit": Memory-efficient optimizer from bitsandbytes.
    #     → Uses 8-bit statistics and paged memory to reduce optimizer VRAM usage.
    training_args = TrainingArguments(
        output_dir=args.output_dir,
        per_device_train_batch_size=2,
        gradient_accumulation_steps=4,
        warmup_ratio=0.03,
        num_train_epochs=args.num_epochs,
        learning_rate=2e-4,
        fp16=not torch.cuda.is_bf16_supported(),
        bf16=torch.cuda.is_bf16_supported(),
        logging_steps=10,
        optim="paged_adamw_8bit",
        save_strategy="epoch",
    )

    # ---- Step 6: Initialize the SFTTrainer and start training ----
    # STUDY NOTE: SFTTrainer is a thin wrapper around HuggingFace's Trainer.
    # It handles tokenizing the 'text' column, applying padding/truncation,
    # computing the causal language modeling loss, and running the optimization loop.
    # max_seq_length=4096 limits how long each training example can be (in tokens).
    # Longer sequences use quadratically more memory due to self-attention.
    print("Initializing SFTTrainer...")
    trainer = SFTTrainer(
        model=model,
        train_dataset=dataset,
        peft_config=peft_config,
        dataset_text_field="text",
        max_seq_length=4096,
        tokenizer=tokenizer,
        args=training_args,
    )

    print("Starting training...")
    trainer.train()
    
    # ---- Step 7: Save the adapter weights ----
    # STUDY NOTE: We only save the LoRA adapter (~50MB), not the full base model (~4GB).
    # To use the model later, you load the base model + merge the adapter on top.
    # This is extremely storage-efficient for experimentation.
    print(f"Saving fine-tuned adapter to {args.output_dir}...")
    trainer.model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print("Fine-tuning complete! You can now serve this model using vLLM or Ollama.")


if __name__ == "__main__":
    main()
