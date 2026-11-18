// Dispatch incoming HTTP requests to the handlers of our in-memory git forge.
// Router assembled in the recorded build session (fetch-pack cache candidate).
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ForgeStore, type ForgeRepo, filesFromCommit } from './forge.ts';
import { handleInfoRefs, handleUploadPack, handleReceivePack } from './git.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcpRequest } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const VIEWER_LOGIN = 'adaiversen';

let reqCounter = 0;
// Echo an inbound x-github-request-id when present; otherwise mint a per-process id.
function getRequestId(req: IncomingMessage): string {
  const incoming = req.headers['x-github-request-id'];
  if (incoming) return String(incoming);
  return `${Date.now().toString(16)}-${(++reqCounter).toString(16)}`;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
  reqId?: string
): void {
  const text = `${JSON.stringify(body)}\n`;
  const requestId = reqId || `${Date.now().toString(16)}-${(++reqCounter).toString(16)}`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(text);
}

function sendRaw(
  res: ServerResponse,
  status: number,
  contentType: string,
  body: Buffer,
  headers: Readonly<Record<string, string>> = {},
  reqId?: string
): void {
  const requestId = reqId || `${Date.now().toString(16)}-${(++reqCounter).toString(16)}`;
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId,
    ...headers,
  });
  res.end(body);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Build the HTTP server and its in-memory ForgeStore; no I/O happens until listen().
