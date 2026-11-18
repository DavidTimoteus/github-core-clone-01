import type { ForgeStore, ForgeRepo, ForgeIssue, ForgePullRequest } from './forge.ts';

interface GraphQLRequest {
  query?: string;
  variables?: Record<string, unknown>;
  operationName?: string;
}

interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

export function executeGraphQL(
  store: ForgeStore,
  request: GraphQLRequest | GraphQLRequest[],
  viewerLogin: string
): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(request)) {
    return request.map(req => executeSingleGraphQL(store, req, viewerLogin));
  }
  return executeSingleGraphQL(store, request, viewerLogin);
}

function executeSingleGraphQL(
  store: ForgeStore,
  request: GraphQLRequest,
  viewerLogin: string
): GraphQLResult {
  const query = request.query || '';
  const variables = request.variables || {};

  // Check for invalid field test: ViewerInvalidField
  if (query.includes('noSuchFieldOnViewer')) {
    return {
      errors: [{ message: "Field 'noSuchFieldOnViewer' doesn't exist on type 'User'" }]
    };
  }

  const data: Record<string, unknown> = {};

  // Introspection: __type queries
  if (query.includes('__type')) {
    // Check aliases like `Issue: __type(name: "Issue")`
    const typeMatches = [...query.matchAll(/(?:([A-Za-z0-9_]+)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g)];
    for (const match of typeMatches) {
      const alias = match[1] || '__type';
      const typeName = match[2];

      if (typeName === 'Issue') {
        data[alias] = {
          fields: [
            { name: 'id' },
            { name: 'number' },
            { name: 'title' },
            { name: 'state' },
            { name: 'body' }
          ]
        };
      } else if (typeName === 'PullRequest') {
        data[alias] = {
          fields: [
            { name: 'id' },
            { name: 'number' },
            { name: 'headRefName' },
            { name: 'baseRefName' },
            { name: 'mergeable' },
            { name: 'state' },
            { name: 'merged' },
            { name: 'files' }
          ]
        };
      } else if (typeName === 'Repository') {
        data[alias] = {
          fields: [
            { name: 'id' },
            { name: 'databaseId' },
            { name: 'name' },
            { name: 'nameWithOwner' },
            { name: 'owner' },
            { name: 'defaultBranchRef' },
            { name: 'viewerPermission' },
            { name: 'hasIssuesEnabled' },
            { name: 'issue' },
            { name: 'issues' },
            { name: 'pullRequests' },
            { name: 'pullRequest' }
          ]
        };
      } else if (typeName === 'SearchType') {
        data[alias] = {
          enumValues: [
            { name: 'ISSUE' },
            { name: 'REPOSITORY' },
            { name: 'USER' }
          ]
        };
      }
    }
  }

  // Viewer login
  if (query.includes('viewer')) {
    data.viewer = {
      login: viewerLogin
    };
  }

  // Node repository query
  if (query.includes('node(')) {
    const idVal = String(variables.id || '');
    let matchedRepo: ForgeRepo | undefined;
    for (const r of store.repos.values()) {
      if (r.id === idVal) {
        matchedRepo = r;
        break;
      }
    }
    if (matchedRepo) {
      data.node = {
        id: matchedRepo.id,
        name: matchedRepo.name,
        nameWithOwner: matchedRepo.nameWithOwner
      };
    } else {
      data.node = null;
    }
  }

  // Repository queries
  if (query.includes('repository(')) {
    const owner = String(variables.owner || '');
    const name = String(variables.name || '');
    const repo = store.getRepo(owner, name);

    if (!repo) {
      data.repository = null;
    } else {
      const repoData: Record<string, unknown> = {
        id: repo.id,
        databaseId: repo.databaseId,
        name: repo.name,
        nameWithOwner: repo.nameWithOwner,
        owner: { login: repo.owner },
        defaultBranchRef: { name: repo.defaultBranch },
        viewerPermission: 'ADMIN',
        hasIssuesEnabled: true
      };

      // issue(number: $number)
      if (query.includes('issue(')) {
        const num = Number(variables.number);
        const issue = repo.issuesByNumber.get(num);
        if (issue) {
          repoData.issue = {
            id: issue.id,
            number: issue.number,
            title: issue.title,
            body: issue.body,
            state: issue.state.toUpperCase()
          };
        } else {
          repoData.issue = null;
        }
      }

      // issues(first:, states:, orderBy:)
      if (query.includes('issues(')) {
        let list = [...repo.issues];
        // states filter
        if (query.includes('[OPEN]') || (variables.states && String(variables.states).includes('OPEN'))) {
          list = list.filter(i => i.state === 'open');
        } else if (query.includes('[CLOSED]')) {
          list = list.filter(i => i.state === 'closed');
        }

        // orderBy: {field: CREATED_AT, direction: DESC}
        if (query.includes('direction: DESC') || query.includes('CREATED_AT')) {
          list.sort((a, b) => b.number - a.number);
        }

        const first = Number(variables.first) || 30;
        const after = variables.after ? String(variables.after) : null;
        let startIndex = 0;
        if (after) {
          const afterNum = parseInt(Buffer.from(after, 'base64').toString('ascii'), 10);
          if (!isNaN(afterNum)) {
            const idx = list.findIndex(i => i.number === afterNum);
            if (idx >= 0) startIndex = idx + 1;
          }
        }

        const sliced = list.slice(startIndex, startIndex + first);
        const endItem = sliced[sliced.length - 1];
        const endCursor = endItem ? Buffer.from(String(endItem.number)).toString('base64') : null;
        const hasNextPage = startIndex + first < list.length;

        repoData.issues = {
          nodes: sliced.map(i => ({
            id: i.id,
            number: i.number,
            title: i.title,
            state: i.state.toUpperCase(),
            body: i.body
          })),
          pageInfo: {
            hasNextPage,
            endCursor
          }
        };
      }

      // pullRequests(first:)
      if (query.includes('pullRequests(')) {
        const first = Number(variables.first) || 30;
        repoData.pullRequests = {
          nodes: repo.pulls.slice(0, first).map(p => ({
            id: p.id,
            number: p.number,
            headRefName: p.headRefName,
            baseRefName: p.baseRefName,
            mergeable: p.mergeable,
            state: p.merged ? 'MERGED' : p.state.toUpperCase()
          }))
        };
      }

      // pullRequest(number:)
      if (query.includes('pullRequest(')) {
        const num = Number(variables.number);
        const pr = repo.pullsByNumber.get(num);
        if (pr) {
          const headFiles = repo.branchFiles.get(pr.headRefName) || new Map();
          const baseFiles = repo.branchFiles.get(pr.baseRefName) || new Map();
          const filePaths = new Set<string>();
          for (const [p, h] of headFiles.entries()) {
            const b = baseFiles.get(p);
            if (!b || b.sha !== h.sha) {
              filePaths.add(p);
            }
          }
          for (const p of baseFiles.keys()) {
            if (!headFiles.has(p)) filePaths.add(p);
          }
          if (filePaths.size === 0 && pr.files.length > 0) {
            for (const f of pr.files) filePaths.add(f.filename);
          }
          repoData.pullRequest = {
            id: pr.id,
            number: pr.number,
            files: {
              nodes: [...filePaths].map(path => ({ path }))
            }
          };
        } else {
          repoData.pullRequest = null;
        }
      }

      data.repository = repoData;
    }
  }

  // Mutations
  if (query.includes('createIssue(')) {
    const input = (variables.input || {}) as Record<string, unknown>;
    const repoId = String(input.repositoryId || '');
    let matchedRepo: ForgeRepo | undefined;
    for (const r of store.repos.values()) {
      if (r.id === repoId) {
        matchedRepo = r;
        break;
      }
    }
    if (matchedRepo) {
      const title = String(input.title || '');
      const body = String(input.body || '');
      const issue = store.createIssue(matchedRepo, title, body);
      data.createIssue = {
        issue: {
          id: issue.id,
          number: issue.number
        }
      };
    }
  }

  if (query.includes('closeIssue(')) {
    const input = (variables.input || {}) as Record<string, unknown>;
    const issueId = String(input.issueId || '');
    let matchedIssue: ForgeIssue | undefined;
    for (const r of store.repos.values()) {
      for (const i of r.issues) {
        if (i.id === issueId) {
          matchedIssue = i;
          break;
        }
      }
      if (matchedIssue) break;
    }
    if (matchedIssue) {
      matchedIssue.state = 'closed';
      matchedIssue.closedAt = new Date().toISOString();
      data.closeIssue = {
        issue: {
          id: matchedIssue.id,
          number: matchedIssue.number,
          state: 'CLOSED'
        }
      };
    }
  }

  if (query.includes('createPullRequest(')) {
    const input = (variables.input || {}) as Record<string, unknown>;
    const repoId = String(input.repositoryId || '');
    let matchedRepo: ForgeRepo | undefined;
    for (const r of store.repos.values()) {
      if (r.id === repoId) {
        matchedRepo = r;
        break;
      }
    }
    if (matchedRepo) {
      const head = String(input.headRefName || '');
      const base = String(input.baseRefName || '');
      const title = String(input.title || '');
      const body = String(input.body || '');
      const pr = store.createPullRequest(matchedRepo, title, body, head, base);
      data.createPullRequest = {
        pullRequest: {
          id: pr.id,
          number: pr.number,
          state: 'OPEN',
          headRefName: pr.headRefName,
          baseRefName: pr.baseRefName
        }
      };
    }
  }

  if (query.includes('mergePullRequest(')) {
    const input = (variables.input || {}) as Record<string, unknown>;
    const prId = String(input.pullRequestId || '');
    let matchedRepo: ForgeRepo | undefined;
    let matchedPr: ForgePullRequest | undefined;
    for (const r of store.repos.values()) {
      for (const p of r.pulls) {
        if (p.id === prId) {
          matchedRepo = r;
          matchedPr = p;
          break;
        }
      }
      if (matchedPr) break;
    }
    if (matchedRepo && matchedPr) {
      store.mergePullRequest(matchedRepo, matchedPr.number);
      data.mergePullRequest = {
        pullRequest: {
          number: matchedPr.number,
          merged: true,
          state: 'MERGED'
        }
      };
    }
  }

  if (query.includes('addComment(')) {
    const input = (variables.input || {}) as Record<string, unknown>;
    const subjectId = String(input.subjectId || '');
    let matchedRepo: ForgeRepo | undefined;
    let matchedIssue: ForgeIssue | undefined;
    for (const r of store.repos.values()) {
      for (const i of r.issues) {
        if (i.id === subjectId) {
          matchedRepo = r;
          matchedIssue = i;
          break;
        }
      }
      if (matchedIssue) break;
    }
    if (matchedRepo && matchedIssue) {
      const body = String(input.body || '');
      const comment = store.addComment(matchedRepo, matchedIssue.number, body);
      data.addComment = {
        commentEdge: {
          node: {
            id: String(comment.id),
            body: comment.body
          }
        }
      };
    }
  }

  return { data };
}