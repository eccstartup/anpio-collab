import argparse
import json
import sys
import uuid
from .core import Store


def main():
    p=argparse.ArgumentParser(description='Anpio Collab local demonstration')
    p.add_argument('--db',default='collab.sqlite3')
    sub=p.add_subparsers(dest='command',required=True)
    def cmd(name, args):
        q=sub.add_parser(name)
        for arg in args: q.add_argument(arg)
        q.add_argument('--op',default=None,help='stable operation ID for retry')
    cmd('create',['title','material','quantity','due','owner'])
    cmd('assign',['task','actor'])
    cmd('submit',['task','agent','result_json'])
    cmd('summarize',['task','actor'])
    cmd('review',['task','actor','decision','note'])
    cmd('candidate',['task','content','conditions','actor'])
    cmd('publish',['knowledge_id','reviewer','expires'])
    cmd('revoke',['knowledge_id','actor'])
    cmd('reference',['task','knowledge_id','actor'])
    cmd('show',['task'])
    cmd('knowledge',[])
    a=p.parse_args(); s=Store(a.db); op=a.op or str(uuid.uuid4())
    try:
        if a.command=='create': out=s.create(a.title,a.material,int(a.quantity),a.due,a.owner,op)
        elif a.command=='assign': out=s.assign(a.task,a.actor,op)
        elif a.command=='submit': out=s.submit(a.task,a.agent,json.loads(a.result_json),op)
        elif a.command=='summarize': out=s.summarize(a.task,a.actor,op)
        elif a.command=='review':
            if a.decision not in ('accept','return'): raise ValueError('decision must be accept or return')
            out=s.review(a.task,a.actor,a.decision=='accept',a.note,op)
        elif a.command=='candidate': out=s.candidate(a.task,a.content,a.conditions,a.actor,op)
        elif a.command=='publish': out=s.publish(a.knowledge_id,a.reviewer,a.expires,op)
        elif a.command=='revoke': out=s.revoke(a.knowledge_id,a.actor,op)
        elif a.command=='reference': out=s.reference(a.task,a.knowledge_id,a.actor,op)
        elif a.command=='show': out=s.detail(a.task)
        else: out=s.knowledge()
        print(json.dumps(out,ensure_ascii=False,indent=2))
    except (ValueError, KeyError) as e:
        print(str(e),file=sys.stderr); return 1
    return 0

if __name__=='__main__': sys.exit(main())
