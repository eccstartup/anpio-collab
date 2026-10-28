import http from 'node:http';
import { readFileSync } from 'node:fs';
import { Store, AppError } from './store.ts';
import type { Principal } from '../protocol/types.ts';
export function createServer(store: Store) {
    return http.createServer(async (req, res) => store.exclusive(async () => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Cache-Control', 'no-store');
        let actor: Principal | undefined;
        let auditPath = '';
        try {
            const url = new URL(req.url ?? '/', 'http://localhost');
            if (req.method === 'GET' && url.pathname === '/') {
                res.setHeader('Content-Type', 'text/html; charset=utf-8');
                res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
                res.end(readFileSync(new URL('./public/index.html', import.meta.url)));
                return;
            }
            if(req.method==='GET' && ['/app.js','/app.css'].includes(url.pathname)) {res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript; charset=utf-8':'text/css; charset=utf-8');res.end(readFileSync(new URL('./public'+url.pathname,import.meta.url)));return;}
            if (req.method === 'GET' && url.pathname === '/health') {
                res.end(JSON.stringify({ ok: true, protocol: 'v1' }));
                return;
            }
            const auth = req.headers.authorization;
            if (!auth?.startsWith('Bearer ') || auth.length > 1024)
                throw new AppError(401, 'Bearer token required');
            const p = await store.authenticate(auth.slice(7));
            actor = p;
            auditPath = url.pathname;
            const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
            if (parts.shift() !== 'v1')
                throw new AppError(404, 'Not found');
            const method = req.method;
            let body: unknown = {};
            if (method === 'POST') {
                let raw = '';
                for await (const chunk of req) {
                    raw += chunk;
                    if (Buffer.byteLength(raw) > 65536)
                        throw new AppError(413, 'Request too large');
                }
                try {
                    body = raw ? JSON.parse(raw) : {};
                }
                catch {
                    throw new AppError(400, 'Invalid JSON');
                }
            }
            let result: unknown;
            if (method === 'GET' && parts.join('/') === 'me') result={id:p.id,workspace:p.workspace,roles:p.roles};
            else if (method === 'GET' && parts.join('/') === 'tasks/page')
                result = await store.page(p, Number(url.searchParams.get('limit') ?? 20), Number(url.searchParams.get('offset') ?? 0));
            else if (method === 'GET' && parts.length === 5 && parts[0] === 'tasks' && parts[2] === 'evidence')
                result = await store.evidence(p, parts[1], parts[3], Number(parts[4]));
            else if (method === 'GET' && parts.length === 3 && parts[0] === 'tasks' && parts[2] === 'context')
                result = await store.context(p, parts[1]);
            else if (method === 'GET' && parts.join('/') === 'principals')
                result = await store.directory(p,url.searchParams.get('capability')??undefined);
            else if (method === 'GET' && parts.join('/') === 'tasks')
                result = await store.list(p);
            else if (method === 'GET' && parts.length === 2 && parts[0] === 'tasks')
                result = await store.detail(p, parts[1]);
            else if (method === 'GET' && parts.join('/') === 'notifications')
                result = await store.notifications(p);
            else if (method === 'GET' && parts.join('/') === 'inbox')
                result = await store.inbox(p);
            else if (method === 'GET' && parts.join('/') === 'audit')
                result = await store.auditList(p);
            else if(method==='GET' && parts.join('/')==='knowledge/search') result=await store.searchKnowledge(p,url.searchParams.get('q')??'',Number(url.searchParams.get('limit')??10),Number(url.searchParams.get('tokenBudget')??4096));
            else if(method==='GET' && parts.length===3 && parts[0]==='knowledge' && parts[2]==='evidence') result=await store.currentEvidence(p,parts[1]);
            else if (method === 'GET' && parts.join('/') === 'knowledge')
                result = await store.knowledgeList(p, url.searchParams.get('q') ?? '');
            else if (method === 'GET' && parts.join('/') === 'knowledge/candidates')
                result = await store.knowledgeCandidates(p);
            else if (method === 'GET' && parts.length === 3 && parts[0] === 'knowledge' && parts[2] === 'versions')
                result = await store.knowledgeVersions(p, parts[1]);
            else if (method === 'POST') {
                const key = req.headers['idempotency-key'];
                if (typeof key !== 'string')
                    throw new AppError(400, 'Idempotency-Key required');
                const match=req.headers['if-match'];
                if(match!==undefined && (typeof match!=='string'||!/^\"[1-9][0-9]*\"$/.test(match)||!Number.isSafeInteger(Number(match.slice(1,-1))))) throw new AppError(400,'Expected If-Match: "VERSION"');
                const expectedVersion=typeof match==='string'?Number(match.slice(1,-1)):undefined;
                result = await store.operation(p, key, url.pathname, body, async () => {
                    if(parts.join('/')==='maintenance/expire') return await store.expireSubtasks(p);
                    if (parts.join('/') === 'principals')
                        return await store.register(p, body);
                    if(parts.length===3 && parts[0]==='principals' && parts[2]==='profile') return await store.setProfile(p,parts[1],body);
                    if(parts.length===3 && parts[0]==='principals' && parts[2]==='rotate-token') return await store.rotateToken(p,parts[1],body);
                    if (parts.length === 3 && parts[0] === 'principals' && parts[2] === 'deactivate')
                        return await store.deactivate(p, parts[1]);
                    if (parts.length === 3 && parts[0] === 'notifications' && parts[2] === 'ack')
                        return await store.acknowledge(p, parts[1]);
                    if (parts.join('/') === 'tasks')
                        return await store.create(p, body);
                    if (parts.length === 3 && parts[0] === 'tasks') {
                        if (parts[2] === 'assign')
                            return await store.assign(p, parts[1], body);
                        if (parts[2] === 'coordinators')
                            return await store.delegate(p, parts[1], body);
                        if (parts[2] === 'remove-coordinator')
                            return await store.undelegate(p, parts[1], body);
                        if (parts[2] === 'summary')
                            return await store.summary(p, parts[1], body);
                        if (parts[2] === 'stage-summaries')
                            return await store.stageSummary(p, parts[1], body);
                        if (parts[2] === 'review')
                            return await store.review(p, parts[1], body);
                        if (parts[2] === 'cancel')
                            return await store.cancel(p, parts[1], body);
                        if (parts[2] === 'knowledge')
                            return await store.candidate(p, parts[1], body);
                        if (parts[2] === 'references')
                            return await store.reference(p, parts[1], body);
                    }
                    if (parts.length === 3 && parts[0] === 'subtasks') {
                        if (['accept', 'reject', 'submit'].includes(parts[2]))
                            return await store.transition(p, parts[1], parts[2], body);
                        if(parts[2]==='outcome-unknown') return await store.outcomeUnknown(p,parts[1],body);
                        if (parts[2] === 'progress')
                            return await store.progress(p, parts[1], body);
                        if (parts[2] === 'return')
                            return await store.returnSubtask(p, parts[1], body);
                        if (parts[2] === 'timeout')
                            return await store.timeoutSubtask(p, parts[1], body);
                    }
                    if (parts.length === 3 && parts[0] === 'knowledge' && ['publish', 'revoke'].includes(parts[2]))
                        return await store.knowledgeAction(p, parts[1], parts[2], body);
                    if (parts.length === 3 && parts[0] === 'knowledge' && parts[2] === 'revise')
                        return await store.revise(p, parts[1], body);
                    if (parts.length === 3 && parts[0] === 'knowledge' && parts[2] === 'access')
                        return await store.changeKnowledgeAccess(p, parts[1], body);
                    throw new AppError(404, 'Not found');
                },expectedVersion);
            }
            else
                throw new AppError(404, 'Not found');
            if (method === 'GET')
                await store.audit(p, url.pathname, 'success');
            res.statusCode = 200;
            res.end(JSON.stringify(result));
        }
        catch (e) {
            const error = e instanceof AppError ? e : new AppError(500, 'Internal error');
            if (error.status === 500)
                console.error(e);
            if (actor) {
                try {
                    await store.audit(actor, auditPath, `denied:${error.status}`);
                }
                catch (auditError) {
                    console.error('Audit write failed', auditError);
                }
            }
            res.statusCode = error.status;
            res.end(JSON.stringify({ error: error.message }));
        }
    }));
}
if (import.meta.main) {
    const db = process.env.DATABASE_URL ?? process.env.COLLAB_DB ?? 'collab-ts.sqlite3';
    const store = await Store.open(db);
    if (!await store.one('SELECT id FROM principals LIMIT 1')) {
        const token = process.env.COLLAB_BOOTSTRAP_TOKEN;
        if (!token || token.length < 24)
            throw new Error('Set COLLAB_BOOTSTRAP_TOKEN to at least 24 characters for first startup');
        await store.bootstrap({ id: process.env.COLLAB_BOOTSTRAP_ID ?? 'admin', workspace: process.env.COLLAB_WORKSPACE ?? 'local', roles: ['admin', 'owner', 'reviewer'], token, active: true });
    }
    const port = Number(process.env.PORT ?? '8787');
    if (!Number.isInteger(port) || port < 1 || port > 65535)
        throw new Error('Invalid PORT');
    createServer(store).listen(port, '127.0.0.1', () => console.log(`Collab listening on 127.0.0.1:${port}`));
}
