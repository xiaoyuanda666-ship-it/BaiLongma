# Agent-Driven UI Design

> English summary of [Agent-驱动UI-设计方案.md](../Agent-驱动UI-设计方案.md)

## Core Concept

**`UI = f(scene)`** — The Agent holds a single scene as the source of truth; UI shells are pure projections.

## Key Design Principles

| Principle | Description |
|-----------|-------------|
| **One verb** | `ui.set(id, surface)` is idempotent upsert; `ui.set(id, null)` is delete. No show/update/hide commands. |
| **Intent as decoupling boundary** | Agent declares semantic importance (`ambient`/`inform`/`confront`), not pixel placement. The shell decides rendering. |
| **Compact manifest feedback** | Agent receives a terse summary of what's on screen (id + kind + summary + intent), never pixel/layout data. |
| **Free cinematic transitions** | Shell holds prev+next frames, enabling shared-element transitions and FLIP animations without Agent involvement. |

## Comparison with Legacy ACUI

| Aspect | Old ACUI | New Scene Protocol |
|--------|----------|-------------------|
| Control | Imperative commands | Declarative state |
| State storage | Dual (Agent + UI) | Single source of truth |
| Verbs | 4+ | 1 |
| Code injection | Yes | No |
| Multi-shell | No | Yes |
