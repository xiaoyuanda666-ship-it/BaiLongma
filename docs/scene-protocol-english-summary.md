# Scene Protocol Specification

> English summary of [SCENE-PROTOCOL.md](../SCENE-PROTOCOL.md)

## Overview

A formal protocol specification (RFC 2119 style) for declarative UI driven by the Agent Core.

## Transport

- **WebSocket** with JSON text frames
- Two directions: state downstream (snapshots/patches) and intent upstream
- Monotonically increasing `rev` for versioning
- Gap detection triggers automatic `resync`

## Surface Structure

```
{
  id: string,        // unique identifier
  kind: string,      // surface type
  data: object,      // type-specific payload
  intent: "ambient" | "inform" | "confront",
  focus: boolean,    // whether to steal focus
  order: number      // display order
}
```

## Standard Kinds (v1)

| Kind | Purpose |
|------|---------|
| `text` | Rich text with title, body, footnote |
| `metric` | Numeric value with label, unit, trend |
| `image` | Image with caption |
| `media` | Audio/video player |
| `choice` | Multiple choice selection |
| `form` | Input form |
| `weather` | Weather display |
| `progress` | Progress bar with status |
| `selfcheck` | System self-check results |
| `awakening` | Agent awakening phases |
| `stack`/`row`/`col` | Layout primitives |

## Security

- **No HTML/JS/CSS injection** — long-tail content expressed via composition of primitives
- Shell contract: diff-based enter/exit/morph animation between frames
- Business logic stays in core; shell is a pure renderer
