import type { ForgeStore, ForgeRepo } from './forge.ts';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

const TOOLS = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get details of an existing repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Issue title' },
        body: { type: 'string', description: 'Issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        state: { type: 'string', description: 'Issue state (open, closed, all)' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        title: { type: 'string', description: 'Pull request title' },
        head: { type: 'string', description: 'Head branch name' },
        base: { type: 'string', description: 'Base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner login' },
        repo: { type: 'string', description: 'Repository name' },
        pull_number: { type: 'number', description: 'Pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export function handleMcpRequest(
  store: ForgeStore,
  request: JsonRpcRequest,
  viewerLogin: string
): JsonRpcResponse | null {
  const id = request.id !== undefined ? request.id : null;
  const method = request.method;

  if (method === 'notifications/initialized') {
    return null; // No response for notifications
  }

  if (method === 'server/discover') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        serverInfo: {
          name: 'github-core-clone-mcp',
          version: '1.0.0',
        },
        supportedVersions: ['2026-07-28', '2025-11-25'],
        capabilities: {
          tools: {},
        },
      },
    };
  }

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-11-25',
        serverInfo: {
          name: 'github-core-clone-mcp',
          version: '1.0.0',
        },
        capabilities: {
          tools: {},
        },
      },
    };
  }

  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        tools: TOOLS,
      },
    };
  }

  if (method === 'tools/call') {
    const params = (request.params || {}) as Record<string, unknown>;
    const toolName = String(params.name || '');
    const args = (params.arguments || {}) as Record<string, unknown>;

    // Normalize tool name suffix
    const tool = TOOLS.find(t => t.name === toolName || toolName.endsWith(`_${t.name}`) || toolName.endsWith(`__${t.name}`));
    if (!tool) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32601,
          message: `Unknown tool: ${toolName}`,
        },
      };
    }

    // Check required arguments
    for (const reqField of tool.inputSchema.required) {
      if (args[reqField] === undefined || args[reqField] === null) {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            isError: true,
            content: [{ type: 'text', text: `Missing required argument: ${reqField}` }],
          },
        };
      }
    }

    try {
      if (tool.name === 'create_repo') {
        const name = String(args.name);
        const description = args.description ? String(args.description) : '';
        const isPrivate = args.private !== undefined ? Boolean(args.private) : true;
        const repo = store.createRepo(viewerLogin, name, { description, private: isPrivate });
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: repo.databaseId,
                name: repo.name,
                full_name: repo.nameWithOwner,
                private: repo.private,
                description: repo.description,
                default_branch: repo.defaultBranch,
              }),
            }],
          },
        };
      }

      if (tool.name === 'get_repo') {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Repository not found' }],
            },
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: repo.databaseId,
                name: repo.name,
                full_name: repo.nameWithOwner,
                private: repo.private,
                description: repo.description,
                default_branch: repo.defaultBranch,
              }),
            }],
          },
        };
      }

      if (tool.name === 'create_issue') {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const title = String(args.title);
        const body = args.body ? String(args.body) : '';
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Repository not found' }],
            },
          };
        }
        const issue = store.createIssue(repo, title, body);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: issue.databaseId,
                number: issue.number,
                title: issue.title,
                body: issue.body,
                state: issue.state,
              }),
            }],
          },
        };
      }

      if (tool.name === 'list_issues') {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Repository not found' }],
            },
          };
        }
        let issues = [...repo.issues];
        if (args.state === 'open') issues = issues.filter(i => i.state === 'open');
        else if (args.state === 'closed') issues = issues.filter(i => i.state === 'closed');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify(issues.map(i => ({
                id: i.databaseId,
                number: i.number,
                title: i.title,
                body: i.body,
                state: i.state,
              }))),
            }],
          },
        };
      }

      if (tool.name === 'create_pull_request') {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const title = String(args.title);
        const head = String(args.head);
        const base = String(args.base);
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Repository not found' }],
            },
          };
        }
        const pr = store.createPullRequest(repo, title, '', head, base);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                id: pr.databaseId,
                number: pr.number,
                title: pr.title,
                head: { ref: pr.head.ref, sha: pr.head.sha },
                base: { ref: pr.base.ref, sha: pr.base.sha },
                state: pr.state,
              }),
            }],
          },
        };
      }

      if (tool.name === 'merge_pull_request') {
        const owner = String(args.owner);
        const repoName = String(args.repo);
        const pullNumber = Number(args.pull_number);
        const repo = store.getRepo(owner, repoName);
        if (!repo) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Repository not found' }],
            },
          };
        }
        const merged = store.mergePullRequest(repo, pullNumber);
        if (!merged) {
          return {
            jsonrpc: '2.0',
            id,
            result: {
              isError: true,
              content: [{ type: 'text', text: 'Pull request not found or cannot be merged' }],
            },
          };
        }
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{
              type: 'text',
              text: JSON.stringify({
                sha: merged.sha,
                merged: true,
                message: merged.message,
              }),
            }],
          },
        };
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        result: {
          isError: true,
          content: [{ type: 'text', text: (err as Error).message }],
        },
      };
    }
  }

  return {
    jsonrpc: '2.0',
    id,
    error: {
      code: -32601,
      message: `Method not implemented: ${method}`,
    },
  };
}
