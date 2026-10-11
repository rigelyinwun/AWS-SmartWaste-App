"""Shared test setup.

The Lambda modules create boto3 / flask / jwt objects at import time. For unit
testing the PURE logic we stub those heavy dependencies with lightweight fakes so
the modules import without AWS credentials or network. We only exercise functions
that don't actually hit AWS.
"""
import sys
import types


def _install_stubs():
    # --- boto3 stub ---
    if "boto3" not in sys.modules:
        boto3 = types.ModuleType("boto3")

        class _FakeClient:
            def __init__(self, *a, **k):
                pass
            def __getattr__(self, name):
                def _noop(*a, **k):
                    raise RuntimeError("AWS call not available in unit tests")
                return _noop

        class _FakeTable:
            def __init__(self, *a, **k):
                pass
            def __getattr__(self, name):
                def _noop(*a, **k):
                    raise RuntimeError("AWS call not available in unit tests")
                return _noop

        class _FakeResource:
            def __init__(self, *a, **k):
                pass
            def Table(self, *a, **k):
                return _FakeTable()

        boto3.client = lambda *a, **k: _FakeClient()
        boto3.resource = lambda *a, **k: _FakeResource()
        sys.modules["boto3"] = boto3

        # boto3.dynamodb.conditions.Key
        dynamodb_mod = types.ModuleType("boto3.dynamodb")
        conditions_mod = types.ModuleType("boto3.dynamodb.conditions")

        class _Key:
            def __init__(self, name):
                self.name = name
            def eq(self, v):
                return ("eq", self.name, v)

        conditions_mod.Key = _Key
        sys.modules["boto3.dynamodb"] = dynamodb_mod
        sys.modules["boto3.dynamodb.conditions"] = conditions_mod

    # --- flask stub (only the names the modules import at module load) ---
    if "flask" not in sys.modules:
        flask = types.ModuleType("flask")

        class _Flask:
            def __init__(self, *a, **k):
                pass
            def route(self, *a, **k):
                def deco(fn):
                    return fn
                return deco
            def run(self, *a, **k):
                pass

        class _Response:
            def __init__(self, body="", status=200, content_type=None, **k):
                self.body = body
                self.status = status
                self.content_type = content_type

        flask.Flask = _Flask
        flask.Response = _Response
        flask.request = types.SimpleNamespace(method="GET", headers={}, args={})
        sys.modules["flask"] = flask

    # --- jwt stub (collect/profile import jwt + PyJWKClient) ---
    if "jwt" not in sys.modules:
        jwt = types.ModuleType("jwt")
        jwt.decode = lambda *a, **k: {}

        class _PyJWKClient:
            def __init__(self, *a, **k):
                pass

        jwt.PyJWKClient = _PyJWKClient
        sys.modules["jwt"] = jwt


_install_stubs()
