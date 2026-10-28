"""Local demonstration store. Identities are labels, not authenticated principals."""
import json
import sqlite3
import uuid
from datetime import datetime, timezone


def now():
    return datetime.now(timezone.utc).isoformat()


class Store:
    def __init__(self, path):
        self.db = sqlite3.connect(path, timeout=10)
        self.db.row_factory = sqlite3.Row
        self.db.execute('PRAGMA foreign_keys=ON')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, title TEXT NOT NULL, material TEXT NOT NULL, quantity INTEGER NOT NULL, due TEXT NOT NULL, owner TEXT NOT NULL, state TEXT NOT NULL, result TEXT, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS subtasks(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent TEXT NOT NULL, state TEXT NOT NULL, result TEXT, UNIQUE(task_id,agent));
        CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), actor TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, time TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, response TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), content TEXT NOT NULL, conditions TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, reviewer TEXT, expires TEXT, created TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS knowledge_refs(task_id TEXT NOT NULL REFERENCES tasks(id), knowledge_id TEXT NOT NULL REFERENCES knowledge(id), version INTEGER NOT NULL, UNIQUE(task_id,knowledge_id,version));
        ''')

    def event(self, task_id, actor, kind, data):
        self.db.execute('INSERT INTO events(id,task_id,actor,kind,data,time) VALUES(?,?,?,?,?,?)', (str(uuid.uuid4()),task_id,actor,kind,json.dumps(data,ensure_ascii=False),now()))

    def operation(self, op_id, payload, fn):
        fingerprint = json.dumps(payload, sort_keys=True, ensure_ascii=False)
        with self.db:
            old = self.db.execute('SELECT * FROM operations WHERE id=?', (op_id,)).fetchone()
            if old:
                if old['fingerprint'] != fingerprint:
                    raise ValueError('operation ID reused with different input')
                return json.loads(old['response'])
            result = fn()
            self.db.execute('INSERT INTO operations VALUES(?,?,?)', (op_id,fingerprint,json.dumps(result,ensure_ascii=False)))
            return result

    def create(self, title, material, quantity, due, owner, op_id):
        if quantity <= 0 or not all([title, material, due, owner]):
            raise ValueError('title, material, due, owner and positive quantity required')
        def run():
            ident = str(uuid.uuid4())
            self.db.execute('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?)', (ident,title,material,quantity,due,owner,'pending',None,now()))
            self.event(ident,owner,'task_created',{'material':material,'quantity':quantity,'due':due})
            return {'task_id':ident}
        return self.operation(op_id,['create',title,material,quantity,due,owner],run)

    def assign(self, task_id, actor, op_id):
        def run():
            task = self.task(task_id)
            if task['state'] != 'pending': raise ValueError('task is not pending')
            for agent in ('inventory','supplier'):
                self.db.execute('INSERT INTO subtasks VALUES(?,?,?,?,?)',(str(uuid.uuid4()),task_id,agent,'invited',None))
                self.event(task_id,actor,'subtask_invited',{'agent':agent})
            self.db.execute("UPDATE tasks SET state='running' WHERE id=?",(task_id,))
            return {'state':'running'}
        return self.operation(op_id,['assign',task_id,actor],run)

    def submit(self, task_id, agent, result, op_id):
        def run():
            sub = self.db.execute('SELECT * FROM subtasks WHERE task_id=? AND agent=?',(task_id,agent)).fetchone()
            if not sub or sub['state'] not in ('invited','accepted','returned'): raise ValueError('subtask cannot submit')
            if not all(result.get(k) for k in ('source','observed_at')) or not isinstance(result.get('quantity'), int) or result['quantity'] < 0:
                raise ValueError('result requires nonnegative integer quantity, source and observed_at')
            if sub['state'] == 'invited':
                self.event(task_id,agent,'subtask_accepted',{})
            self.db.execute("UPDATE subtasks SET state='submitted',result=? WHERE id=?",(json.dumps(result,ensure_ascii=False),sub['id']))
            self.event(task_id,agent,'subtask_submitted',result)
            return {'state':'submitted'}
        return self.operation(op_id,['submit',task_id,agent,result],run)

    def summarize(self, task_id, actor, op_id):
        def run():
            task=self.task(task_id)
            if task['state'] != 'running': raise ValueError('task is not running')
            subs=self.db.execute('SELECT * FROM subtasks WHERE task_id=?',(task_id,)).fetchall()
            if len(subs)!=2 or any(s['state']!='submitted' for s in subs): raise ValueError('waiting for both results')
            data={s['agent']:json.loads(s['result']) for s in subs}
            shortage=max(0,task['quantity']-data['inventory']['quantity'])
            result={'shortage':shortage,'supplier_quantity':data['supplier']['quantity'],'inputs':data,'note':'建议仅供人工判断；未下订单。'}
            self.db.execute("UPDATE tasks SET state='review',result=? WHERE id=?",(json.dumps(result,ensure_ascii=False),task_id))
            self.event(task_id,actor,'summary_submitted',result)
            return result
        return self.operation(op_id,['summarize',task_id,actor],run)

    def review(self, task_id, actor, accept, note, op_id):
        def run():
            task=self.task(task_id)
            if actor != task['owner']: raise ValueError('only task owner can review in this demo')
            if task['state']!='review': raise ValueError('task is not awaiting review')
            state='completed' if accept else 'running'
            self.db.execute('UPDATE tasks SET state=? WHERE id=?',(state,task_id))
            self.event(task_id,actor,'task_accepted' if accept else 'task_returned',{'note':note})
            return {'state':state}
        return self.operation(op_id,['review',task_id,actor,accept,note],run)

    def candidate(self, task_id, content, conditions, actor, op_id):
        def run():
            if self.task(task_id)['state']!='completed': raise ValueError('task must be accepted first')
            ident=str(uuid.uuid4())
            self.db.execute('INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?,?)',(ident,task_id,content,conditions,'candidate',1,None,None,now()))
            self.event(task_id,actor,'knowledge_candidate',{'id':ident,'version':1})
            return {'knowledge_id':ident,'version':1}
        return self.operation(op_id,['candidate',task_id,content,conditions,actor],run)

    def publish(self, ident, reviewer, expires, op_id):
        def run():
            item=self.db.execute('SELECT * FROM knowledge WHERE id=?',(ident,)).fetchone()
            if not item or item['state']!='candidate': raise ValueError('candidate not found')
            if expires <= now(): raise ValueError('expiration must be a future ISO UTC timestamp')
            self.db.execute("UPDATE knowledge SET state='published',reviewer=?,expires=? WHERE id=?",(reviewer,expires,ident))
            self.event(item['task_id'],reviewer,'knowledge_published',{'id':ident,'version':1,'expires':expires})
            return {'state':'published'}
        return self.operation(op_id,['publish',ident,reviewer,expires],run)

    def revoke(self, ident, actor, op_id):
        def run():
            item=self.db.execute('SELECT * FROM knowledge WHERE id=?',(ident,)).fetchone()
            if not item or item['state']!='published': raise ValueError('published item not found')
            self.db.execute("UPDATE knowledge SET state='revoked' WHERE id=?",(ident,))
            self.event(item['task_id'],actor,'knowledge_revoked',{'id':ident,'version':item['version']})
            return {'state':'revoked'}
        return self.operation(op_id,['revoke',ident,actor],run)

    def knowledge(self):
        return [dict(r) for r in self.db.execute("SELECT * FROM knowledge WHERE state='published' AND expires > ?",(now(),))]

    def reference(self, task_id, ident, actor, op_id):
        def run():
            self.task(task_id)
            item=self.db.execute("SELECT * FROM knowledge WHERE id=? AND state='published' AND expires > ?",(ident,now())).fetchone()
            if not item: raise ValueError('knowledge unavailable')
            self.db.execute('INSERT INTO knowledge_refs VALUES(?,?,?)',(task_id,ident,item['version']))
            self.event(task_id,actor,'knowledge_referenced',{'id':ident,'version':item['version']})
            return {'knowledge_id':ident,'version':item['version']}
        return self.operation(op_id,['reference',task_id,ident,actor],run)

    def task(self, ident):
        row=self.db.execute('SELECT * FROM tasks WHERE id=?',(ident,)).fetchone()
        if not row: raise ValueError('task not found')
        return dict(row)

    def detail(self, ident):
        task=self.task(ident)
        task['subtasks']=[dict(r) for r in self.db.execute('SELECT * FROM subtasks WHERE task_id=?',(ident,))]
        task['events']=[dict(r) for r in self.db.execute('SELECT * FROM events WHERE task_id=? ORDER BY seq',(ident,))]
        task['knowledge_refs']=[dict(r) for r in self.db.execute('SELECT * FROM knowledge_refs WHERE task_id=?',(ident,))]
        return task
