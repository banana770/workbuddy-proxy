import json
cap = json.load(open('capture/400-1789372224887.json', encoding='utf-8'))
b = cap.get('body', cap)
ms = b['messages']
tot = 0
per = []
for i, m in enumerate(ms):
    c = m.get('content')
    if isinstance(c, str):
        n = len(c)
    elif isinstance(c, list):
        n = sum(len(p.get('text', '')) for p in c if isinstance(p, dict))
    else:
        n = 0
    n += len(m.get('reasoning_content') or '')
    tot += n
    per.append((i, m.get('role'), n))
print('消息数:', len(ms), '| 总字符:', tot, '| 估算 tokens(≈chars/2.2):', int(tot / 2.2))
print('最大的 5 条:')
for i, r, n in sorted(per, key=lambda x: -x[2])[:5]:
    print('  [%d] %s: %d 字符 (~%d tokens)' % (i, r, n, n // 2))
p30 = sum(n for i, r, n in per if i < 30)
print('前 30 条合计: %d 字符 (~%d tokens)' % (p30, p30 // 2))
