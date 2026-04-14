#!/usr/bin/env python3
"""
向 Jarvis 发消息的小工具，解决 curl 中文乱码问题。
用法：
  python scripts/send.py "你好 Jarvis"
  python scripts/send.py "你好 Jarvis" --from ID:Claude
  python scripts/send.py --status
  python scripts/send.py --memories 10
"""
import sys
import json
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:3721'

def post_message(content, from_id='ID:000001', channel='API'):
    data = json.dumps({'from_id': from_id, 'content': content, 'channel': channel}).encode('utf-8')
    req = urllib.request.Request(f'{BASE}/message', data=data, headers={'Content-Type': 'application/json; charset=utf-8'}, method='POST')
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

def get_status():
    with urllib.request.urlopen(f'{BASE}/status') as resp:
        return json.loads(resp.read())

def get_memories(limit=10):
    with urllib.request.urlopen(f'{BASE}/memories?limit={limit}') as resp:
        return json.loads(resp.read())

if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        print('用法: python send.py "消息内容" [--from ID:xxx]')
        sys.exit(1)

    if '--status' in args:
        print(json.dumps(get_status(), ensure_ascii=False, indent=2))
        sys.exit(0)

    if '--memories' in args:
        idx = args.index('--memories')
        limit = int(args[idx + 1]) if idx + 1 < len(args) and args[idx + 1].isdigit() else 10
        mems = get_memories(limit)
        for m in mems:
            print(f"[{m['id']}] {m['timestamp'][:19]} {m['event_type']}")
            print(f"  {m['content']}")
        sys.exit(0)

    content = args[0]
    from_id = 'ID:000001'
    if '--from' in args:
        idx = args.index('--from')
        if idx + 1 < len(args):
            from_id = args[idx + 1]

    try:
        result = post_message(content, from_id)
        print(f'已发送: {result}')
    except urllib.error.URLError as e:
        print(f'发送失败（Jarvis 未运行？）: {e}')
        sys.exit(1)
