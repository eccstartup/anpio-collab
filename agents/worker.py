"""Run a simulated read-only business agent as a separate process."""
import argparse
import json
from datetime import datetime, timezone
from collab.core import Store

p=argparse.ArgumentParser()
p.add_argument('--db',required=True)
p.add_argument('--task',required=True)
p.add_argument('--agent',required=True,choices=['inventory','supplier'])
p.add_argument('--data',required=True,help='JSON mapping material IDs to quantities')
a=p.parse_args()
s=Store(a.db)
t=s.task(a.task)
with open(a.data,encoding='utf-8') as f: data=json.load(f)
if t['material'] not in data: raise SystemExit('material missing from data source')
result={'quantity':data[t['material']], 'source':a.data, 'observed_at':datetime.now(timezone.utc).isoformat()}
print(json.dumps(s.submit(a.task,a.agent,result,'worker:'+a.task+':'+a.agent),ensure_ascii=False))
