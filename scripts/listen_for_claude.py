#!/usr/bin/env python3
"""
订阅 Jarvis 的 SSE /events，过滤出发给 Claude 的消息，每条一行打印到 stdout。
配合 Claude Code 的 Monitor 工具使用，每行变成一条通知。
"""
import sys
import io
import json
import urllib.request

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', line_buffering=True)

URL = 'http://127.0.0.1:3721/events'
TARGET = 'claude'  # 大小写不敏感比较

def normalize(s):
    return str(s or '').strip().lower()

def main():
    req = urllib.request.Request(URL, headers={'Accept': 'text/event-stream'})
    with urllib.request.urlopen(req, timeout=None) as resp:
        for raw in resp:
            line = raw.decode('utf-8', errors='replace').rstrip('\n')
            if not line.startswith('data:'):
                continue
            payload = line[5:].strip()
            try:
                evt = json.loads(payload)
            except Exception:
                continue
            if evt.get('type') != 'message':
                continue
            data = evt.get('data') or {}
            to = normalize(data.get('to'))
            # Jarvis 用 alias 也可能是 ID:Claude
            if TARGET not in to:
                continue
            ts = data.get('timestamp') or evt.get('ts') or ''
            content = (data.get('content') or '').replace('\n', ' / ')
            print(f"JARVIS→Claude {ts}: {content}", flush=True)

if __name__ == '__main__':
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)
