import { createHash } from 'node:crypto';

export interface ForgeBlob {
  sha: string;
  data: Buffer;
}

export interface ForgeCommit {
  sha: string;
  treeSha: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
  timestamp: number;
}

export interface ForgeTreeEntry {
  mode: string;
  name: string;
  sha: string;
}

export interface ForgeLabel {
  name: string;
  color: string;
}

export interface ForgeIssueComment {
  id: number;
  body: string;
  createdAt: string;
}

export interface ForgeIssue {
  id: string; // GraphQL Node ID
  databaseId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: ForgeLabel[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface ForgePullRequest {
  id: string; // GraphQL Node ID
  databaseId: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  head: {
    ref: string;
    sha: string;
  };
  base: {
    ref: string;
    sha: string;
  };
  headRefName: string;
  baseRefName: string;
  createdAt: string;
  updatedAt: string;
  files: Array<{
    filename: string;
    status: 'added' | 'modified' | 'removed';
    additions: number;
    deletions: number;
    changes: number;
  }>;
}

export interface ForgeRepo {
  id: string; // GraphQL Node ID
  databaseId: number;
  owner: string;
  name: string;
  nameWithOwner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  branches: Map<string, string>; // branchName -> commitSha
  tags: Map<string, string>;     // tagName -> commitSha or tagSha
  // In-memory file snapshots per branch: branchName -> (filePath -> ForgeBlob)
  branchFiles: Map<string, Map<string, ForgeBlob>>;
  branchAncestors: Map<string, { baseBranch?: string; baseSha?: string; initialFiles: Map<string, string> }>;
  labels: Map<string, ForgeLabel>;
  issues: ForgeIssue[];
  issuesByNumber: Map<number, ForgeIssue>;
  commentsByIssueNumber: Map<number, ForgeIssueComment[]>;
  pulls: ForgePullRequest[];
  pullsByNumber: Map<number, ForgePullRequest>;
}

export function hashGitObject(type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(Buffer.concat([header, data])).digest('hex');
}

export class ForgeStore {
  readonly repos = new Map<string, ForgeRepo>(); // "owner/name" -> ForgeRepo
  // Global Git Object Database: sha1 -> { type, data }
  readonly objects = new Map<string, { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer }>();
  
  private nextRepoDbId = 1;
  private nextIssueDbId = 1;
  private nextCommentId = 1;
  private nextPullDbId = 1;

  getRepo(owner: string, name: string): ForgeRepo | undefined {
    return this.repos.get(`${owner.toLowerCase()}/${name.toLowerCase()}`);
  }

  createRepo(owner: string, name: string, options: { private?: boolean; description?: string; defaultBranch?: string } = {}): ForgeRepo {
    const key = `${owner.toLowerCase()}/${name.toLowerCase()}`;
    const existing = this.repos.get(key);
    if (existing) return existing;

    const dbId = this.nextRepoDbId++;
    const now = new Date().toISOString();
    const defaultBranch = options.defaultBranch || 'main';
    const repo: ForgeRepo = {
      id: Buffer.from(`01:Repository:${dbId}`).toString('base64'),
      databaseId: dbId,
      owner,
      name,
      nameWithOwner: `${owner}/${name}`,
      private: options.private ?? true,
      description: options.description ?? '',
      defaultBranch,
      createdAt: now,
      updatedAt: now,
      branches: new Map(),
      tags: new Map(),
      branchFiles: new Map(),
      branchAncestors: new Map(),
      labels: new Map(),
      issues: [],
      issuesByNumber: new Map(),
      commentsByIssueNumber: new Map(),
      pulls: [],
      pullsByNumber: new Map(),
    };

    this.repos.set(key, repo);
    return repo;
  }

  putObject(type: 'commit' | 'tree' | 'blob' | 'tag', data: Buffer): string {
    const sha = hashGitObject(type, data);
    if (!this.objects.has(sha)) {
      this.objects.set(sha, { type, data });
    }
    return sha;
  }

  getObject(sha: string): { type: 'commit' | 'tree' | 'blob' | 'tag'; data: Buffer } | undefined {
    return this.objects.get(sha.toLowerCase());
  }

  // Create or update a file on a branch, producing commit and blob objects
  commitFile(
    repo: ForgeRepo,
    branchName: string,
    filePath: string,
    contentBuffer: Buffer,
    message: string,
    author: string = 'Forge User <forge@make.fun>'
  ): { commitSha: string; blobSha: string } {
    const blobSha = this.putObject('blob', contentBuffer);
    
    // Ensure branch files map exists
    let filesMap = repo.branchFiles.get(branchName);
    if (!filesMap) {
      filesMap = new Map();
      repo.branchFiles.set(branchName, filesMap);
    }
    filesMap.set(filePath, { sha: blobSha, data: contentBuffer });

    // Build tree
    const treeEntries: string[] = [];
    for (const [p, blob] of filesMap.entries()) {
      // mode 100644
      treeEntries.push(`100644 ${p}\0${Buffer.from(blob.sha, 'hex').toString('binary')}`);
    }
    const treeData = Buffer.from(treeEntries.join(''), 'binary');
    const treeSha = this.putObject('tree', treeData);

    // Build commit
    const parentSha = repo.branches.get(branchName);
    const parents = parentSha ? [parentSha] : [];
    const timestamp = Math.floor(Date.now() / 1000);
    const commitLines = [
      `tree ${treeSha}`,
      ...parents.map(p => `parent ${p}`),
      `author ${author} ${timestamp} +0000`,
      `committer ${author} ${timestamp} +0000`,
      '',
      message.endsWith('\n') ? message : `${message}\n`
    ];
    const commitData = Buffer.from(commitLines.join('\n'), 'utf8');
    const commitSha = this.putObject('commit', commitData);

    // Update branch tip
    repo.branches.set(branchName, commitSha);
    repo.updatedAt = new Date().toISOString();

    return { commitSha, blobSha };
  }

  deleteFile(
    repo: ForgeRepo,
    branchName: string,
    filePath: string,
    message: string,
    author: string = 'Forge User <forge@make.fun>'
  ): { commitSha: string } | null {
    const filesMap = repo.branchFiles.get(branchName);
    if (!filesMap || !filesMap.has(filePath)) return null;

    filesMap.delete(filePath);

    // Build tree
    const treeEntries: string[] = [];
    for (const [p, blob] of filesMap.entries()) {
      treeEntries.push(`100644 ${p}\0${Buffer.from(blob.sha, 'hex').toString('binary')}`);
    }
    const treeData = Buffer.from(treeEntries.join(''), 'binary');
    const treeSha = this.putObject('tree', treeData);

    // Build commit
    const parentSha = repo.branches.get(branchName);
    const parents = parentSha ? [parentSha] : [];
    const timestamp = Math.floor(Date.now() / 1000);
    const commitLines = [
      `tree ${treeSha}`,
      ...parents.map(p => `parent ${p}`),
      `author ${author} ${timestamp} +0000`,
      `committer ${author} ${timestamp} +0000`,
      '',
      message.endsWith('\n') ? message : `${message}\n`
    ];
    const commitData = Buffer.from(commitLines.join('\n'), 'utf8');
    const commitSha = this.putObject('commit', commitData);

    repo.branches.set(branchName, commitSha);
    repo.updatedAt = new Date().toISOString();

    return { commitSha };
  }

  createIssue(repo: ForgeRepo, title: string, body: string, labelNames: string[] = []): ForgeIssue {
    const number = repo.issues.length + 1;
    const dbId = this.nextIssueDbId++;
    const now = new Date().toISOString();

    const labels: ForgeLabel[] = [];
    for (const name of labelNames) {
      const label = repo.labels.get(name);
      if (label) labels.push(label);
    }

    const issue: ForgeIssue = {
      id: Buffer.from(`01:Issue:${dbId}`).toString('base64'),
      databaseId: dbId,
      number,
      title,
      body,
      state: 'open',
      labels,
      createdAt: now,
      updatedAt: now,
      closedAt: null,
    };

    repo.issues.push(issue);
    repo.issuesByNumber.set(number, issue);
    return issue;
  }

  addComment(repo: ForgeRepo, issueNumber: number, body: string): ForgeIssueComment {
    const id = this.nextCommentId++;
    const comment: ForgeIssueComment = {
      id,
      body,
      createdAt: new Date().toISOString()
    };
    let comments = repo.commentsByIssueNumber.get(issueNumber);
    if (!comments) {
      comments = [];
      repo.commentsByIssueNumber.set(issueNumber, comments);
    }
    comments.push(comment);
    return comment;
  }

  createPullRequest(
    repo: ForgeRepo,
    title: string,
    body: string,
    headBranch: string,
    baseBranch: string
  ): ForgePullRequest {
    const number = repo.pulls.length + 1;
    const dbId = this.nextPullDbId++;
    const now = new Date().toISOString();

    const headSha = repo.branches.get(headBranch) || '0'.repeat(40);
    const baseSha = repo.branches.get(baseBranch) || '0'.repeat(40);

    // Compute changed files between head and base
    const headFiles = repo.branchFiles.get(headBranch) || new Map();
    const baseFiles = repo.branchFiles.get(baseBranch) || new Map();
    const files: ForgePullRequest['files'] = [];

    const allPaths = new Set([...headFiles.keys(), ...baseFiles.keys()]);
    for (const p of allPaths) {
      const h = headFiles.get(p);
      const b = baseFiles.get(p);
      if (h && !b) {
        files.push({ filename: p, status: 'added', additions: 1, deletions: 0, changes: 1 });
      } else if (!h && b) {
        files.push({ filename: p, status: 'removed', additions: 0, deletions: 1, changes: 1 });
      } else if (h && b && h.sha !== b.sha) {
        files.push({ filename: p, status: 'modified', additions: 1, deletions: 1, changes: 2 });
      }
    }

    const pr: ForgePullRequest = {
      id: Buffer.from(`01:PullRequest:${dbId}`).toString('base64'),
      databaseId: dbId,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      mergeable: 'MERGEABLE',
      head: { ref: headBranch, sha: headSha },
      base: { ref: baseBranch, sha: baseSha },
      headRefName: headBranch,
      baseRefName: baseBranch,
      createdAt: now,
      updatedAt: now,
      files,
    };

    repo.pulls.push(pr);
    repo.pullsByNumber.set(number, pr);
    return pr;
  }

  mergePullRequest(repo: ForgeRepo, number: number, author: string = 'Forge User <forge@make.fun>'): { sha: string; merged: boolean; message: string } | null {
    const pr = repo.pullsByNumber.get(number);
    if (!pr || pr.state === 'closed' || pr.merged) return null;

    // Apply squash merge: copy all files from head branch onto base branch
    const headFiles = repo.branchFiles.get(pr.headRefName);
    let baseFiles = repo.branchFiles.get(pr.baseRefName);
    if (!baseFiles) {
      baseFiles = new Map();
      repo.branchFiles.set(pr.baseRefName, baseFiles);
    }

    // 3-way merge conflict check against branch ancestor snapshot
    const ancestor = repo.branchAncestors.get(pr.headRefName);
    const initialFiles = ancestor?.initialFiles || new Map<string, string>();
    if (headFiles && baseFiles) {
      for (const [p, hBlob] of headFiles.entries()) {
        const bBlob = baseFiles.get(p);
        const initSha = initialFiles.get(p);
        if (bBlob && hBlob.sha !== bBlob.sha) {
          if (initSha && bBlob.sha !== initSha && hBlob.sha !== initSha) {
            pr.mergeable = 'CONFLICTING';
            return null;
          }
        }
      }
    }

    if (headFiles) {
      for (const [p, blob] of headFiles.entries()) {
        baseFiles.set(p, blob);
      }
    }

    // Build tree
    const treeEntries: string[] = [];
    for (const [p, blob] of baseFiles.entries()) {
      treeEntries.push(`100644 ${p}\0${Buffer.from(blob.sha, 'hex').toString('binary')}`);
    }
    const treeData = Buffer.from(treeEntries.join(''), 'binary');
    const treeSha = this.putObject('tree', treeData);

    // Build squash commit
    const baseTip = repo.branches.get(pr.baseRefName);
    const parents = baseTip ? [baseTip] : [];
    const timestamp = Math.floor(Date.now() / 1000);
    const commitMsg = `Merge pull request #${pr.number} from ${pr.headRefName}\n\n${pr.title}`;
    const commitLines = [
      `tree ${treeSha}`,
      ...parents.map(p => `parent ${p}`),
      `author ${author} ${timestamp} +0000`,
      `committer ${author} ${timestamp} +0000`,
      '',
      commitMsg
    ];
    const commitData = Buffer.from(commitLines.join('\n'), 'utf8');
    const mergeSha = this.putObject('commit', commitData);

    // Update base branch
    repo.branches.set(pr.baseRefName, mergeSha);
    
    // Update PR state
    const now = new Date().toISOString();
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = now;
    pr.mergeCommitSha = mergeSha;
    pr.updatedAt = now;

    return {
      sha: mergeSha,
      merged: true,
      message: 'Pull Request successfully merged'
    };
  }
}

export function parseTree(store: ForgeStore, treeSha: string, prefix = ''): Map<string, ForgeBlob> {
  const files = new Map<string, ForgeBlob>();
  const treeObj = store.objects.get(treeSha);
  if (!treeObj || treeObj.type !== 'tree') return files;
  let offset = 0;
  const buf = treeObj.data;
  while (offset < buf.length) {
    const spaceIdx = buf.indexOf(32, offset);
    if (spaceIdx < 0) break;
    const mode = buf.toString('ascii', offset, spaceIdx);
    const nullIdx = buf.indexOf(0, spaceIdx);
    if (nullIdx < 0) break;
    const name = buf.toString('utf8', spaceIdx + 1, nullIdx);
    const oid = buf.subarray(nullIdx + 1, nullIdx + 21).toString('hex');
    offset = nullIdx + 21;
    const fullPath = prefix ? `${prefix}/${name}` : name;
    if (mode === '40000' || mode === '040000') {
      const subFiles = parseTree(store, oid, fullPath);
      for (const [p, b] of subFiles.entries()) files.set(p, b);
    } else {
      const blobObj = store.objects.get(oid);
      files.set(fullPath, { sha: oid, data: blobObj ? blobObj.data : Buffer.alloc(0) });
    }
  }
  return files;
}

export function filesFromCommit(store: ForgeStore, commitSha: string): Map<string, ForgeBlob> {
  const commitObj = store.objects.get(commitSha);
  if (!commitObj || commitObj.type !== 'commit') return new Map();
  const text = commitObj.data.toString('utf8');
  const treeMatch = text.match(/^tree ([0-9a-f]{40})/m);
  if (!treeMatch) return new Map();
  return parseTree(store, treeMatch[1]);
}

export function isAncestor(store: ForgeStore, ancestorSha: string, descendantSha: string): boolean {
  if (ancestorSha === descendantSha) return true;
  const queue = [descendantSha];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === ancestorSha) return true;
    if (visited.has(cur)) continue;
    visited.add(cur);
    const obj = store.objects.get(cur);
    if (!obj || obj.type !== 'commit') continue;
    const text = obj.data.toString('utf8');
    const parentMatches = text.matchAll(/^parent ([0-9a-f]{40})/gm);
    for (const match of parentMatches) {
      if (!visited.has(match[1])) {
        queue.push(match[1]);
      }
    }
  }
  return false;
}