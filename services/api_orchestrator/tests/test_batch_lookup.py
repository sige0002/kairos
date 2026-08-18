# SPDX-License-Identifier: Apache-2.0
"""Contract tests for page-scoped Batch metadata lookup."""

from __future__ import annotations

from api_orchestrator.models import Batch
from fastapi.testclient import TestClient


def test_lookup_dedupes_and_preserves_request_order(client: TestClient) -> None:
    store = client.app.state.capture_store
    store.create_batch(Batch(batch_id="first", task="one"))
    store.create_batch(Batch(batch_id="second", task="two"))

    response = client.post(
        "/api/v1/batches/lookup",
        json={"batch_ids": ["second", "missing", "first", "second"]},
    )

    assert response.status_code == 200
    assert [item["batch_id"] for item in response.json()["items"]] == [
        "second",
        "first",
    ]


def test_lookup_rejects_more_than_1000_distinct_ids(client: TestClient) -> None:
    response = client.post(
        "/api/v1/batches/lookup",
        json={"batch_ids": [f"batch-{index}" for index in range(1001)]},
    )

    assert response.status_code == 422
