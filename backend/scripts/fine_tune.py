import json
import os
import argparse
from datasets import Dataset
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, TrainingArguments
from peft import LoraConfig, get_peft_model, prepare_model_for_kbit_training
from trl import SFTTrainer

def parse_args():
    parser = argparse.ArgumentParser(description="Fine-tune a local LLM for Resume Tailoring (Phase 5/6)")
    parser.add_argument("--data_path", type=str, default="resume_training_dataset.jsonl", help="Path to the JSONL dataset exported from the backend")
    parser.add_argument("--model_name", type=str, default="unsloth/llama-3-8b-bnb-4bit", help="Base model from HuggingFace")
    parser.add_argument("--output_dir", type=str, default="./models/resume-tailorer-lora", help="Directory to save the fine-tuned adapter")
    parser.add_argument("--num_epochs", type=int, default=3, help="Number of training epochs")
    return parser.parse_args()

def load_and_format_dataset(data_path: str):
    """
    Loads JSONL dataset and formats it for instruction tuning using a standard ChatML-style template.
    Filters for high-quality examples (rating_stars >= 4).
    """
    if not os.path.exists(data_path):
        raise FileNotFoundError(f"Dataset not found at {data_path}. Please export it via the UI first.")

    formatted_data = {"text": []}
    
    with open(data_path, "r", encoding="utf-8") as f:
        for line in f:
            if not line.strip():
                continue
            
            record = json.loads(line)
            
            # Filter low quality examples
            if record.get("rating_stars", 0) < 4:
                continue
            
            # Format instruction
            system_msg = "You are an expert LaTeX Resume Tailorer. You rewrite resumes to match a given job title while maintaining perfect LaTeX syntax."
            
            user_msg = (
                f"Job Title: {record.get('prompt_job_title', 'Software Engineer')}\n"
                f"Mode: {record.get('mode', 'moderate')}\n\n"
                f"Original Resume LaTeX:\n```latex\n{record.get('original_latex', '')}\n```\n\n"
                "Please tailor the above resume for the job title. Return ONLY the new LaTeX source code inside a json block under a 'tailored_latex' key, following the standard format."
            )
            
            # The assistant response should be the tailored latex wrapped in standard json format that the parser expects
            assistant_response = json.dumps({"tailored_latex": record.get('tailored_latex', '')}, indent=2)
            
            # Llama-3 / ChatML generic format
            prompt = (
                f"<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n{system_msg}<|eot_id|>"
                f"<|start_header_id|>user<|end_header_id|>\n\n{user_msg}<|eot_id|>"
                f"<|start_header_id|>assistant<|end_header_id|>\n\n{assistant_response}<|eot_id|>"
            )
            
            formatted_data["text"].append(prompt)
            
    print(f"Loaded {len(formatted_data['text'])} high-quality training examples.")
    return Dataset.from_dict(formatted_data)

def main():
    args = parse_args()
    
    print(f"Loading dataset from {args.data_path}...")
    dataset = load_and_format_dataset(args.data_path)
    
    if len(dataset) == 0:
        print("Dataset is empty. Exiting.")
        return

    print(f"Loading tokenizer and model {args.model_name}...")
    tokenizer = AutoTokenizer.from_pretrained(args.model_name, use_fast=True)
    tokenizer.pad_token = tokenizer.eos_token
    
    # Load model with 4-bit quantization config (requires bitsandbytes)
    model = AutoModelForCausalLM.from_pretrained(
        args.model_name,
        device_map="auto",
        load_in_4bit=True
    )
    
    # Prepare model for PEFT
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
    model.print_trainable_parameters()

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
    
    print(f"Saving fine-tuned adapter to {args.output_dir}...")
    trainer.model.save_pretrained(args.output_dir)
    tokenizer.save_pretrained(args.output_dir)
    print("Fine-tuning complete! You can now serve this model using vLLM or Ollama.")

if __name__ == "__main__":
    main()
