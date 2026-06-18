# ==============================================================================
# LaTeX Resume Tailorer — Secure Authentication Service
# ==============================================================================
# This module implements JWT (JSON Web Token) authentication and password
# encryption. Passwords are encrypted using the 'bcrypt' algorithm.
# ==============================================================================

from datetime import datetime, timedelta
from typing import Optional
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import JWTError, jwt
from passlib.context import CryptContext
from sqlalchemy.orm import Session

from backend.config import settings
from backend.database import get_db
from backend.models import User

# --------------------------------------------------------------------------
# Cryptography Settings
# --------------------------------------------------------------------------
# Configure passlib to use the 'bcrypt' hashing engine. Bcrypt is designed to
# be slow, protecting user accounts from hardware-accelerated offline brute
# force attacks.
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")

# Configures OAuth2 authentication flow. Expects a bearer token in the
# 'Authorization' header of HTTP requests. The 'tokenUrl' points to our login
# endpoint.
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="api/auth/login")

# --------------------------------------------------------------------------
# Password Hash Helpers
# --------------------------------------------------------------------------

def verify_password(plain_password: str, hashed_password: str) -> bool:
    """
    Compares a plaintext password against a stored hash to confirm identity.
    Returns True if password is valid, False otherwise.
    """
    return pwd_context.verify(plain_password, hashed_password)

def get_password_hash(password: str) -> str:
    """
    Encrypts a plaintext password string using bcrypt.
    """
    return pwd_context.hash(password)

# --------------------------------------------------------------------------
# JWT Creation & Verification Helpers
# --------------------------------------------------------------------------

def create_access_token(data: dict, expires_delta: Optional[timedelta] = None) -> str:
    """
    Generates a cryptographically signed JSON Web Token (JWT).
    
    Parameters:
        data: Dictionary containing key-value claims (e.g. {"sub": "user@email.com"})
        expires_delta: Optional override for token expiration duration
    """
    to_encode = data.copy()
    
    # Define token expiration time
    if expires_delta:
        expire = datetime.utcnow() + expires_delta
    else:
        expire = datetime.utcnow() + timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    
    # Add 'exp' expiration claim to token payload
    to_encode.update({"exp": expire})
    
    # Sign token using secret key and encryption algorithm
    encoded_jwt = jwt.encode(to_encode, settings.JWT_SECRET_KEY, algorithm=settings.JWT_ALGORITHM)
    return encoded_jwt

def get_current_user(token: str = Depends(oauth2_scheme), db: Session = Depends(get_db)) -> User:
    """
    FastAPI dependency injection that validates the caller's JWT token.
    If valid, returns the User object from PostgreSQL.
    If invalid or expired, throws an HTTP 401 Unauthorized exception.
    
    Usage:
        @router.get("/profile")
        def profile(current_user: User = Depends(get_current_user)):
            return current_user
    """
    # Standard unauthorized exception definition
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    
    try:
        # Decrypt token contents and check signature integrity
        payload = jwt.decode(token, settings.JWT_SECRET_KEY, algorithms=[settings.JWT_ALGORITHM])
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
    except JWTError:
        # Thrown if signature is altered or token is expired
        raise credentials_exception

    # Query user account associated with the token sub claim
    user = db.query(User).filter(User.email == email).first()
    if user is None:
        raise credentials_exception
        
    return user
