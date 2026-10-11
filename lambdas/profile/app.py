import json
import logging
import os
import time
import traceback
import uuid

import boto3
import jwt
from jwt import PyJWKClient
from flask import Flask, request, Response

logging.basicConfig(level=logging.DEBUG)
logger = logging.getLogger(__name__)

app = Flask(__name__)

REGION = os.environ.get("AWS_REGION", "ap-southeast-1")
USERS_TABLE = os.environ.get("USERS_TABLE", "")
FEEDBACK_TABLE = os.environ.get("FEEDBACK_TABLE", "")
USER_POOL_ID = os.environ.get("USER_POOL_ID", "")
APP_CLIENT_ID = os.environ.get("APP_CLIENT_ID", "")

dynamodb = boto3.resource("dynamodb", region_name=REGION)
cognito = boto3.client("cognito-idp", region_name=REGION)

users_table = dynamodb.Table(USERS_TABLE) if USERS_TABLE else None
feedback_table = dynamodb.Table(FEEDBACK_TABLE) if FEEDBACK_TABLE else None

ISSUER = "https://cognito-idp.{}.amazonaws.com/{}".format(REGION, USER_POOL_ID)
JWKS_URL = ISSUER + "/.well-known/jwks.json"

# Cache the JWK client across invocations (warm starts).
_jwk_client = None


def jwk_client():
    global _jwk_client
    if _jwk_client is None:
        _jwk_client = PyJWKClient(JWKS_URL)
    return _jwk_client


class AuthError(Exception):
    pass


def verify_token(req):
    """Verify the Cognito ID token from the Authorization header.
    Returns the decoded claims dict, or raises AuthError."""
    header = req.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        raise AuthError("Missing bearer token")
    token = header[len("Bearer "):].strip()
    if not token:
        raise AuthError("Empty token")

    try:
        signing_key = jwk_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            audience=APP_CLIENT_ID,  # ID tokens carry client id in 'aud'
            issuer=ISSUER,
            options={"require": ["exp", "iss", "sub"]},
        )
    except Exception as e:
        logger.warning("Token verification failed: %s", str(e))
        raise AuthError("Invalid token")

    if claims.get("token_use") != "id":
        raise AuthError("Not an ID token")
    return claims


def json_response(payload, status=200):
    return Response(json.dumps(payload), status=status,
                    content_type="application/json; charset=utf-8")


def get_profile(claims):
    user_id = claims["sub"]
    item = {}
    if users_table:
        try:
            resp = users_table.get_item(Key={"userId": user_id})
            item = resp.get("Item", {}) or {}
        except Exception as e:
            logger.error("get_item error: %s", str(e))

    # Cognito claims are the source of truth for email; name may be overridden
    # by the stored profile.
    return {
        "userId": user_id,
        "email": claims.get("email", ""),
        "name": item.get("name") or claims.get("name", ""),
        "phone": item.get("phone", ""),
        "address": item.get("address", ""),
        "settings": item.get("settings", {}) or {},
    }


def update_profile(claims, body):
    user_id = claims["sub"]
    name = str(body.get("name", "")).strip()
    phone = str(body.get("phone", "")).strip()
    address = str(body.get("address", "")).strip()
    settings = body.get("settings", {})
    if not isinstance(settings, dict):
        settings = {}

    if users_table:
        users_table.update_item(
            Key={"userId": user_id},
            UpdateExpression="SET #n = :n, phone = :p, address = :a, settings = :s, updatedAt = :u",
            ExpressionAttributeNames={"#n": "name"},
            ExpressionAttributeValues={
                ":n": name,
                ":p": phone,
                ":a": address,
                ":s": settings,
                ":u": int(time.time()),
            },
        )

    # Mirror the display name into Cognito so tokens reflect it.
    if name and USER_POOL_ID:
        try:
            cognito.admin_update_user_attributes(
                UserPoolId=USER_POOL_ID,
                Username=user_id,
                UserAttributes=[{"Name": "name", "Value": name}],
            )
        except Exception as e:
            logger.warning("Cognito name update failed: %s", str(e))

    return get_profile(claims)


def submit_feedback(claims, body):
    rating = body.get("rating")
    try:
        rating = int(rating)
    except (TypeError, ValueError):
        rating = 0
    message = str(body.get("message", "")).strip()

    item = {
        "feedbackId": str(uuid.uuid4()),
        "userId": claims["sub"],
        "email": claims.get("email", ""),
        "rating": max(0, min(5, rating)),
        "message": message[:2000],
        "createdAt": int(time.time()),
    }
    if feedback_table:
        feedback_table.put_item(Item=item)
    return {"ok": True}


def delete_account(claims):
    user_id = claims["sub"]
    # Remove profile data first.
    if users_table:
        try:
            users_table.delete_item(Key={"userId": user_id})
        except Exception as e:
            logger.error("Profile delete error: %s", str(e))
    # Then delete the Cognito user (irreversible).
    if USER_POOL_ID:
        cognito.admin_delete_user(UserPoolId=USER_POOL_ID, Username=user_id)
    return {"ok": True}


@app.route("/", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"], defaults={"path": ""})
@app.route("/<path:path>", methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"])
def handler(path):
    if request.method == "OPTIONS":
        return Response("", status=200)

    try:
        claims = verify_token(request)
    except AuthError as e:
        return json_response({"error": str(e)}, status=401)

    try:
        route = "/" + path.strip("/")

        if request.method == "GET":
            return json_response(get_profile(claims))

        if request.method == "PUT":
            body = request.get_json(force=True, silent=True) or {}
            return json_response(update_profile(claims, body))

        if request.method == "POST" and route.endswith("feedback"):
            body = request.get_json(force=True, silent=True) or {}
            return json_response(submit_feedback(claims, body))

        if request.method == "DELETE":
            return json_response(delete_account(claims))

        return json_response({"error": "Unsupported route"}, status=400)

    except Exception as e:
        logger.error("Handler error: %s", traceback.format_exc())
        return json_response({"error": str(e)}, status=500)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=8080)
