#!/usr/bin/env python3
"""
SkyGuard AI — Automated Hugging Face Spaces Deployment Script
Uploads the complete containerized application (FastAPI + ML Models + React UI + IMD Services)
to Hugging Face Spaces using the official huggingface_hub API.
"""

import os
import sys
import argparse
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="Deploy SkyGuard AI to Hugging Face Spaces")
    parser.add_argument("--repo-id", type=str, default=None, help="Hugging Face Space repo ID (e.g., 'username/skyguard-ai')")
    parser.add_argument("--space-name", type=str, default="skyguard-ai", help="Space name if repo-id not specified (default: skyguard-ai)")
    parser.add_argument("--token", type=str, default=None, help="Hugging Face User Access Token (with WRITE permission)")
    args = parser.parse_args()

    token = args.token or os.environ.get("HF_TOKEN") or os.environ.get("HUGGING_FACE_HUB_TOKEN")

    try:
        from huggingface_hub import HfApi, login
    except ImportError:
        print("[-] Error: 'huggingface_hub' is not installed.")
        print("    Install it via: pip install huggingface_hub")
        sys.exit(1)

    # If token not passed, prompt interactively
    if not token:
        print("\n=======================================================")
        print("       SkyGuard AI — Hugging Face Deployment           ")
        print("=======================================================")
        print("To deploy to Hugging Face Spaces, a Hugging Face Write Token is required.")
        print("Get your token at: https://huggingface.co/settings/tokens (Role: Write)\n")
        try:
            token = input("Enter your Hugging Face Token (starts with 'hf_...'): ").strip()
        except EOFError:
            pass

    if not token:
        print("[-] Deployment aborted: No Hugging Face token provided.")
        print("    You can run: python deploy_to_hf.py --token <YOUR_HF_WRITE_TOKEN>")
        sys.exit(1)

    api = HfApi(token=token)

    # Verify identity
    try:
        user_info = api.whoami()
        username = user_info.get("name") or user_info.get("user")
        print(f"[+] Successfully authenticated as Hugging Face user: {username}")
    except Exception as e:
        print(f"[-] Authentication failed: {e}")
        print("    Please check that your token is valid and has Write permissions.")
        sys.exit(1)

    repo_id = args.repo_id or f"{username}/{args.space_name}"
    print(f"[+] Target Space: https://huggingface.co/spaces/{repo_id}")

    # Create Space repo if not existing
    print(f"[*] Ensuring Space repository exists with Docker SDK...")
    try:
        api.create_repo(
            repo_id=repo_id,
            repo_type="space",
            space_sdk="docker",
            exist_ok=True,
            private=False
        )
        print(f"[+] Space repository verified/created: {repo_id}")
    except Exception as e:
        print(f"[!] Note on repo creation: {e}")

    current_dir = Path(__file__).resolve().parent
    print(f"[*] Uploading deployment package from: {current_dir}")

    # Files and patterns to ignore during upload
    ignore_patterns = [
        "__pycache__",
        "*.pyc",
        ".git",
        ".git/*",
        ".gitignore",
        "deploy_to_hf.*",
        "*.log",
        ".pytest_cache",
        "backend",
        "frontend",
    ]

    try:
        print("[*] Uploading files (FastAPI backend, 16-feature ML models, TreeSHAP explainer, React 19 UI)...")
        api.upload_folder(
            folder_path=str(current_dir),
            repo_id=repo_id,
            repo_type="space",
            ignore_patterns=ignore_patterns,
            commit_message="Deploy SkyGuard AI Production Stack (FastAPI + TreeSHAP + React 19)"
        )
        print("\n=======================================================")
        print("   SUCCESS! SkyGuard AI has been deployed to Hugging Face! ")
        print("=======================================================")
        print(f"Space URL:    https://huggingface.co/spaces/{repo_id}")
        print(f"Direct App:   https://{repo_id.replace('/', '-')}.hf.space")
        print("=======================================================\n")
        print("Hugging Face will now build the Docker container automatically.")
        print("Check the build logs in your browser at the Space URL.")

    except Exception as e:
        print(f"[-] Upload failed: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
