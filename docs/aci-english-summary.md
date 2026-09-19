# ACI — Anticipatory Context Injection

> English summary of [ACI-理念文档.md](../ACI-理念文档.md)

## Core Thesis

**Before the model opens its eyes, the system proactively prepares what it will need.**

ACI (Anticipatory Context Injection) reduces latency from serial tool calls to parallel prefetch by preparing memory, tools, and cached data BEFORE the model requests them.

## Three Prefetch Scenarios

| Scenario | Trigger | What It Does |
|----------|---------|--------------|
| **A: Semantic Memory Prefetch** | User message arrives | Vector search injects relevant memories before the model asks |
| **B: Pattern-Based Tool Prefetch** | Recurring task detected | Learns tool-call sequences (e.g., "morning briefing" = weather + news + calendar) and pre-executes them in parallel |
| **C: Scheduled Warm Cache** | Cron-based | Periodic prefetch of weather, news, calendar with TTL-based cache |

## Constraints

- Only read-only, idempotent, low-side-effect tools
- Confidence scoring controls injection depth:
  - Above 0.85 → inject directly
  - 0.5–0.85 → hint only
  - Below 0.5 → skip
- Injector timeout capped at 1.5s

## Academic Context

Benchmarks against PASTE, B-PASTE, ContextAgent, and Speculative Actions. ACI differentiates as application-layer, memory-integrated, and requiring no extra model training.