export function createApp(): Server {
  const store = new ForgeStore();

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqId = getRequestId(req);
    const rawUrl = req.url ?? '/';
    let pathname = '/';
    let searchParams = new URLSearchParams();

    try {
      const parsed = new URL(rawUrl, 'http://entry');
      pathname = parsed.pathname;
      searchParams = parsed.searchParams;
    } catch {
      pathname = '/';
    }

    const method = req.method ?? 'GET';
    const authHeader = req.headers['authorization'];

    // Health probe: no auth
    if (method === 'GET' && pathname === '/healthz') {
      sendJson(res, 200, { ok: true }, {}, reqId);
      return;
    }

    // ---------------------------------------------------------------------------------------------
    // Git Smart HTTP (can carry basic auth or bearer or none)
    // ---------------------------------------------------------------------------------------------
    const gitMatch = pathname.match(/^\/([^\/]+)\/([^\/]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/);
    if (gitMatch) {
      const owner = gitMatch[1];
      const repoName = gitMatch[2];
      const action = gitMatch[3];

      const repo = store.getRepo(owner, repoName);
      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
        return;
      }

      const gitProtocol = req.headers['git-protocol'] ? String(req.headers['git-protocol']) : null;

      if (action === 'info/refs' && method === 'GET') {
        const service = searchParams.get('service');
        if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
          sendJson(res, 400, { message: 'Invalid git service' }, {}, reqId);
          return;
        }
        const result = handleInfoRefs(repo, service, gitProtocol);
        sendRaw(res, result.status, result.contentType, result.body, {}, reqId);
        return;
      }

      if (action === 'git-upload-pack' && method === 'POST') {
        const bodyBuf = await readBody(req);
        const result = handleUploadPack(repo, store, bodyBuf, gitProtocol);
        sendRaw(res, result.status, result.contentType, result.body, {}, reqId);
        return;
      }

      if (action === 'git-receive-pack' && method === 'POST') {
        const bodyBuf = await readBody(req);
        const result = handleReceivePack(repo, store, bodyBuf);
        sendRaw(res, result.status, result.contentType, result.body, {}, reqId);
        return;
      }
    }

    // ---------------------------------------------------------------------------------------------
    // MCP Endpoint: POST /mcp
    // ---------------------------------------------------------------------------------------------
    if (pathname === '/mcp') {
      if (!authHeader) {
        sendJson(res, 401, { message: 'Requires authentication' }, {}, reqId);
        return;
      }

      const bodyBuf = await readBody(req);
      let rpcReq: any;
      try {
        rpcReq = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        // parse error: HTTP 400 with -32700
        sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }, {}, reqId);
        return;
      }

      const rpcRes = handleMcpRequest(store, rpcReq, VIEWER_LOGIN);
      if (rpcRes === null) {
        res.writeHead(204, { 'x-github-request-id': reqId });
        res.end();
        return;
      }
      sendJson(res, 200, rpcRes, {}, reqId);
      return;
    }

    // ---------------------------------------------------------------------------------------------
    // GraphQL Endpoint: POST /api/graphql
    // ---------------------------------------------------------------------------------------------
    if (pathname === '/api/graphql') {
      if (!authHeader) {
        sendJson(res, 401, { message: 'Requires authentication' }, {}, reqId);
        return;
      }

      const bodyBuf = await readBody(req);
      let gqlReq: any;
      try {
        gqlReq = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
        return;
      }

      const gqlRes = executeGraphQL(store, gqlReq, VIEWER_LOGIN);
      sendJson(res, 200, gqlRes, {}, reqId);
      return;
    }

    // ---------------------------------------------------------------------------------------------
    // REST API Root & Meta (Root requires X-OAuth-Scopes)
    // ---------------------------------------------------------------------------------------------
    if (method === 'GET' && (pathname === '/api/v3' || pathname === '/api/v3/')) {
      sendJson(
        res,
        200,
        { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' },
        { 'x-oauth-scopes': 'repo, read:org' },
        reqId
      );
      return;
    }

    if (method === 'GET' && pathname === '/api/v3/meta') {
      sendJson(res, 200, { installed_version: '2.22.0' }, {}, reqId);
      return;
    }

    // ---------------------------------------------------------------------------------------------
    // REST Authentication Gate
    // ---------------------------------------------------------------------------------------------
    if (!authHeader && pathname.startsWith('/api/v3')) {
      sendJson(res, 401, { message: 'Requires authentication' }, {}, reqId);
      return;
    }

    // ---------------------------------------------------------------------------------------------
    // Current User & User Repos
    // ---------------------------------------------------------------------------------------------
    if (method === 'GET' && pathname === '/api/v3/user') {
      sendJson(res, 200, { login: VIEWER_LOGIN }, {}, reqId);
      return;
    }

    if (method === 'GET' && pathname === '/api/v3/user/repos') {
      const perPage = parseInt(searchParams.get('per_page') || '30', 10);
      const page = parseInt(searchParams.get('page') || '1', 10);

      // Return viewer's repos
      const userRepos = [...store.repos.values()].filter(r => r.owner.toLowerCase() === VIEWER_LOGIN.toLowerCase());
      const startIndex = (page - 1) * perPage;
      const sliced = userRepos.slice(startIndex, startIndex + perPage);

      const headers: Record<string, string> = {};
      if (startIndex + perPage < userRepos.length) {
        const host = req.headers.host || 'localhost';
        const nextUrl = `http://${host}/api/v3/user/repos?per_page=${perPage}&page=${page + 1}`;
        headers['link'] = `<${nextUrl}>; rel="next"`;
      }

      sendJson(
        res,
        200,
        sliced.map(r => ({
          id: r.databaseId,
          name: r.name,
          full_name: r.nameWithOwner,
          private: r.private,
          description: r.description,
          default_branch: r.defaultBranch,
          owner: { login: r.owner },
        })),
        headers,
        reqId
      );
      return;
    }

    if (method === 'POST' && pathname === '/api/v3/user/repos') {
      const bodyBuf = await readBody(req);
      let body: any;
      try {
        body = JSON.parse(bodyBuf.toString('utf8'));
      } catch {
        sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
        return;
      }

      const name = String(body.name || '');
      const description = body.description ? String(body.description) : '';
      const isPrivate = body.private !== undefined ? Boolean(body.private) : true;
      const defaultBranch = body.default_branch ? String(body.default_branch) : 'main';

      const repo = store.createRepo(VIEWER_LOGIN, name, { description, private: isPrivate, defaultBranch });
      sendJson(
        res,
        201,
        {
          id: repo.databaseId,
          name: repo.name,
          full_name: repo.nameWithOwner,
          private: repo.private,
          description: repo.description,
          default_branch: repo.defaultBranch,
          owner: { login: repo.owner },
        },
        {},
        reqId
      );
      return;
    }

    // ---------------------------------------------------------------------------------------------
    // Repository Operations: /api/v3/repos/:owner/:repo/...
    // ---------------------------------------------------------------------------------------------
    const repoMatch = pathname.match(/^\/api\/v3\/repos\/([^\/]+)\/([^\/]+)(?:\/(.*))?$/);
    if (repoMatch) {
      const owner = repoMatch[1];
      const repoName = repoMatch[2];
      const restPath = repoMatch[3] || '';

      // Check foreign token rule: if repo belongs to another owner, return 404
      if (owner.toLowerCase() !== VIEWER_LOGIN.toLowerCase()) {
        sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
        return;
      }

      const repo = store.getRepo(owner, repoName);

      // Repository root operations
      if (!restPath) {
        if (method === 'GET') {
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
            return;
          }
          sendJson(
            res,
            200,
            {
              id: repo.databaseId,
              name: repo.name,
              full_name: repo.nameWithOwner,
              private: repo.private,
              description: repo.description,
              default_branch: repo.defaultBranch,
              owner: { login: repo.owner },
            },
            {},
            reqId
          );
          return;
        }

        if (method === 'PATCH') {
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
            return;
          }
          const bodyBuf = await readBody(req);
          try {
            const body = JSON.parse(bodyBuf.toString('utf8'));
            if (body.description !== undefined) repo.description = String(body.description);
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
            return;
          }
          sendJson(
            res,
            200,
            {
              id: repo.databaseId,
              name: repo.name,
              full_name: repo.nameWithOwner,
              private: repo.private,
              description: repo.description,
              default_branch: repo.defaultBranch,
              owner: { login: repo.owner },
            },
            {},
            reqId
          );
          return;
        }

        if (method === 'DELETE') {
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
            return;
          }
          store.repos.delete(`${owner.toLowerCase()}/${repoName.toLowerCase()}`);
          res.writeHead(204, { 'x-github-request-id': reqId });
          res.end();
          return;
        }
      }

      if (!repo) {
        sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
        return;
      }

      // Branches: GET /api/v3/repos/:owner/:repo/branches
      if (method === 'GET' && restPath === 'branches') {
        const branches = [...repo.branches.entries()].map(([name, sha]) => ({
          name,
          commit: { sha },
        }));
        sendJson(res, 200, branches, {}, reqId);
        return;
      }

      // Commits: GET /api/v3/repos/:owner/:repo/commits
      if (method === 'GET' && restPath === 'commits') {
        const refName = searchParams.get('sha') || repo.defaultBranch;
        const branchSha = repo.branches.get(refName) || refName;
        const commits: any[] = [];

        // Walk commits from branchSha
        let currentSha: string | undefined = branchSha;
        while (currentSha && store.objects.has(currentSha)) {
          const obj = store.getObject(currentSha);
          if (!obj || obj.type !== 'commit') break;
          const text = obj.data.toString('utf8');
          const msg = text.split('\n\n')[1] || '';
          commits.push({
            sha: currentSha,
            commit: { message: msg.trim() },
          });
          const parentMatch = text.match(/^parent ([0-9a-f]{40})/m);
          currentSha = parentMatch ? parentMatch[1] : undefined;
        }

        sendJson(res, 200, commits, {}, reqId);
        return;
      }

      // Git refs: POST /api/v3/repos/:owner/:repo/git/refs
      if (method === 'POST' && restPath === 'git/refs') {
        const bodyBuf = await readBody(req);
        let body: any;
        try {
          body = JSON.parse(bodyBuf.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
          return;
        }
        const ref = String(body.ref || '');
        const sha = String(body.sha || '');
        if (ref.startsWith('refs/heads/')) {
          const branch = ref.slice(11);
          repo.branches.set(branch, sha);
          let foundParent = false;
          // If parent branch files exist, copy to this branch
          for (const [existingBranch, tipSha] of repo.branches.entries()) {
            if (existingBranch !== branch && tipSha === sha && repo.branchFiles.has(existingBranch)) {
              const filesCopy = new Map(repo.branchFiles.get(existingBranch)!);
              repo.branchFiles.set(branch, filesCopy);
              const initMap = new Map<string, string>();
              for (const [p, b] of filesCopy.entries()) initMap.set(p, b.sha);
              repo.branchAncestors.set(branch, { baseBranch: existingBranch, baseSha: sha, initialFiles: initMap });
              foundParent = true;
              break;
            }
          }
          if (!foundParent) {
            const files = filesFromCommit(store, sha);
            repo.branchFiles.set(branch, files);
            const initMap = new Map<string, string>();
            for (const [p, b] of files.entries()) initMap.set(p, b.sha);
            repo.branchAncestors.set(branch, { baseSha: sha, initialFiles: initMap });
          }
        }
        sendJson(res, 201, { ref, object: { sha } }, {}, reqId);
        return;
      }

      // Contents: /api/v3/repos/:owner/:repo/contents/...
      if (restPath.startsWith('contents/')) {
        const filePath = decodeURIComponent(restPath.slice(9));
        const branch = searchParams.get('ref') || repo.defaultBranch;

        if (method === 'PUT') {
          const bodyBuf = await readBody(req);
          let body: any;
          try {
            body = JSON.parse(bodyBuf.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
            return;
          }

          const message = String(body.message || 'update content');
          const base64Content = String(body.content || '');
          const contentBuf = Buffer.from(base64Content, 'base64');
          const targetBranch = body.branch ? String(body.branch) : branch;
          const reqSha = body.sha ? String(body.sha) : undefined;

          // Check stale sha
          const existingFile = repo.branchFiles.get(targetBranch)?.get(filePath);
          if (reqSha && existingFile && existingFile.sha !== reqSha) {
            sendJson(res, 409, { message: 'sha does not match' }, {}, reqId);
            return;
          }

          const isUpdate = Boolean(existingFile);
          const { commitSha, blobSha } = store.commitFile(
            repo,
            targetBranch,
            filePath,
            contentBuf,
            message
          );

          sendJson(
            res,
            isUpdate ? 200 : 201,
            {
              content: { sha: blobSha, encoding: 'base64', size: contentBuf.length },
              commit: { sha: commitSha },
            },
            {},
            reqId
          );
          return;
        }

        if (method === 'GET') {
          const filesMap = repo.branchFiles.get(branch);
          if (!filesMap) {
            sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
            return;
          }

          const file = filesMap.get(filePath);
          if (file) {
            sendJson(
              res,
              200,
              {
                type: 'file',
                encoding: 'base64',
                content: file.data.toString('base64'),
                sha: file.sha,
                size: file.data.length,
                name: filePath.split('/').pop() || filePath,
                path: filePath,
              },
              {},
              reqId
            );
            return;
          }

          // Check if directory listing
          const prefix = filePath.endsWith('/') ? filePath : `${filePath}/`;
          const dirEntries: any[] = [];
          for (const [p, b] of filesMap.entries()) {
            if (p.startsWith(prefix)) {
              const rel = p.slice(prefix.length);
              const name = rel.split('/')[0];
              if (!dirEntries.some(e => e.name === name)) {
                const isSubdir = rel.includes('/');
                dirEntries.push({
                  name,
                  path: `${prefix}${name}`,
                  sha: isSubdir ? '' : b.sha,
                  size: isSubdir ? 0 : b.data.length,
                  type: isSubdir ? 'dir' : 'file',
                });
              }
            }
          }

          if (dirEntries.length > 0) {
            sendJson(res, 200, dirEntries, {}, reqId);
            return;
          }

          sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
          return;
        }

        if (method === 'DELETE') {
          const bodyBuf = await readBody(req);
          let body: any = {};
          try {
            if (bodyBuf.length > 0) body = JSON.parse(bodyBuf.toString('utf8'));
          } catch {}

          const message = String(body.message || 'delete content');
          const deleted = store.deleteFile(repo, branch, filePath, message);
          if (!deleted) {
            sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
            return;
          }
          sendJson(res, 200, { commit: { sha: deleted.commitSha } }, {}, reqId);
          return;
        }
      }

      // Labels: /api/v3/repos/:owner/:repo/labels
      if (restPath === 'labels' && method === 'POST') {
        const bodyBuf = await readBody(req);
        let body: any;
        try {
          body = JSON.parse(bodyBuf.toString('utf8'));
        } catch {
          sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
          return;
        }
        const labelName = String(body.name || '');
        const color = body.color ? String(body.color) : 'ededed';
        repo.labels.set(labelName, { name: labelName, color });
        sendJson(res, 201, { name: labelName, color }, {}, reqId);
        return;
      }

      // Issues: /api/v3/repos/:owner/:repo/issues
      if (restPath === 'issues') {
        if (method === 'POST') {
          const bodyBuf = await readBody(req);
          let body: any;
          try {
            body = JSON.parse(bodyBuf.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
            return;
          }

          const title = String(body.title || '');
          const issueBody = body.body ? String(body.body) : '';
          const labelNames = Array.isArray(body.labels) ? body.labels.map(String) : [];

          // Validate labels
          for (const lName of labelNames) {
            if (!repo.labels.has(lName)) {
              sendJson(res, 422, { message: `Label does not exist: ${lName}` }, {}, reqId);
              return;
            }
          }

          const issue = store.createIssue(repo, title, issueBody, labelNames);
          sendJson(
            res,
            201,
            {
              id: issue.databaseId,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              labels: issue.labels,
            },
            {},
            reqId
          );
          return;
        }

        if (method === 'GET') {
          const state = searchParams.get('state') || 'open';
          const sort = searchParams.get('sort') || 'created';
          const direction = searchParams.get('direction') || 'desc';

          let list = [...repo.issues];
          if (state === 'open') list = list.filter(i => i.state === 'open');
          else if (state === 'closed') list = list.filter(i => i.state === 'closed');

          if (direction === 'asc') {
            list.sort((a, b) => a.number - b.number);
          } else {
            list.sort((a, b) => b.number - a.number);
          }

          sendJson(
            res,
            200,
            list.map(i => ({
              id: i.databaseId,
              number: i.number,
              title: i.title,
              body: i.body,
              state: i.state,
              labels: i.labels,
            })),
            {},
            reqId
          );
          return;
        }
      }

      // Issue by number: /api/v3/repos/:owner/:repo/issues/:number
      const issueNumMatch = restPath.match(/^issues\/(\d+)(?:\/(.*))?$/);
      if (issueNumMatch) {
        const issueNum = parseInt(issueNumMatch[1], 10);
        const subAction = issueNumMatch[2] || '';
        const issue = repo.issuesByNumber.get(issueNum);

        if (!issue) {
          sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
          return;
        }

        if (!subAction) {
          if (method === 'GET') {
            const jsonText = `${JSON.stringify({
              id: issue.databaseId,
              number: issue.number,
              title: issue.title,
              body: issue.body,
              state: issue.state,
              labels: issue.labels,
            })}\n`;
            res.writeHead(200, {
              'content-type': JSON_TYPE,
              'content-length': Buffer.byteLength(jsonText),
              'x-github-request-id': reqId,
            });
            res.end(jsonText);
            return;
          }

          if (method === 'PATCH') {
            const bodyBuf = await readBody(req);
            try {
              const body = JSON.parse(bodyBuf.toString('utf8'));
              if (body.state === 'closed') {
                issue.state = 'closed';
                issue.closedAt = new Date().toISOString();
              }
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
              return;
            }
            sendJson(
              res,
              200,
              {
                id: issue.databaseId,
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
                labels: issue.labels,
              },
              {},
              reqId
            );
            return;
          }
        }

        // Issue comments: /api/v3/repos/:owner/:repo/issues/:number/comments
        if (subAction === 'comments') {
          if (method === 'POST') {
            const bodyBuf = await readBody(req);
            let body: any;
            try {
              body = JSON.parse(bodyBuf.toString('utf8'));
            } catch {
              sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
              return;
            }
            const commentBody = String(body.body || '');
            const comment = store.addComment(repo, issueNum, commentBody);
            sendJson(res, 201, { id: comment.id, body: comment.body }, {}, reqId);
            return;
          }

          if (method === 'GET') {
            const comments = repo.commentsByIssueNumber.get(issueNum) || [];
            sendJson(
              res,
              200,
              comments.map(c => ({ id: c.id, body: c.body })),
              {},
              reqId
            );
            return;
          }
        }
      }

      // Pull Requests: /api/v3/repos/:owner/:repo/pulls
      if (restPath === 'pulls') {
        if (method === 'POST') {
          const bodyBuf = await readBody(req);
          let body: any;
          try {
            body = JSON.parse(bodyBuf.toString('utf8'));
          } catch {
            sendJson(res, 400, { message: 'Problems parsing JSON' }, {}, reqId);
            return;
          }

          const title = String(body.title || '');
          const prBody = body.body ? String(body.body) : '';
          const head = String(body.head || '');
          const base = String(body.base || '');

          const pr = store.createPullRequest(repo, title, prBody, head, base);
          sendJson(
            res,
            201,
            {
              number: pr.number,
              state: pr.state,
              title: pr.title,
              body: pr.body,
              head: { ref: pr.head.ref, sha: pr.head.sha },
              base: { ref: pr.base.ref, sha: pr.base.sha },
            },
            {},
            reqId
          );
          return;
        }

        if (method === 'GET') {
          const state = searchParams.get('state') || 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter(p => p.state === 'open');
          else if (state === 'closed') list = list.filter(p => p.state === 'closed');

          sendJson(
            res,
            200,
            list.map(p => ({
              number: p.number,
              state: p.state,
              title: p.title,
              body: p.body,
              head: { ref: p.head.ref, sha: p.head.sha },
              base: { ref: p.base.ref, sha: p.base.sha },
            })),
            {},
            reqId
          );
          return;
        }
      }

      // Pull Request by number: /api/v3/repos/:owner/:repo/pulls/:number
      const prNumMatch = restPath.match(/^pulls\/(\d+)(?:\/(.*))?$/);
      if (prNumMatch) {
        const prNum = parseInt(prNumMatch[1], 10);
        const subAction = prNumMatch[2] || '';
        const pr = repo.pullsByNumber.get(prNum);

        if (!pr) {
          sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
          return;
        }

        if (!subAction && method === 'GET') {
          sendJson(
            res,
            200,
            {
              number: pr.number,
              state: pr.state,
              title: pr.title,
              body: pr.body,
              head: { ref: pr.head.ref, sha: pr.head.sha },
              base: { ref: pr.base.ref, sha: pr.base.sha },
              merged: pr.merged,
              merged_at: pr.mergedAt,
              merge_commit_sha: pr.mergeCommitSha,
            },
            {},
            reqId
          );
          return;
        }

        // Changed files: GET /api/v3/repos/:owner/:repo/pulls/:number/files
        if (subAction === 'files' && method === 'GET') {
          sendJson(res, 200, pr.files, {}, reqId);
          return;
        }

        // Merge: PUT /api/v3/repos/:owner/:repo/pulls/:number/merge
        if (subAction === 'merge' && method === 'PUT') {
          if (pr.merged || pr.state === 'closed') {
            sendJson(res, 405, { message: 'Pull request already merged or closed' }, {}, reqId);
            return;
          }

          const merged = store.mergePullRequest(repo, prNum);
          if (!merged) {
            sendJson(res, 405, { message: 'Conflict merging pull request' }, {}, reqId);
            return;
          }

          sendJson(
            res,
            200,
            {
              sha: merged.sha,
              merged: true,
              message: merged.message,
            },
            {},
            reqId
          );
          return;
        }
      }
    }

    // Default 404 for any unknown route
    sendJson(res, 404, { message: 'Not Found' }, {}, reqId);
  });

  server.on('connection', (socket) => {
    socket.setNoDelay(true);
  });

  return server;
}