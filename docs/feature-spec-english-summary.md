# Bailongma Feature Specification

> English summary of [BaiLongma项目功能说明.md](../BaiLongma项目功能说明.md)

## Project Positioning

Bailongma is a **continuously-running desktop AI Agent** — not a one-shot chatbot. It is driven by a main loop: processes user messages when present, and during idle time, organizes memory, checks tasks, refreshes context, and pushes status to Brain UI in real time.

## Three-Layer Capability Model

### 1. Can Communicate
- Chat, voice, external social channels (Discord, WeChat, Feishu)
- Multimedia generation (image, video, music)
- Real-time thought stream

### 2. Can Remember
- SQLite-backed long-term memory with FTS5 full-text search
- Semantic recall, user profiles, thread models
- Memory auditing, deduplication, and consolidation

### 3. Can Act
- File system operations (read, write, delete, list)
- Shell commands and long-running process management
- Web search, scraping, browser automation
- Reminders, tasks, and scheduled operations
- Media generation (image, video, audio)
- Local Agent delegation
- Dynamic tool marketplace

## Architecture (7-Step Main Loop)

1. Receive message (user / background / tick / reminder)
2. Gather context (memory, rules, tools, UI signals)
3. Build prompt with dynamic injection
4. Call LLM with streaming
5. Execute tool calls
6. Update memory and state
7. Push updates to UI

## Target Users

- Developers wanting a local AI assistant that persists context
- Power users needing automation beyond chat
- Teams wanting a self-hosted, privacy-respecting AI agent
