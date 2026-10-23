#!/usr/bin/env python3
"""Read-only performance evidence; outputs counts and timings, never message text."""
import argparse
import datetime
import json
import math
from pathlib import Path
import re
import sqlite3
import statistics
import time


def text_chars(value):
    # JS's string.length counts UTF-16 code units.
    return len(str(value or "").encode("utf-16-le")) // 2


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--traces", type=Path, required=True)
    parser.add_argument("--samples", type=int, default=101)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    samples = max(3, min(args.samples, 1001))
    result = {
        "measuredAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "method": "SQLite mode=ro + query_only; one read transaction; first query then warm repetitions",
        "limitations": [
            "Python SQLite query execution/fetch time is not application better-sqlite3 timing.",
            "Warm repetitions exclude network, embeddings, JS processing, write locks and model work.",
            "Historical turn duration begins inside callLLM and includes tool rounds; it is not TTFT or end-to-end latency.",
            "Initial character counts exclude tool schema and are not tokenizer-derived token counts.",
        ],
    }
    db = sqlite3.connect(args.db.expanduser().resolve().as_uri() + "?mode=ro", uri=True)
    db.execute("PRAGMA query_only=ON")
    db.execute("BEGIN")
    tables = {
        row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")
    }
    selected = [
        "memories", "conversations", "config", "information_events",
        "information_deliveries", "knowledge_chunks", "recall_audit", "threads",
    ]
    result["tableRows"] = {
        name: db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0]
        for name in selected if name in tables
    }
    result["embedding"] = dict(zip(
        ("rows", "bytes"),
        db.execute("SELECT COUNT(*), COALESCE(SUM(LENGTH(embedding)),0) FROM memories WHERE embedding IS NOT NULL").fetchone(),
    ))
    entity_row = db.execute("SELECT from_id FROM conversations WHERE role='user' ORDER BY timestamp DESC LIMIT 1").fetchone()
    entity = entity_row[0] if entity_row else ""
    root = db.execute("SELECT id,mem_id FROM memories WHERE event_type='person' ORDER BY id LIMIT 1").fetchone() or (-1, "")
    cutoff = (datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(days=1)).isoformat()
    queries = {
        "recent-conversation": (
            "SELECT * FROM conversations WHERE (from_id=? OR to_id=?) AND timestamp>=? ORDER BY timestamp DESC,id DESC LIMIT ?",
            [entity, entity, cutoff, 20],
        ),
        "person-memory": (
            "SELECT * FROM memories WHERE event_type IN ('person','object') AND entities LIKE ? AND parent_id IS NULL AND visibility=1 ORDER BY CASE WHEN mem_id=? THEN 0 ELSE 1 END,timestamp DESC LIMIT 1",
            ["%" + entity + "%", root[1]],
        ),
        "entity-memories": (
            "SELECT * FROM memories WHERE (entities LIKE ? OR parent_id=? OR links LIKE ?) AND id != ? AND visibility=1 ORDER BY COALESCE(salience,3) DESC,timestamp DESC LIMIT ?",
            ["%" + entity + "%", root[0], "%" + (root[1] or "") + "%", root[0], 10],
        ),
        "keyword-like": (
            "SELECT * FROM memories WHERE (title LIKE ? OR mem_id LIKE ? OR content LIKE ? OR detail LIKE ? OR entities LIKE ? OR concepts LIKE ? OR tags LIKE ?) AND visibility=1 ORDER BY COALESCE(salience,3) DESC,timestamp DESC LIMIT ?",
            ["%性能%"] * 7 + [3],
        ),
        "embedding-rows": (
            "SELECT * FROM memories WHERE embedding IS NOT NULL AND (embedding_dim=1024 OR embedding_dim IS NULL) AND visibility=1",
            [],
        ),
        "active-constraints": (
            "SELECT * FROM memories WHERE event_type='behavioral_constraint' AND visibility=1 ORDER BY timestamp DESC",
            [],
        ),
    }
    result["queryBenchmarks"] = []
    for name, (sql, parameters) in queries.items():
        durations = []
        rows = []
        for _ in range(samples):
            started = time.perf_counter()
            rows = db.execute(sql, parameters).fetchall()
            durations.append((time.perf_counter() - started) * 1000)
        warm = sorted(durations[1:])
        result["queryBenchmarks"].append({
            "name": name, "rows": len(rows), "samples": samples,
            "firstMs": round(durations[0], 4),
            "warmMedianMs": round(statistics.median(warm), 4),
            "warmP95Ms": round(warm[math.ceil(len(warm) * 0.95) - 1], 4),
            "maxMs": round(max(durations), 4),
            "queryPlan": [row[3] for row in db.execute("EXPLAIN QUERY PLAN " + sql, parameters)],
        })
    db.close()
    history = []
    malformed = 0
    with args.traces.expanduser().open() as trace_file:
        for line in trace_file:
            if not line.strip():
                continue
            try:
                trace = json.loads(line)
                start = datetime.datetime.fromisoformat(trace["startedAt"].replace("Z", "+00:00"))
                end = datetime.datetime.fromisoformat(trace["finishedAt"].replace("Z", "+00:00"))
            except (ValueError, KeyError, TypeError):
                malformed += 1
                continue
            rounds = trace.get("rounds", [])
            offset = rounds[0].get("inputOffset") if rounds else None
            messages = trace.get("messages", [])
            initial = messages[:offset] if isinstance(offset, int) else messages
            by_role = {}
            system_message_chars = []
            source_chars = {}
            for message in initial:
                role = message.get("role", "unknown")
                by_role[role] = by_role.get(role, 0) + text_chars(message.get("content", ""))
                if role == "system":
                    content = message.get("content", "")
                    system_message_chars.append(text_chars(content))
                    for match in re.finditer(
                        r'<information-item\b[^>]*\bsource="([a-z0-9:_-]+)"[^>]*>[\s\S]*?</information-item>',
                        content,
                    ):
                        source = match.group(1)
                        source_chars[source] = source_chars.get(source, 0) + text_chars(match.group(0))
            history.append({
                "startedAt": start.isoformat(),
                "startedAtShanghai": start.astimezone(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
                "channel": trace.get("meta", {}).get("channel"),
                "model": trace.get("meta", {}).get("model"),
                "durationMs": round((end - start).total_seconds() * 1000),
                "roundCount": len(rounds),
                "initialMessages": len(initial),
                "initialChars": sum(by_role.values()),
                "charsByRole": by_role,
                "systemMessageChars": system_message_chars,
                "informationCharsBySource": source_chars,
                "initialOffsetKnown": isinstance(offset, int),
                "toolCount": len(trace.get("meta", {}).get("tools", [])),
                "error": bool(trace.get("error")),
                "aborted": bool(trace.get("aborted")),
            })
    result["historicalTraceCount"] = len(history)
    result["malformedOrUnfinishedTraceCount"] = malformed
    result["foregroundTraces"] = [row for row in history if row["channel"]]
    result["channelSummaries"] = []
    for channel in sorted({row["channel"] for row in history}, key=str):
        completed = [row for row in history if row["channel"] == channel and not row["error"] and not row["aborted"]]
        if completed:
            result["channelSummaries"].append({
                "channel": channel, "count": len(completed),
                "medianTurnMs": statistics.median(row["durationMs"] for row in completed),
                "maxTurnMs": max(row["durationMs"] for row in completed),
                "medianInitialChars": statistics.median(row["initialChars"] for row in completed),
            })
    output = json.dumps(result, ensure_ascii=False, indent=2) + "\n"
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output)
    else:
        print(output, end="")


if __name__ == "__main__":
    main()
