# ==============================================================================
# LaTeX Resume Tailorer — Sandboxed PDF Compiler
# ==============================================================================
# This module compiles LaTeX source code into a PDF binary document using Tectonic.
# Tectonic is a modern self-contained LaTeX engine that automatically fetches
# missing packages from the internet on-the-fly, avoiding huge local texlive
# installations.
#
# To ensure system security, the compiler runs in a sandboxed Docker container,
# with a fallback to local execution if the user has Tectonic installed locally.
# ==============================================================================

import os
import tempfile
import subprocess
import logging
from backend.config import settings

# Configure logger to output status logs
logger = logging.getLogger("compiler")
logging.basicConfig(level=logging.INFO)

def compile_latex_to_pdf(latex_code: str) -> tuple:
    """
    Compiles raw LaTeX source code to a binary PDF stream.
    
    Returns:
        tuple: (success: bool, pdf_binary: bytes, compile_logs: str)
    """
    # 1. Create a safe, unique temporary folder in the OS workspace
    with tempfile.TemporaryDirectory() as temp_dir:
        # File paths inside the temp folder
        tex_file_name = "resume.tex"
        pdf_file_name = "resume.pdf"
        tex_path = os.path.join(temp_dir, tex_file_name)
        pdf_path = os.path.join(temp_dir, pdf_file_name)
        
        # 2. Write the input LaTeX source code into resume.tex
        with open(tex_path, "w", encoding="utf-8") as f:
            f.write(latex_code)
            
        # 3. Attempt local compilation first (fastest if Tectonic is installed)
        logger.info("Attempting local LaTeX compilation...")
        success, logs = compile_locally(temp_dir, tex_file_name)
        
        # 4. If local compilation fails or tectonic is not in PATH, fallback to Docker
        if not success:
            logger.info("Local compile unavailable or failed. Attempting Docker sandboxed compilation...")
            success, logs = compile_in_docker(temp_dir, tex_file_name)
            
        # 5. Read the generated PDF binary stream if compilation was successful
        if success and os.path.exists(pdf_path):
            logger.info("LaTeX compiled successfully!")
            with open(pdf_path, "rb") as f:
                pdf_bytes = f.read()
            return True, pdf_bytes, logs
        else:
            logger.error("Compilation failed. No PDF was generated.")
            return False, b"", logs

def compile_locally(temp_dir: str, file_name: str) -> tuple:
    """
    Runs Tectonic compilation locally via subprocess.
    """
    try:
        # Run tectonic locally. '--noninteractive' prevents it from hanging for user inputs.
        result = subprocess.run(
            ["tectonic", "--noninteractive", file_name],
            cwd=temp_dir,
            capture_output=True,
            text=True,
            timeout=30  # Timeout limit in seconds
        )
        if result.returncode == 0:
            return True, result.stdout + "\n" + result.stderr
        else:
            return False, f"Exit code {result.returncode}\nStdout: {result.stdout}\nStderr: {result.stderr}"
    except FileNotFoundError:
        # Raised if 'tectonic' executable is not found in system environment variables (PATH)
        return False, "Local Tectonic binary not found in PATH."
    except Exception as e:
        return False, f"Local compilation execution error: {str(e)}"

def compile_in_docker(temp_dir: str, file_name: str) -> tuple:
    """
    Runs Tectonic inside an isolated Docker container using volume mounts.
    """
    try:
        # Get absolute path to the temp directory
        abs_path = os.path.abspath(temp_dir)
        
        # Windows compatibility: Docker volumes require double backslashes or forward slashes
        if os.name == "nt":
            # Convert 'C:\\Users\\...' -> 'C:/Users/...'
            abs_path = abs_path.replace("\\", "/")
            
        # Assemble standard Docker CLI command:
        # docker run --rm -v "host_dir:/workspace" -w /workspace image command
        docker_cmd = [
            "docker", "run", "--rm",
            "-v", f"{abs_path}:/workspace",
            "-w", "/workspace",
            settings.DOCKER_TECTONIC_IMAGE,
            "tectonic", "--noninteractive", file_name
        ]
        
        logger.info(f"Executing: {' '.join(docker_cmd)}")
        
        result = subprocess.run(
            docker_cmd,
            capture_output=True,
            text=True,
            timeout=90  # 90 seconds (longer timeout to allow Docker to fetch Tectonic packages)
        )
        
        if result.returncode == 0:
            return True, result.stdout + "\n" + result.stderr
        else:
            return False, f"Docker exit code {result.returncode}\nStdout: {result.stdout}\nStderr: {result.stderr}"
    except FileNotFoundError:
        # Raised if 'docker' CLI is not installed or docker daemon is not active
        return False, "Docker CLI not found or Docker daemon is offline."
    except Exception as e:
        return False, f"Docker execution error: {str(e)}"
