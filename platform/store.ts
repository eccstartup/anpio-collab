import { SQLiteDatabase, PostgresDatabase } from './database.ts';
import type { Database } from './database.ts';
import {rankKnowledge} from './search.ts';
import { createHash, randomUUID } from 'node:crypto';
import type { Principal } from '../protocol/types.ts';
export class AppError extends Error {
    status: number;
    constructor(status: number, message: string) { super(message); this.status = status; }
}
const fail = (status: number, message: string) => { throw new AppError(status, message); };
const id = () => randomUUID();
const now = () => new Date().toISOString();
const encode = (v: unknown) => JSON.stringify(v);
const parse = (v: unknown) => v == null ? null : JSON.parse(String(v));
const obj = (v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v))
        fail(400, 'Expected a JSON object');
    return v as Record<string, unknown>;
};
const str = (v: unknown, name: string, limit = 4000) => {
    if (typeof v !== 'string' || !v.trim() || v.length > limit)
        return fail(400, `Invalid ${name}`);
    return v;
};
const num = (v: unknown, name: string, min = 0) => {
    if (!Number.isSafeInteger(v) || (v as number) < min)
        return fail(400, `Invalid ${name}`);
    return v as number;
};
const timestamp = (v: unknown, name: string) => {
    const s = str(v, name, 64);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(s) || !Number.isFinite(Date.parse(s)))
        return fail(400, `Invalid ${name}; expected UTC timestamp`);
    const normalized=new Date(s).toISOString();
    if(normalized.slice(0,19)!==s.slice(0,19)) return fail(400,`Invalid ${name}; nonexistent UTC date`);
    return normalized;
};
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
type Row = Record<string, any>;
export class Store {
    db: Database;
    private requestTail: Promise<void> = Promise.resolve();
    private constructor(db: Database) { this.db = db; }
    static async open(path: string) {
        const db = /^postgres(?:ql)?:/.test(path) ? new PostgresDatabase(path) : new SQLiteDatabase(path);
        if (db instanceof PostgresDatabase)
            await db.connect();
        const store = new Store(db);
        try {
            await store.initialize();
            return store;
        }
        catch (e) {
            await db.close();
            throw e;
        }
    }
    async exclusive<T>(fn: () => Promise<T>) {
        const previous = this.requestTail;
        let release!: () => void;
        this.requestTail = new Promise<void>(resolve => { release = resolve; });
        await previous;
        try {
            return await fn();
        }
        finally {
            release();
        }
    }
    async initialize() {
        if(this.db.dialect==='postgres') { await this.db.exec('BEGIN'); await this.db.one('SELECT pg_advisory_xact_lock(190106,1)',[]); }
        try {
        await this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS principals(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, roles TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, active INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE IF NOT EXISTS principal_profiles(principal TEXT PRIMARY KEY REFERENCES principals(id),profile TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, title TEXT NOT NULL, material TEXT NOT NULL, quantity INTEGER NOT NULL, due TEXT NOT NULL, acceptance TEXT NOT NULL, owner TEXT NOT NULL, status TEXT NOT NULL, result TEXT, version INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS subtasks(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id), agent TEXT NOT NULL REFERENCES principals(id), kind TEXT NOT NULL, status TEXT NOT NULL, result TEXT, version INTEGER NOT NULL, UNIQUE(task_id,agent,kind));
      CREATE TABLE IF NOT EXISTS subtask_dependencies(subtask_id TEXT NOT NULL REFERENCES subtasks(id),depends_on TEXT NOT NULL REFERENCES subtasks(id),PRIMARY KEY(subtask_id,depends_on),CHECK(subtask_id<>depends_on));
      CREATE TABLE IF NOT EXISTS subtask_deadlines(subtask_id TEXT PRIMARY KEY REFERENCES subtasks(id),due TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), actor TEXT NOT NULL, type TEXT NOT NULL, data TEXT NOT NULL, recorded_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS operations(principal TEXT NOT NULL, op TEXT NOT NULL, request_hash TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(principal,op));
      CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, task_id TEXT NOT NULL REFERENCES tasks(id), content TEXT NOT NULL, conditions TEXT NOT NULL, state TEXT NOT NULL, version INTEGER NOT NULL, author TEXT NOT NULL, reviewer TEXT, expires_at TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge_refs(task_id TEXT NOT NULL REFERENCES tasks(id), knowledge_id TEXT NOT NULL REFERENCES knowledge(id), version INTEGER NOT NULL, PRIMARY KEY(task_id,knowledge_id,version));
      CREATE TABLE IF NOT EXISTS task_coordinators(task_id TEXT NOT NULL REFERENCES tasks(id), principal TEXT NOT NULL REFERENCES principals(id), PRIMARY KEY(task_id,principal));
      CREATE TABLE IF NOT EXISTS task_summaries(task_id TEXT NOT NULL REFERENCES tasks(id), version INTEGER NOT NULL, text TEXT NOT NULL, pending TEXT NOT NULL, through_seq INTEGER NOT NULL, author TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(task_id,version));
      CREATE TABLE IF NOT EXISTS notifications(id TEXT PRIMARY KEY, workspace TEXT NOT NULL, recipient TEXT NOT NULL REFERENCES principals(id), task_id TEXT NOT NULL REFERENCES tasks(id), subtask_id TEXT NOT NULL REFERENCES subtasks(id), type TEXT NOT NULL, created_at TEXT NOT NULL, acknowledged_at TEXT);
      CREATE INDEX IF NOT EXISTS notifications_recipient ON notifications(workspace,recipient,acknowledged_at,created_at);
      CREATE TABLE IF NOT EXISTS knowledge_versions(knowledge_id TEXT NOT NULL REFERENCES knowledge(id), version INTEGER NOT NULL, content TEXT NOT NULL, conditions TEXT NOT NULL, reviewer TEXT NOT NULL, expires_at TEXT NOT NULL, published_at TEXT NOT NULL, PRIMARY KEY(knowledge_id,version));
      CREATE TABLE IF NOT EXISTS knowledge_access(knowledge_id TEXT PRIMARY KEY REFERENCES knowledge(id), mode TEXT NOT NULL CHECK(mode IN ('workspace','restricted')));
      CREATE TABLE IF NOT EXISTS knowledge_grants(knowledge_id TEXT NOT NULL REFERENCES knowledge(id), principal TEXT NOT NULL REFERENCES principals(id), PRIMARY KEY(knowledge_id,principal));
      CREATE TABLE IF NOT EXISTS audit(seq INTEGER PRIMARY KEY AUTOINCREMENT, workspace TEXT NOT NULL, principal TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, recorded_at TEXT NOT NULL);`);
        // Backfill snapshots from databases created before version history existed.
        await this.run("INSERT OR IGNORE INTO knowledge_versions SELECT id,version,content,conditions,reviewer,expires_at,created_at FROM knowledge WHERE state IN ('published','revoked') AND reviewer IS NOT NULL AND expires_at IS NOT NULL");
        await this.db.exec(`CREATE INDEX IF NOT EXISTS tasks_workspace_created ON tasks(workspace,created_at,id); CREATE INDEX IF NOT EXISTS subtasks_agent_task ON subtasks(agent,task_id); CREATE INDEX IF NOT EXISTS events_task_seq ON events(task_id,seq); CREATE INDEX IF NOT EXISTS knowledge_workspace_state ON knowledge(workspace,state,expires_at);`);
        if(this.db.dialect==='postgres') await this.db.exec('COMMIT');
        } catch(e) { if(this.db.dialect==='postgres') await this.db.exec('ROLLBACK'); throw e; }
    }
    async close() { await this.db.close(); }
    async one(sql: string, ...params: any[]) { return await this.db.one(sql, params); }
    async all(sql: string, ...params: any[]) { return await this.db.all(sql, params); }
    async run(sql: string, ...params: any[]) { return await this.db.run(sql, params); }
    async bootstrap(p: Principal) {
        if (await this.one('SELECT id FROM principals LIMIT 1'))
            fail(409, 'Bootstrap already completed');
        if (!p.roles.includes('admin') || !p.token || !p.workspace || !p.id)
            fail(400, 'Invalid bootstrap principal');
        await this.run('INSERT INTO principals VALUES(?,?,?,?,1)', p.id, p.workspace, encode(p.roles), hash(p.token));
    }
    async authenticate(token: string) {
        const p = await this.one('SELECT * FROM principals WHERE token_hash=? AND active=1', hash(token));
        if (!p)
            return fail(401, 'Invalid credentials');
        return { id: p.id, workspace: p.workspace, roles: parse(p.roles), token: '', active: true };
    }
    require(p: Principal, ...roles: string[]) { if (!roles.some(r => p.roles.includes(r as any)))
        fail(403, 'Forbidden'); }
    async event(task: string, actor: string, type: string, data: unknown) {
        await this.run('INSERT INTO events(id,task_id,actor,type,data,recorded_at) VALUES(?,?,?,?,?,?)', id(), task, actor, type, encode(data), now());
        await this.run('UPDATE tasks SET version=version+1 WHERE id=?',task);
    }
    async operation(p: Principal, operationId: string, action: string, body: unknown, fn: () => unknown | Promise<unknown>, expectedVersion?: number) {
        const key = str(operationId, 'Idempotency-Key', 200);
        const fingerprint = hash(encode([action, body,expectedVersion??null]));
        await this.db.exec(this.db.dialect === 'sqlite' ? 'BEGIN IMMEDIATE' : 'BEGIN');
        try {
            if(this.db.dialect==='postgres') await this.db.one('SELECT pg_advisory_xact_lock(190106,1)',[]);
            const current=await this.one('SELECT active,roles FROM principals WHERE id=? AND workspace=?',p.id,p.workspace);
            if(!current || !current.active) return fail(401,'Principal no longer active');
            if(current.roles!==encode(p.roles)) return fail(401,'Authorization changed; authenticate again');
            const previous = await this.one('SELECT * FROM operations WHERE principal=? AND op=?', p.id, key);
            if (previous) {
                if (previous.request_hash !== fingerprint)
                    fail(409, 'Idempotency key reused with different request');
                await this.replayAccess(p, action, body);
                await this.audit(p, action, 'replay');
                await this.db.exec('COMMIT');
                return parse(previous.response);
            }
            if(expectedVersion!==undefined) {
                const parts=action.split('/').filter(Boolean).map(decodeURIComponent);
                let resource:Row;
                if(parts[1]==='tasks' && parts[2]) resource=await this.task(p,parts[2]);
                else if(parts[1]==='subtasks' && parts[2]) {const sub=await this.one('SELECT * FROM subtasks WHERE id=?',parts[2]);if(!sub) return fail(404,'Subtask not found');await this.task(p,sub.task_id);resource=sub;}
                else return fail(400,'If-Match is supported only for task and subtask changes');
                if(resource.version!==expectedVersion) return fail(412,'Resource version changed; reload before applying');
            }
            const response = await fn();
            await this.run('INSERT INTO operations VALUES(?,?,?,?)', p.id, key, fingerprint, encode(response));
            await this.audit(p, action, 'success');
            await this.db.exec('COMMIT');
            return response;
        }
        catch (e) {
            await this.db.exec('ROLLBACK');
            throw e;
        }
    }
    async replayAccess(p: Principal, action: string, body: unknown) {
        const parts = action.split('/').filter(Boolean).map(decodeURIComponent);
        if (parts[0] !== 'v1')
            fail(404, 'Not found');
        if (parts[1] === 'principals')
            this.require(p, 'admin');
        if(parts[1]==='maintenance') this.require(p,'admin');
        if (parts[1] === 'knowledge')
            this.require(p, 'reviewer', 'admin');
        if (parts[1] === 'notifications' && parts[2])
            await this.notification(p, parts[2]);
        if (parts[1] === 'tasks' && !parts[2])
            this.require(p, 'owner', 'admin');
        if (parts[1] === 'tasks' && parts[2]) {
            const t = await this.task(p, parts[2]);
            if (['assign', 'summary', 'stage-summaries'].includes(parts[3]))
                await this.coordinator(p, t);
            else
                this.owner(p, t);
            if (parts[3] === 'references') {
                const kid = str(obj(body).knowledgeId, 'knowledgeId', 100);
                const k = await this.one("SELECT * FROM knowledge WHERE id=? AND workspace=? AND state='published' AND expires_at>?", kid, p.workspace, now());
                if (!k || !await this.knowledgeAccess(p, k))
                    return fail(404, 'Knowledge unavailable');
            }
        }
        if (parts[1] === 'subtasks' && parts[2]) {
            const sub = await this.one('SELECT task_id FROM subtasks WHERE id=?', parts[2]);
            if (!sub)
                return fail(404, 'Subtask not found');
            const t = await this.task(p, sub.task_id);
            if (['accept', 'reject', 'submit', 'progress','outcome-unknown'].includes(parts[3])) {
                this.require(p, 'agent');
                await this.subtask(p, parts[2]);
            }
            else
                this.owner(p, t);
        }
    }
    async audit(p: Principal, action: string, outcome: string) {
        await this.run('INSERT INTO audit(workspace,principal,action,outcome,recorded_at) VALUES(?,?,?,?,?)', p.workspace, p.id, action, outcome, now());
    }
    async auditList(p: Principal) {
        this.require(p, 'admin');
        return await this.all('SELECT seq,principal,action,outcome,recorded_at FROM audit WHERE workspace=? ORDER BY seq DESC LIMIT 500', p.workspace);
    }
    async task(p: Principal, taskId: string) {
        const task = await this.one('SELECT * FROM tasks WHERE id=? AND workspace=?', taskId, p.workspace);
        if (!task)
            return fail(404, 'Task not found');
        if (!p.roles.includes('admin') && task.owner !== p.id && !await this.one('SELECT id FROM subtasks WHERE task_id=? AND agent=?', taskId, p.id) && !await this.one('SELECT task_id FROM task_coordinators WHERE task_id=? AND principal=?', taskId, p.id))
            fail(403, 'Forbidden');
        return task;
    }
    owner(p: Principal, t: Row) { if (t.owner !== p.id && !p.roles.includes('admin'))
        fail(403, 'Only owner or administrator'); }
    async coordinator(p: Principal, t: Row) {
        if (t.owner !== p.id && !p.roles.includes('admin') && !await this.one('SELECT task_id FROM task_coordinators WHERE task_id=? AND principal=?', t.id, p.id))
            fail(403, 'Only owner, coordinator or administrator');
    }
    async delegate(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        this.owner(p, t);
        const principal = str(obj(input).principal, 'principal', 100);
        if (!['pending', 'running'].includes(t.status))
            fail(409, 'Task cannot be delegated');
        const target = await this.one('SELECT * FROM principals WHERE id=? AND workspace=? AND active=1', principal, p.workspace);
        if (!target || !parse(target.roles).includes('agent'))
            fail(400, 'Active agent not found');
        if (await this.one('SELECT task_id FROM task_coordinators WHERE task_id=? AND principal=?', taskId, principal))
            fail(409, 'Coordinator already delegated');
        await this.run('INSERT INTO task_coordinators VALUES(?,?)', taskId, principal);
        await this.event(taskId, p.id, 'coordinator_delegated', { principal });
        return { principal };
    }
    async undelegate(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        this.owner(p, t);
        const principal = str(obj(input).principal, 'principal', 100);
        const result = await this.run('DELETE FROM task_coordinators WHERE task_id=? AND principal=?', taskId, principal);
        if (!result.changes)
            fail(404, 'Coordinator not delegated');
        await this.event(taskId, p.id, 'coordinator_removed', { principal });
        return { principal, delegated: false };
    }
    async register(p: Principal, input: unknown) {
        this.require(p, 'admin');
        const b = obj(input);
        const ident = str(b.id, 'id', 100), token = str(b.token, 'token', 500), roles = b.roles;
        if (token.length < 24 || !Array.isArray(roles) || !roles.length || roles.some(r => !['admin', 'owner', 'agent', 'reviewer'].includes(r)))
            fail(400, 'Invalid roles or token (minimum 24 characters)');
        if (await this.one('SELECT id FROM principals WHERE id=? OR token_hash=?', ident, hash(token)))
            fail(409, 'Principal or token already exists');
        await this.run('INSERT INTO principals VALUES(?,?,?,?,1)', ident, p.workspace, encode(roles), hash(token));
        await this.setProfile(p,ident,{capabilities:b.capabilities??[],description:b.description??ident});
        return { id: ident, workspace: p.workspace, roles };
    }
    async setProfile(p: Principal, principalId: string, input: unknown) {
        this.require(p,'admin');const b=obj(input);
        if(!await this.one('SELECT id FROM principals WHERE id=? AND workspace=?',principalId,p.workspace)) return fail(404,'Principal not found');
        const capabilities=b.capabilities;
        if(!Array.isArray(capabilities)||capabilities.length>50||capabilities.some(c=>typeof c!=='string'||!c.trim()||c.length>100)||new Set(capabilities).size!==capabilities.length) fail(400,'Invalid capabilities');
        const description=str(b.description,'description',1000);
        await this.run('INSERT INTO principal_profiles VALUES(?,?) ON CONFLICT(principal) DO UPDATE SET profile=excluded.profile',principalId,encode({description,capabilities}));
        return {id:principalId,description,capabilities};
    }
    async rotateToken(p: Principal, principalId: string, input: unknown) {
        this.require(p,'admin');const token=str(obj(input).token,'token',500);
        if(token.length<24) fail(400,'Token must contain at least 24 characters');
        if(await this.one('SELECT id FROM principals WHERE token_hash=?',hash(token))) fail(409,'Token already in use');
        const result=await this.run('UPDATE principals SET token_hash=? WHERE id=? AND workspace=?',hash(token),principalId,p.workspace);
        if(!result.changes) return fail(404,'Principal not found');return {id:principalId,rotated:true};
    }
    async deactivate(p: Principal, principalId: string) {
        this.require(p, 'admin');
        if (principalId === p.id)
            fail(400, 'Cannot deactivate yourself');
        const r = await this.run('UPDATE principals SET active=0 WHERE id=? AND workspace=?', principalId, p.workspace);
        if (!r.changes)
            fail(404, 'Principal not found');
        return { id: principalId, active: false };
    }
    async directory(p: Principal, capability?: string) {
        if(capability!==undefined && capability.length>100) fail(400,'Invalid capability');
        const rows=await this.all('SELECT p.id,p.workspace,p.roles,p.active,r.profile FROM principals p LEFT JOIN principal_profiles r ON r.principal=p.id WHERE p.workspace=? ORDER BY p.id',p.workspace);
        return rows.map(r=>({...r,roles:parse(r.roles),active:!!r.active,profile:parse(r.profile)??{description:r.id,capabilities:[]}})).filter(r=>!capability||r.profile.capabilities.includes(capability));
    }
    async create(p: Principal, input: unknown) {
        this.require(p, 'owner', 'admin');
        const b = obj(input), task = id();
        const title = str(b.title, 'title', 200), material = str(b.material, 'material', 100), quantity = num(b.quantity, 'quantity', 1), due = timestamp(b.due, 'due'), acceptance = str(b.acceptance, 'acceptance');
        await this.run('INSERT INTO tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?)', task, p.workspace, title, material, quantity, due, acceptance, p.id, 'pending', null, 0, now());
        await this.event(task, p.id, 'task_created', { title, material, quantity, due, acceptance });
        return { id: task, status: 'pending', version: 1 };
    }
    async list(p: Principal) {
        return await this.all(`SELECT DISTINCT t.id,t.title,t.status,t.owner,t.version,t.created_at FROM tasks t LEFT JOIN subtasks s ON s.task_id=t.id WHERE t.workspace=? AND (?=1 OR t.owner=? OR s.agent=? OR EXISTS(SELECT 1 FROM task_coordinators c WHERE c.task_id=t.id AND c.principal=?)) ORDER BY t.created_at DESC`, p.workspace, p.roles.includes('admin') ? 1 : 0, p.id, p.id, p.id);
    }
    async context(p: Principal, taskId: string) {
        const detail = await this.detail(p, taskId);
        const full = detail.owner === p.id || p.roles.includes('admin') || !!await this.one('SELECT 1 FROM task_coordinators WHERE task_id=? AND principal=?', taskId, p.id);
        const stageSummary = full ? await this.one('SELECT * FROM task_summaries WHERE task_id=? ORDER BY version DESC LIMIT 1', taskId) : undefined;
        const latestEvent = (await this.one('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE task_id=?', taskId))?.seq;
        return { task: { id: detail.id, title: detail.title, status: detail.status, version: detail.version, acceptance: detail.acceptance, due: detail.due }, subtasks: detail.subtasks, pending: detail.subtasks.filter((s: Row) => ['invited', 'accepted', 'returned', 'timed_out','outcome_unknown','rejected'].includes(s.status)).map((s: Row) => ({ id: s.id, status: s.status, kind: s.kind })), result: detail.result, references: detail.knowledgeRefs, stageSummary: stageSummary ? { ...stageSummary, stale: latestEvent > stageSummary.through_seq } : null, events: detail.events.slice(-20), eventsTruncated: detail.events.length > 20 };
    }
    async stageSummary(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        await this.coordinator(p, t);
        const b = obj(input);
        const text = str(b.text, 'text'), pending = str(b.pending, 'pending');
        const through = (await this.one('SELECT COALESCE(MAX(seq),0) AS seq FROM events WHERE task_id=?', taskId))!.seq;
        const version = (await this.one('SELECT COALESCE(MAX(version),0)+1 AS version FROM task_summaries WHERE task_id=?', taskId))!.version;
        await this.run('INSERT INTO task_summaries VALUES(?,?,?,?,?,?,?)', taskId, version, text, pending, through, p.id, now());
        return { taskId, version, throughSeq: through };
    }
    async page(p: Principal, limit: number, offset: number) {
        if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0)
            fail(400, 'Invalid pagination');
        const items = await this.all(`SELECT DISTINCT t.id,t.title,t.status,t.owner,t.version,t.created_at FROM tasks t LEFT JOIN subtasks s ON s.task_id=t.id WHERE t.workspace=? AND (?=1 OR t.owner=? OR s.agent=? OR EXISTS(SELECT 1 FROM task_coordinators c WHERE c.task_id=t.id AND c.principal=?)) ORDER BY t.created_at DESC,t.id LIMIT ? OFFSET ?`, p.workspace, p.roles.includes('admin') ? 1 : 0, p.id, p.id, p.id, limit + 1, offset);
        return { items: items.slice(0, limit), nextOffset: items.length > limit ? offset + limit : null };
    }
    async detail(p: Principal, taskId: string): Promise<Row> {
        const task = await this.task(p, taskId);
        const unrestricted = task.owner === p.id || p.roles.includes('admin') || !!await this.one('SELECT task_id FROM task_coordinators WHERE task_id=? AND principal=?', taskId, p.id);
        const subtasks = unrestricted ? await this.all('SELECT * FROM subtasks WHERE task_id=? ORDER BY id', taskId) : await this.all('SELECT * FROM subtasks WHERE task_id=? AND agent=? ORDER BY id', taskId, p.id);
        // Agents receive their own subtask, not other agents' results or task event details.
        const visibleKnowledge = async (kid: string) => { const k = await this.one('SELECT * FROM knowledge WHERE id=? AND workspace=?', kid, p.workspace); return !!k && await this.knowledgeAccess(p, k); };
        const events = unrestricted ? (await this.all('SELECT * FROM events WHERE task_id=? ORDER BY seq', taskId)).map((e): Row => ({ ...e, data: parse(e.data) })) : [];
        const knowledgeRefs = unrestricted ? await this.all('SELECT * FROM knowledge_refs WHERE task_id=?', taskId) : [];
        for (let i = events.length - 1; i >= 0; i--)
            if (events[i].type.startsWith('knowledge_') && events[i].data.id && !await visibleKnowledge(events[i].data.id))
                events.splice(i, 1);
        for (let i = knowledgeRefs.length - 1; i >= 0; i--)
            if (!await visibleKnowledge(knowledgeRefs[i].knowledge_id))
                knowledgeRefs.splice(i, 1);
        for(const sub of subtasks) { sub.dependsOn=(await this.all('SELECT depends_on FROM subtask_dependencies WHERE subtask_id=?',sub.id)).map(r=>r.depends_on); sub.due=(await this.one('SELECT due FROM subtask_deadlines WHERE subtask_id=?',sub.id))?.due??task.due; }
        return { ...task, result: unrestricted ? parse(task.result) : null, subtasks: subtasks.map(s => ({ ...s, result: parse(s.result) })), events, knowledgeRefs };
    }
    async assign(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        await this.coordinator(p, t);
        const b = obj(input);
        if (!['pending', 'running'].includes(t.status))
            fail(409, 'Task cannot be assigned');
        const agent = str(b.agent, 'agent', 100), kind = str(b.kind, 'kind', 100);
        const target = await this.one('SELECT * FROM principals WHERE id=? AND workspace=? AND active=1', agent, p.workspace);
        if (!target || !parse(target.roles).includes('agent'))
            fail(400, 'Active agent not found');
        if (await this.one('SELECT id FROM subtasks WHERE task_id=? AND agent=? AND kind=?', taskId, agent, kind))
            fail(409, 'Subtask already assigned');
        const dependencies=b.dependsOn??[];
        if(!Array.isArray(dependencies)||dependencies.length>100||dependencies.some(x=>typeof x!=='string')||new Set(dependencies).size!==dependencies.length) fail(400,'Invalid dependencies');
        for(const dependency of dependencies) if(!await this.one('SELECT id FROM subtasks WHERE id=? AND task_id=?',dependency,taskId)) fail(400,'Dependency must belong to the same task');
        const due=b.due===undefined?t.due:timestamp(b.due,'due');
        const sub = id();
        await this.run('INSERT INTO subtasks VALUES(?,?,?,?,?,?,?)', sub, taskId, agent, kind, 'invited', null, 1);
        await this.run("UPDATE tasks SET status='running' WHERE id=?", taskId);
        for(const dependency of dependencies) await this.run('INSERT INTO subtask_dependencies VALUES(?,?)',sub,dependency);
        await this.run('INSERT INTO subtask_deadlines VALUES(?,?)',sub,due);
        await this.notify(t, sub, agent, 'invited');
        await this.event(taskId, p.id, 'subtask_invited', { subtaskId: sub, agent, kind, dependsOn:dependencies,due });
        return { id: sub, status: 'invited', version: 1 };
    }
    async subtask(p: Principal, subId: string) {
        const s = await this.one('SELECT s.* FROM subtasks s JOIN tasks t ON t.id=s.task_id WHERE s.id=? AND t.workspace=?', subId, p.workspace);
        if (!s)
            return fail(404, 'Subtask not found');
        if (s.agent !== p.id)
            fail(403, 'Only assigned agent');
        return s;
    }
    async notify(t: Row, subId: string, agent: string, type: string) {
        await this.run('INSERT INTO notifications VALUES(?,?,?,?,?,?,?,NULL)', id(), t.workspace, agent, t.id, subId, type, now());
    }
    async notification(p: Principal, notificationId: string) {
        this.require(p, 'agent');
        const n = await this.one('SELECT * FROM notifications WHERE id=? AND workspace=? AND recipient=?', notificationId, p.workspace, p.id);
        if (!n)
            return fail(404, 'Notification not found');
        await this.subtask(p, n.subtask_id);
        await this.task(p, n.task_id);
        return n;
    }
    async notifications(p: Principal) {
        this.require(p, 'agent');
        return await this.all('SELECT id,task_id,subtask_id,type,created_at FROM notifications WHERE workspace=? AND recipient=? AND acknowledged_at IS NULL ORDER BY created_at,id LIMIT 100', p.workspace, p.id);
    }
    async acknowledge(p: Principal, notificationId: string) {
        await this.notification(p, notificationId);
        await this.run('UPDATE notifications SET acknowledged_at=COALESCE(acknowledged_at,?) WHERE id=?', now(), notificationId);
        return { id: notificationId, acknowledged: true };
    }
    async inbox(p: Principal) {
        this.require(p, 'agent');
        return await this.all(`SELECT s.id,s.task_id,s.kind,s.status,s.version,t.title,t.material,t.quantity,t.due,t.acceptance FROM subtasks s JOIN tasks t ON t.id=s.task_id WHERE s.agent=? AND t.workspace=? AND t.status='running' AND s.status IN ('invited','accepted','returned') AND NOT EXISTS(SELECT 1 FROM subtask_dependencies d JOIN subtasks prerequisite ON prerequisite.id=d.depends_on WHERE d.subtask_id=s.id AND prerequisite.status NOT IN ('submitted','verified')) ORDER BY t.created_at`, p.id, p.workspace);
    }
    async transition(p: Principal, subId: string, action: string, input: unknown) {
        this.require(p, 'agent');
        const s = await this.subtask(p, subId);
        const t = await this.task(p, s.task_id);
        const b = obj(input);
        if (t.status !== 'running')
            fail(409, 'Task is not running');
        let next = '', result: unknown = null;
        if(action==='accept' && await this.one("SELECT 1 FROM subtask_dependencies d JOIN subtasks prerequisite ON prerequisite.id=d.depends_on WHERE d.subtask_id=? AND prerequisite.status NOT IN ('submitted','verified')",subId)) fail(409,'Dependencies are incomplete');
        if (action === 'accept' && ['invited', 'returned'].includes(s.status))
            next = 'accepted';
        else if (action === 'reject' && ['invited', 'returned'].includes(s.status)) {
            next = 'rejected';
            result = { reason: str(b.reason, 'reason') };
        }
        else if (action === 'submit' && s.status === 'accepted') {
            next = 'submitted';
            const x = obj(b.result);
            if (x.quantity === undefined && x.summary === undefined)
                fail(400, 'Result requires quantity or summary');
            result = { ...(x.quantity === undefined ? {} : { quantity: num(x.quantity, 'quantity') }), ...(x.summary === undefined ? {} : { summary: str(x.summary, 'summary') }), source: str(x.source, 'source'), observedAt: timestamp(x.observedAt, 'observedAt'), ...(x.reference === undefined ? {} : { reference: str(x.reference, 'reference') }) };
        }
        else
            fail(409, 'Invalid subtask transition');
        await this.run('UPDATE subtasks SET status=?,result=?,version=version+1 WHERE id=?', next, result === null ? null : encode(result), subId);
        await this.event(s.task_id, p.id, 'subtask_' + next, { subtaskId: subId, ...(result ? { result } : {}) });
        return { id: subId, status: next, version: s.version + 1 };
    }
    async progress(p: Principal, subId: string, input: unknown) {
        this.require(p, 'agent');
        const s = await this.subtask(p, subId);
        const t = await this.task(p, s.task_id);
        if (t.status !== 'running' || s.status !== 'accepted')
            fail(409, 'Subtask is not active');
        const text = str(obj(input).text, 'text');
        await this.event(t.id, p.id, 'subtask_progress', { subtaskId: subId, text });
        return { id: subId, status: s.status, version: s.version };
    }
    async outcomeUnknown(p: Principal, subId: string, input: unknown) {
        this.require(p,'agent');const sub=await this.subtask(p,subId);const t=await this.task(p,sub.task_id);const b=obj(input);
        if(t.status!=='running'||sub.status!=='accepted') fail(409,'Subtask is not active');
        const reason=str(b.reason,'reason');const externalOperationId=str(b.externalOperationId,'externalOperationId',200);
        await this.run("UPDATE subtasks SET status='outcome_unknown',result=?,version=version+1 WHERE id=?",encode({reason,externalOperationId}),subId);
        await this.event(t.id,p.id,'subtask_outcome_unknown',{subtaskId:subId,reason,externalOperationId});
        return {id:subId,status:'outcome_unknown',version:sub.version+1};
    }
    async expireSubtasks(p: Principal) {
        this.require(p,'admin');const cutoff=now();
        const overdue=await this.all("SELECT s.* FROM subtasks s JOIN subtask_deadlines d ON d.subtask_id=s.id JOIN tasks t ON t.id=s.task_id WHERE t.workspace=? AND t.status='running' AND s.status IN ('invited','accepted','returned') AND d.due<=?",p.workspace,cutoff);
        for(const sub of overdue) {
            await this.run("UPDATE subtasks SET status='timed_out',version=version+1 WHERE id=?",sub.id);
            await this.event(sub.task_id,p.id,'subtask_timed_out',{subtaskId:sub.id,note:'Deadline elapsed; reconcile execution outcome before retry',scheduled:true});
        }
        return {expired:overdue.length,checkedAt:cutoff};
    }
    async timeoutSubtask(p: Principal, subId: string, input: unknown) {
        const s = await this.one('SELECT * FROM subtasks WHERE id=?', subId);
        if (!s)
            return fail(404, 'Subtask not found');
        const t = await this.task(p, s.task_id);
        this.owner(p, t);
        const note = str(obj(input).note, 'note');
        if (!['invited', 'accepted'].includes(s.status) || t.status !== 'running')
            fail(409, 'Cannot mark subtask timed out');
        await this.run("UPDATE subtasks SET status='timed_out',version=version+1 WHERE id=?", subId);
        await this.event(t.id, p.id, 'subtask_timed_out', { subtaskId: subId, note });
        return { id: subId, status: 'timed_out', version: s.version + 1 };
    }
    async returnSubtask(p: Principal, subId: string, input: unknown) {
        const s = await this.one('SELECT * FROM subtasks WHERE id=?', subId);
        if (!s)
            return fail(404, 'Subtask not found');
        const t = await this.task(p, s.task_id);
        this.owner(p, t);
        const note = str(obj(input).note, 'note');
        if (!['submitted', 'rejected', 'timed_out','outcome_unknown'].includes(s.status) || t.status !== 'running')
            fail(409, 'Cannot return subtask');
        await this.run("UPDATE subtasks SET status='returned',version=version+1 WHERE id=?", subId);
        await this.notify(t, subId, s.agent, 'returned');
        await this.event(t.id, p.id, 'subtask_returned', { subtaskId: subId, note });
        return { id: subId, status: 'returned', version: s.version + 1 };
    }
    async summary(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        await this.coordinator(p, t);
        const b = obj(input);
        if (t.status !== 'running')
            fail(409, 'Task is not running');
        const subs = await this.all('SELECT * FROM subtasks WHERE task_id=?', taskId);
        if (!subs.length || subs.some(s => s.status !== 'submitted'))
            fail(409, 'Subtasks are incomplete');
        const result = { text: str(b.text, 'text'), subtasks: subs.map(s => ({ id: s.id, agent: s.agent, kind: s.kind, result: parse(s.result) })) };
        await this.run("UPDATE tasks SET status='review',result=? WHERE id=?", encode(result), taskId);
        await this.event(taskId, p.id, 'summary_submitted', result);
        return { status: 'review', version: t.version + 1 };
    }
    async review(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        this.owner(p, t);
        const b = obj(input), decision = str(b.decision, 'decision', 10), note = str(b.note, 'note');
        if (t.status !== 'review' || !['accept', 'return'].includes(decision))
            fail(409, 'Invalid review');
        const status = decision === 'accept' ? 'completed' : 'running';
        await this.run('UPDATE tasks SET status=? WHERE id=?', status, taskId);
        if (decision === 'accept')
            await this.run("UPDATE subtasks SET status='verified',version=version+1 WHERE task_id=? AND status='submitted'", taskId);
        await this.event(taskId, p.id, decision === 'accept' ? 'task_accepted' : 'task_returned', { note });
        return { status, version: t.version + 1 };
    }
    async cancel(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        this.owner(p, t);
        const note = str(obj(input).note, 'note');
        if (['completed', 'cancelled'].includes(t.status))
            fail(409, 'Task cannot be cancelled');
        await this.run("UPDATE tasks SET status='cancelled' WHERE id=?", taskId);
        await this.run("UPDATE subtasks SET status='cancelled',version=version+1 WHERE task_id=? AND status NOT IN ('verified','cancelled')", taskId);
        for(const sub of await this.all("SELECT * FROM subtasks WHERE task_id=? AND status='cancelled'",taskId)) await this.notify(t,sub.id,sub.agent,'cancelled');
        await this.event(taskId, p.id, 'task_cancelled', { note });
        return { status: 'cancelled', version: t.version + 1 };
    }
    async candidate(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        this.owner(p, t);
        const b = obj(input);
        if (t.status !== 'completed')
            fail(409, 'Task must be accepted');
        const kid = id(), content = str(b.content, 'content'), conditions = str(b.conditions, 'conditions');
        await this.run('INSERT INTO knowledge VALUES(?,?,?,?,?,?,?,?,?,?,?)', kid, p.workspace, taskId, content, conditions, 'candidate', 1, p.id, null, null, now());
        await this.event(taskId, p.id, 'knowledge_candidate', { id: kid, version: 1 });
        return { id: kid, state: 'candidate', version: 1 };
    }
    async knowledgeAction(p: Principal, kid: string, action: string, input: unknown) {
        this.require(p, 'reviewer', 'admin');
        const k = await this.one('SELECT * FROM knowledge WHERE id=? AND workspace=?', kid, p.workspace);
        if (!k)
            return fail(404, 'Knowledge not found');
        const b = obj(input);
        if (action === 'publish') {
            if (k.state !== 'candidate')
                fail(409, 'Knowledge is not a candidate');
            const expires = timestamp(b.expiresAt, 'expiresAt');
            if (expires <= now())
                fail(400, 'Expiration must be in the future');
            await this.setKnowledgeAccess(p, k, b.audience ?? []);
            await this.run("UPDATE knowledge SET state='published',reviewer=?,expires_at=? WHERE id=?", p.id, expires, kid);
            await this.run('INSERT INTO knowledge_versions VALUES(?,?,?,?,?,?,?)', kid, k.version, k.content, k.conditions, p.id, expires, now());
            await this.event(k.task_id, p.id, 'knowledge_published', { id: kid, version: k.version, expiresAt: expires });
            return { id: kid, state: 'published', version: k.version };
        }
        if (k.state !== 'published')
            fail(409, 'Knowledge is not published');
        const reason = str(b.reason, 'reason');
        await this.run("UPDATE knowledge SET state='revoked' WHERE id=?", kid);
        await this.event(k.task_id, p.id, 'knowledge_revoked', { id: kid, version: k.version, reason });
        return { id: kid, state: 'revoked', version: k.version };
    }
    async setKnowledgeAccess(p: Principal, k: Row, audience: unknown) {
        if (audience !== undefined && audience !== 'workspace' && (!Array.isArray(audience) || audience.some(x => typeof x !== 'string') || audience.length > 100))
            fail(400, 'Invalid audience');
        const mode = audience === undefined || audience === 'workspace' ? 'workspace' : 'restricted';
        if (Array.isArray(audience)) {
            if (new Set(audience).size !== audience.length)
                fail(400, 'Duplicate audience principal');
            for (const principal of audience)
                if (!await this.one('SELECT id FROM principals WHERE id=? AND workspace=? AND active=1', principal, p.workspace))
                    fail(400, 'Audience principal not active in workspace');
        }
        await this.run('INSERT INTO knowledge_access VALUES(?,?) ON CONFLICT(knowledge_id) DO UPDATE SET mode=excluded.mode', k.id, mode);
        await this.run('DELETE FROM knowledge_grants WHERE knowledge_id=?', k.id);
        if (Array.isArray(audience))
            for (const principal of audience)
                await this.run('INSERT INTO knowledge_grants VALUES(?,?)', k.id, principal);
    }
    async knowledgeAccess(p: Principal, k: Row) {
        if (p.roles.includes('admin') || p.roles.includes('reviewer'))
            return true;
        if (k.state === 'candidate')
            return k.author === p.id;
        const access = await this.one('SELECT mode FROM knowledge_access WHERE knowledge_id=?', k.id);
        return !access || access.mode === 'workspace' || !!await this.one('SELECT 1 FROM knowledge_grants WHERE knowledge_id=? AND principal=?', k.id, p.id);
    }
    async changeKnowledgeAccess(p: Principal, kid: string, input: unknown) {
        this.require(p, 'reviewer', 'admin');
        const k = await this.one('SELECT * FROM knowledge WHERE id=? AND workspace=?', kid, p.workspace);
        if (!k)
            return fail(404, 'Knowledge not found');
        const b = obj(input);
        if (b.audience === undefined)
            fail(400, 'Audience required');
        await this.setKnowledgeAccess(p, k, b.audience);
        await this.event(k.task_id, p.id, 'knowledge_access_changed', { id: kid, version: k.version, audience: b.audience });
        return { id: kid, audience: b.audience };
    }
    async revise(p: Principal, kid: string, input: unknown) {
        this.require(p, 'reviewer', 'admin');
        const k = await this.one('SELECT * FROM knowledge WHERE id=? AND workspace=?', kid, p.workspace);
        if (!k)
            return fail(404, 'Knowledge not found');
        if (!['published', 'revoked'].includes(k.state))
            fail(409, 'Only published or revoked knowledge can be revised');
        const b = obj(input), content = str(b.content, 'content'), conditions = str(b.conditions, 'conditions'), reason = str(b.reason, 'reason');
        await this.run("UPDATE knowledge SET content=?,conditions=?,state='candidate',version=version+1,author=?,reviewer=NULL,expires_at=NULL WHERE id=?", content, conditions, p.id, kid);
        await this.event(k.task_id, p.id, 'knowledge_revision_candidate', { id: kid, version: k.version + 1, reason });
        return { id: kid, state: 'candidate', version: k.version + 1 };
    }
    async knowledgeVersions(p: Principal, kid: string) {
        this.require(p, 'reviewer', 'admin');
        if (!await this.one('SELECT id FROM knowledge WHERE id=? AND workspace=?', kid, p.workspace))
            fail(404, 'Knowledge not found');
        return await this.all('SELECT * FROM knowledge_versions WHERE knowledge_id=? ORDER BY version', kid);
    }
    async evidence(p: Principal, taskId: string, kid: string, version: number) {
        const t = await this.task(p, taskId);
        await this.coordinator(p, t);
        if (!Number.isSafeInteger(version) || version < 1)
            fail(400, 'Invalid version');
        const k = await this.one('SELECT * FROM knowledge WHERE id=? AND workspace=?', kid, p.workspace);
        if (!k || !await this.knowledgeAccess(p, k) || !await this.one('SELECT 1 FROM knowledge_refs WHERE task_id=? AND knowledge_id=? AND version=?', taskId, kid, version))
            return fail(404, 'Evidence unavailable');
        const snapshot = await this.one('SELECT version,content,conditions,reviewer,expires_at,published_at FROM knowledge_versions WHERE knowledge_id=? AND version=?', kid, version);
        if (!snapshot)
            return fail(404, 'Evidence unavailable');
        return { knowledgeId: kid, taskId, sourceTaskId: k.task_id, currentState: k.state, currentVersion: k.version, ...snapshot };
    }
    async knowledgeCandidates(p: Principal) {
        this.require(p, 'reviewer', 'admin');
        return await this.all("SELECT id,task_id,content,conditions,version,author,created_at FROM knowledge WHERE workspace=? AND state='candidate' ORDER BY created_at", p.workspace);
    }
    async knowledgeList(p: Principal, query = '', limit=100) {
        if (query.length > 200)
            fail(400, 'Query too long');
        return await this.all("SELECT id,task_id,content,conditions,version,reviewer,expires_at FROM knowledge WHERE workspace=? AND state='published' AND expires_at>? AND (?='' OR instr(lower(content),lower(?))>0 OR instr(lower(conditions),lower(?))>0) AND (?=1 OR NOT EXISTS(SELECT 1 FROM knowledge_access a WHERE a.knowledge_id=knowledge.id AND a.mode='restricted') OR EXISTS(SELECT 1 FROM knowledge_grants g WHERE g.knowledge_id=knowledge.id AND g.principal=?)) ORDER BY created_at DESC,id LIMIT ?", p.workspace, now(), query, query, query, p.roles.includes('admin') || p.roles.includes('reviewer') ? 1 : 0, p.id,limit);
    }
    async searchKnowledge(p: Principal, query: string, limit: number, tokenBudget: number) {
        if(query.length>200 || !Number.isInteger(limit)||limit<1||limit>100||!Number.isInteger(tokenBudget)||tokenBudget<64||tokenBudget>32768) fail(400,'Invalid search query or budget');
        const rows=await this.knowledgeList(p,'',1001);
        return rankKnowledge(rows.slice(0,1000) as any,query,limit,tokenBudget,rows.length>1000);
    }
    async currentEvidence(p: Principal, kid: string) {
        const k=await this.one("SELECT * FROM knowledge WHERE id=? AND workspace=? AND state='published' AND expires_at>?",kid,p.workspace,now());
        if(!k || !await this.knowledgeAccess(p,k)) return fail(404,'Evidence unavailable');
        return {id:k.id,version:k.version,content:k.content,conditions:k.conditions,reviewer:k.reviewer,expiresAt:k.expires_at,sourceTaskId:k.task_id,reference:`knowledge:${k.id}:${k.version}`};
    }
    async reference(p: Principal, taskId: string, input: unknown) {
        const t = await this.task(p, taskId);
        this.owner(p, t);
        const kid = str(obj(input).knowledgeId, 'knowledgeId', 100);
        const k = await this.one("SELECT * FROM knowledge WHERE id=? AND workspace=? AND state='published' AND expires_at>?", kid, p.workspace, now());
        if (!k || !await this.knowledgeAccess(p, k))
            return fail(404, 'Knowledge unavailable');
        if (await this.one('SELECT * FROM knowledge_refs WHERE task_id=? AND knowledge_id=? AND version=?', taskId, kid, k.version))
            fail(409, 'Reference already exists');
        await this.run('INSERT INTO knowledge_refs VALUES(?,?,?)', taskId, kid, k.version);
        await this.event(taskId, p.id, 'knowledge_referenced', { id: kid, version: k.version });
        return { id: kid, version: k.version };
    }
}
