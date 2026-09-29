#!/usr/bin/env python3
"""
SkyGuard AI — Automated Render Web Service Deployment Script
Uses Render's REST API (https://api.render.com/v1) to programmatically
create and launch the SkyGuard backend web service.
"""

import os
import sys
import argparse
import httpx

RENDER_API_BASE = "https://api.render.com/v1"

def main():
    parser = argparse.ArgumentParser(description="Deploy SkyGuard Backend to Render via API")
    parser.add_argument("--api-key", type=str, default=None, help="Render API Key (starts with 'rnd_...')")
    parser.add_argument("--repo-url", type=str, default=None, help="GitHub repository URL (e.g. 'https://github.com/username/SkyGuard')")
    parser.add_argument("--service-name", type=str, default="skyguard-backend", help="Service name on Render")
    parser.add_argument("--region", type=str, default="oregon", choices=["oregon", "frankfurt", "singapore", "ohio"])
    args = parser.parse_args()

    api_key = args.api_key or os.environ.get("RENDER_API_KEY")
    if not api_key:
        print("\n=======================================================")
        print("          SkyGuard AI — Render API Deployment          ")
        print("=======================================================")
        print("A Render API Key is required to create the service.")
        print("Generate one at: https://dashboard.render.com/u/settings#api-keys\n")
        try:
            api_key = input("Enter your Render API Key (starts with 'rnd_...'): ").strip()
        except EOFError:
            pass

    if not api_key:
        print("[-] Deployment aborted: No Render API Key provided.")
        sys.exit(1)

    repo_url = args.repo_url or os.environ.get("GITHUB_REPO_URL")
    if not repo_url:
        print("\nRender requires a Git repository URL (e.g., GitHub or GitLab) to build from.")
        try:
            repo_url = input("Enter your GitHub repository URL: ").strip()
        except EOFError:
            pass

    if not repo_url:
        print("[-] Deployment aborted: No repository URL provided.")
        sys.exit(1)

    headers = {
        "Authorization": f"Bearer {api_key}",
        "Accept": "application/json",
        "Content-Type": "application/json"
    }

    # Step 1: Retrieve Owner Workspace ID
    print("[*] Fetching Render workspace owner ID...")
    try:
        r_owners = httpx.get(f"{RENDER_API_BASE}/owners?limit=20", headers=headers, timeout=15.0)
        r_owners.raise_for_status()
        owners_data = r_owners.json()
        if not owners_data:
            print("[-] No workspace found for this Render API key.")
            sys.exit(1)
        owner_id = owners_data[0]["owner"]["id"]
        owner_name = owners_data[0]["owner"].get("name", "User")
        print(f"[+] Found Workspace: {owner_name} (ID: {owner_id})")
    except Exception as e:
        print(f"[-] Failed to fetch Render workspace: {e}")
        sys.exit(1)

    # Step 2: Create Web Service via POST /v1/services
    print(f"[*] Creating Web Service '{args.service_name}' on Render...")
    payload = {
        "type": "web_service",
        "name": args.service_name,
        "ownerId": owner_id,
        "repo": repo_url,
        "autoDeploy": "yes",
        "branch": "main",
        "serviceDetails": {
            "env": "python",
            "plan": "free",
            "region": args.region,
            "rootDir": "huggingface",
            "buildCommand": "pip install -r requirements.txt",
            "startCommand": "uvicorn app:app --host 0.0.0.0 --port $PORT",
            "healthCheckPath": "/api/model/info",
            "envVars": [
                { "key": "PYTHON_VERSION", "value": "3.11.9" }
            ]
        }
    }

    try:
        r_create = httpx.post(f"{RENDER_API_BASE}/services", json=payload, headers=headers, timeout=30.0)
        if r_create.status_code in (200, 201):
            service = r_create.json()
            service_id = service.get("id")
            service_url = service.get("serviceDetails", {}).get("url") or f"https://{args.service_name}.onrender.com"
            print("\n=======================================================")
            print("  SUCCESS! SkyGuard backend created on Render!         ")
            print("=======================================================")
            print(f"Service ID:   {service_id}")
            print(f"Backend URL:  {service_url}")
            print(f"Health Check: {service_url}/api/model/info")
            print("=======================================================\n")
            print("Render is now building your container from your repository.")
            print(f"Track live build logs at: https://dashboard.render.com/web/{service_id}")
        else:
            print(f"[-] Render API returned status {r_create.status_code}: {r_create.text}")
    except Exception as e:
        print(f"[-] Failed to create service on Render: {e}")

if __name__ == "__main__":
    main()
