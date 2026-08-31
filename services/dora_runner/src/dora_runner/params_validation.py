# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 Sadasue Yuki
"""JSON Schema validation for pipeline parameters.

Schemas are meta-validated when a pipeline is registered.  Requests are copied,
schema defaults are materialized, and the result is validated without any type
coercion before a job row or worker task exists.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from jsonschema import Draft202012Validator, ValidationError, validators
from jsonschema.exceptions import SchemaError
from kairos_common import ApiError


def _properties_with_defaults(
    validator: Draft202012Validator,
    properties: dict[str, Any],
    instance: object,
    schema: dict[str, Any],
):
    """Materialize property defaults before applying normal validation."""
    if isinstance(instance, dict):
        for name, subschema in properties.items():
            if name not in instance and "default" in subschema:
                instance[name] = deepcopy(subschema["default"])
    yield from Draft202012Validator.VALIDATORS["properties"](
        validator, properties, instance, schema
    )


def _is_strict_integer(_checker: object, instance: object) -> bool:
    return isinstance(instance, int) and not isinstance(instance, bool)


_strict_type_checker = Draft202012Validator.TYPE_CHECKER.redefine(
    "integer", _is_strict_integer
)
_StrictDraft202012Validator = validators.extend(
    Draft202012Validator, type_checker=_strict_type_checker
)
_DefaultingValidator = validators.extend(
    _StrictDraft202012Validator, {"properties": _properties_with_defaults}
)


def validate_params_schema(schema: dict[str, Any]) -> None:
    """Raise ``ValueError`` when *schema* is not a valid Draft 2020-12 schema."""
    try:
        Draft202012Validator.check_schema(schema)
    except SchemaError as exc:
        raise ValueError(f"invalid params_schema: {exc.message}") from exc


def _first_error(errors: list[ValidationError]) -> ValidationError:
    return sorted(
        errors,
        key=lambda error: (
            tuple(repr(part) for part in error.absolute_path),
            tuple(repr(part) for part in error.absolute_schema_path),
        ),
    )[0]


def validate_pipeline_params(
    pipeline_id: str, schema: dict[str, Any], params: dict[str, Any]
) -> dict[str, Any]:
    """Return a validated copy with defaults, or raise a structured 400."""
    validated = deepcopy(params)
    errors = list(_DefaultingValidator(schema).iter_errors(validated))
    if errors:
        error = _first_error(errors)
        raise ApiError(
            status_code=400,
            code="invalid_pipeline_params",
            message="Pipeline parameters do not match params_schema.",
            details={
                "pipeline": pipeline_id,
                "path": list(error.absolute_path),
                "schema_path": list(error.absolute_schema_path),
                "reason": error.message,
            },
        )
    return validated
