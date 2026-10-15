def test_health(client):
    assert client.get("/api/health").json()["status"] == "ok"


def test_issue_flow(client):
    created = client.post("/api/issues", json={"title": "Тестовое обращение", "category": "ЖКХ"})
    assert created.status_code == 201
    issue_id = created.json()["id"]

    assert any(i["id"] == issue_id for i in client.get("/api/issues").json())

    updated = client.patch(f"/api/issues/{issue_id}", json={"status": "done"})
    assert updated.json()["status"] == "done"

    ai = client.post(f"/api/issues/{issue_id}/ai")
    assert ai.json()["ai_comment"]

    assert client.delete(f"/api/issues/{issue_id}").status_code == 204
    assert all(i["id"] != issue_id for i in client.get("/api/issues").json())


def test_stats(client):
    stats = client.get("/api/stats").json()
    assert stats["total"] == sum(item["count"] for item in stats["by_category"])
