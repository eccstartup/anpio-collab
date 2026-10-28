"""Run the local simulated workflow with independent worker processes."""
import json
import subprocess
import sys
import tempfile
from collab.core import Store

with tempfile.TemporaryDirectory() as d:
    path=d+'/collab.sqlite3'
    s=Store(path)
    task=s.create('缺料分析','M-100',100,'2027-01-01','owner','create-1')['task_id']
    s.assign(task,'coordinator','assign-1')
    for agent in ('inventory','supplier'):
        subprocess.run([sys.executable,'-m','agents.worker','--db',path,'--task',task,'--agent',agent,'--data','examples/'+agent+'.json'],check=True)
    result=s.summarize(task,'coordinator','summary-1')
    s.review(task,'owner',True,'人工验收示例','review-1')
    kid=s.candidate(task,'缺料时核查库存及供应商可供数量，并确认交期。','M-100','owner','candidate-1')['knowledge_id']
    s.publish(kid,'reviewer','9999-01-01T00:00:00+00:00','publish-1')
    second=s.create('第二次缺料分析','M-100',20,'2027-01-01','owner','create-2')['task_id']
    s.reference(second,kid,'coordinator','reference-1')
    print(json.dumps({'first_task':task,'result':result,'knowledge':s.knowledge(),'second_task':s.detail(second)},ensure_ascii=False,indent=2))
