import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { type ForgeStore, type ForgeRepo, isAncestor, filesFromCommit } from './forge.ts';

export const ZERO_OID = '0'.repeat(40);
export const PKT_LINE_MAX = 65520;
export const PKT_LINE_MAX_PAYLOAD = PKT_LINE_MAX - 4;

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

const TYPE_CODE: Record<GitObjectType, number> = {
  commit: 1,
  tree: 2,
  blob: 3,
  tag: 4,
};

const CODE_TO_TYPE: Record<number, GitObjectType> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
};

export function encodePktLine(payload: string | Buffer): Buffer {
  if (typeof payload === 'string') {
    payload = Buffer.from(payload, 'utf8');
  }
  const len = payload.length + 4;
  if (len > PKT_LINE_MAX) {
    throw new Error(`pkt-line length ${len} exceeds maximum ${PKT_LINE_MAX}`);
  }
  const hex = len.toString(16).padStart(4, '0');
  return Buffer.concat([Buffer.from(hex, 'ascii'), payload]);
}

export const FLUSH_PKT = Buffer.from('0000', 'ascii');
export const DELIM_PKT = Buffer.from('0001', 'ascii');
export const RESPONSE_END_PKT = Buffer.from('0002', 'ascii');

export function encodeSideband(band: 1 | 2 | 3, data: Buffer): Buffer {
  const parts: Buffer[] = [];
  const chunkSize = PKT_LINE_MAX_PAYLOAD - 1; // 1 byte for band
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    const slice = data.subarray(offset, Math.min(offset + chunkSize, data.length));
    const payload = Buffer.concat([Buffer.from([band]), slice]);
    parts.push(encodePktLine(payload));
  }
  return Buffer.concat(parts);
}

export function parsePktLines(buffer: Buffer): Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer; text?: string }> {
  const packets: Array<{ kind: 'data' | 'flush' | 'delim' | 'response-end'; payload?: Buffer; text?: string }> = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lenHex = buffer.subarray(offset, offset + 4).toString('ascii');
    if (lenHex === '0000') {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (lenHex === '0001') {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (lenHex === '0002') {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    const len = parseInt(lenHex, 16);
    if (isNaN(len) || len < 4 || offset + len > buffer.length) {
      break;
    }
    const payload = buffer.subarray(offset + 4, offset + len);
    packets.push({ kind: 'data', payload, text: payload.toString('utf8') });
    offset += len;
  }
  return packets;
}

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

export function writePack(objects: Array<{ type: GitObjectType; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.allocUnsafe(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4); // pack version 2
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);

  for (const obj of objects) {
    parts.push(writePackObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }

  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

export function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start];
  let offset = start + 1;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  while (byte & 0x80) {
    byte = buffer[offset++];
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: offset, first };
}

export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) {
    throw new Error(`delta expects base size ${sourceSize}, got ${base.length}`);
  }
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += delta[offset++] * 2 ** shift;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    }
  }
  return out;
}

export function readPack(
  packBuffer: Buffer,
  resolveBase?: (oid: string) => { type: GitObjectType; data: Buffer } | undefined
): Array<{ type: GitObjectType; data: Buffer; sha: string }> {
  if (packBuffer.length < 32 || packBuffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('invalid pack header');
  }
  const count = packBuffer.readUInt32BE(8);
  let offset = 12;

  interface RawObj {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: RawObj[] = [];
  const byOffset = new Map<number, RawObj>();

  for (let i = 0; i < count; i++) {
    const entryOffset = offset;
    const header = readVarintSize(packBuffer, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const obj: RawObj = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };

    if (typeCode === 6) {
      // OFS_DELTA
      let byte = packBuffer[offset++];
      let val = byte & 0x7f;
      while (byte & 0x80) {
        byte = packBuffer[offset++];
        val = ((val + 1) * 128) + (byte & 0x7f);
      }
      obj.baseOffset = entryOffset - val;
    } else if (typeCode === 7) {
      // REF_DELTA
      obj.baseOid = packBuffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }

    // inflate
    const slice = packBuffer.subarray(offset);
    const result = inflateSync(slice, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    obj.data = result.buffer;
    offset += result.engine.bytesWritten;

    raw.push(obj);
    byOffset.set(entryOffset, obj);
  }

  // Resolve objects
  const resolved = new Map<number, { type: GitObjectType; data: Buffer }>();
  const resolveRaw = (item: RawObj): { type: GitObjectType; data: Buffer } => {
    const cached = resolved.get(item.offset);
    if (cached) return cached;

    if (item.typeCode >= 1 && item.typeCode <= 4) {
      const type = CODE_TO_TYPE[item.typeCode];
      const res = { type, data: item.data };
      resolved.set(item.offset, res);
      return res;
    }

    if (item.typeCode === 6 && item.baseOffset !== undefined) {
      const baseRaw = byOffset.get(item.baseOffset);
      if (!baseRaw) throw new Error(`ofs-delta missing base at ${item.baseOffset}`);
      const base = resolveRaw(baseRaw);
      const applied = applyDelta(base.data, item.data);
      const res = { type: base.type, data: applied };
      resolved.set(item.offset, res);
      return res;
    }

    if (item.typeCode === 7 && item.baseOid && resolveBase) {
      const base = resolveBase(item.baseOid);
      if (!base) throw new Error(`ref-delta missing base ${item.baseOid}`);
      const applied = applyDelta(base.data, item.data);
      const res = { type: base.type, data: applied };
      resolved.set(item.offset, res);
      return res;
    }

    throw new Error(`unsupported object type ${item.typeCode}`);
  };

  const results: Array<{ type: GitObjectType; data: Buffer; sha: string }> = [];
  for (const item of raw) {
    const res = resolveRaw(item);
    const header = Buffer.from(`${res.type} ${res.data.length}\0`, 'utf8');
    const sha = createHash('sha1').update(Buffer.concat([header, res.data])).digest('hex');
    results.push({ type: res.type, data: res.data, sha });
  }

  return results;
}

// -------------------------------------------------------------------------------------------------
// Protocol Handlers
// -------------------------------------------------------------------------------------------------

export function handleInfoRefs(
  repo: ForgeRepo,
  service: 'git-upload-pack' | 'git-receive-pack',
  gitProtocol: string | null
): { status: number; contentType: string; body: Buffer } {
  if (service === 'git-upload-pack') {
    const contentType = 'application/x-git-upload-pack-advertisement';
    if (gitProtocol === 'version=2') {
      const parts: Buffer[] = [
        encodePktLine('version 2\n'),
        encodePktLine('ls-refs=unborn\n'),
        encodePktLine('fetch=shallow\n'),
        encodePktLine('server-option\n'),
        encodePktLine('object-format=sha1\n'),
        FLUSH_PKT
      ];
      return { status: 200, contentType, body: Buffer.concat(parts) };
    } else {
      // v0 upload-pack
      const parts: Buffer[] = [
        encodePktLine('# service=git-upload-pack\n'),
        FLUSH_PKT
      ];
      const defaultSha = repo.branches.get(repo.defaultBranch);
      if (defaultSha) {
        parts.push(encodePktLine(`${defaultSha} HEAD\0symref=HEAD:refs/heads/${repo.defaultBranch} side-band-64k multi_ack_max thin-pack ofs-delta agent=makefun-git/1.0\n`));
      }
      for (const [branch, sha] of repo.branches.entries()) {
        parts.push(encodePktLine(`${sha} refs/heads/${branch}\n`));
      }
      for (const [tag, sha] of repo.tags.entries()) {
        parts.push(encodePktLine(`${sha} refs/tags/${tag}\n`));
      }
      parts.push(FLUSH_PKT);
      return { status: 200, contentType, body: Buffer.concat(parts) };
    }
  } else if (service === 'git-receive-pack') {
    const contentType = 'application/x-git-receive-pack-advertisement';
    const parts: Buffer[] = [
      encodePktLine('# service=git-receive-pack\n'),
      FLUSH_PKT
    ];
    const branches = [...repo.branches.entries()];
    if (branches.length === 0) {
      parts.push(encodePktLine(`${ZERO_OID} capabilities^{}\0report-status delete-refs side-band-64k\n`));
    } else {
      let isFirst = true;
      for (const [branch, sha] of branches) {
        if (isFirst) {
          parts.push(encodePktLine(`${sha} refs/heads/${branch}\0report-status delete-refs side-band-64k\n`));
          isFirst = false;
        } else {
          parts.push(encodePktLine(`${sha} refs/heads/${branch}\n`));
        }
      }
      for (const [tag, sha] of repo.tags.entries()) {
        parts.push(encodePktLine(`${sha} refs/tags/${tag}\n`));
      }
    }
    parts.push(FLUSH_PKT);
    return { status: 200, contentType, body: Buffer.concat(parts) };
  }

  return { status: 400, contentType: 'text/plain', body: Buffer.from('invalid service\n') };
}

export function handleUploadPack(
  repo: ForgeRepo,
  store: ForgeStore,
  requestBody: Buffer,
  gitProtocol: string | null
): { status: number; contentType: string; body: Buffer } {
  const contentType = 'application/x-git-upload-pack-result';
  const packets = parsePktLines(requestBody);

  if (gitProtocol === 'version=2') {
    const lines = packets.filter(p => p.kind === 'data').map(p => p.text?.trim() || '');
    const command = lines.find(l => l.startsWith('command='))?.slice(8);

    if (command === 'ls-refs') {
      const symrefs = lines.includes('symrefs');
      const peel = lines.includes('peel');
      const prefixes = lines.filter(l => l.startsWith('ref-prefix ')).map(l => l.slice(11));

      const parts: Buffer[] = [];
      const matchPrefix = (ref: string) => prefixes.length === 0 || prefixes.some(p => ref.startsWith(p));

      // HEAD
      const defaultSha = repo.branches.get(repo.defaultBranch);
      if (defaultSha && matchPrefix('HEAD')) {
        let line = `${defaultSha} HEAD`;
        if (symrefs) line += ` symref-target:refs/heads/${repo.defaultBranch}`;
        parts.push(encodePktLine(`${line}\n`));
      }

      for (const [branch, sha] of repo.branches.entries()) {
        const ref = `refs/heads/${branch}`;
        if (matchPrefix(ref)) {
          parts.push(encodePktLine(`${sha} ${ref}\n`));
        }
      }

      for (const [tag, sha] of repo.tags.entries()) {
        const ref = `refs/tags/${tag}`;
        if (matchPrefix(ref)) {
          let line = `${sha} ${ref}`;
          if (peel) {
            const obj = store.getObject(sha);
            if (obj && obj.type === 'tag') {
              const parsed = obj.data.toString('utf8');
              const target = parsed.match(/^object ([0-9a-f]{40})/m)?.[1];
              if (target) line += ` peeled:${target}`;
            }
          }
          parts.push(encodePktLine(`${line}\n`));
        }
      }

      parts.push(FLUSH_PKT);
      return { status: 200, contentType, body: Buffer.concat(parts) };
    }

    if (command === 'fetch') {
      const wants = lines.filter(l => l.startsWith('want ')).map(l => l.slice(5));
      const haves = new Set(lines.filter(l => l.startsWith('have ')).map(l => l.slice(5)));
      const clientShallows = new Set(lines.filter(l => l.startsWith('shallow ')).map(l => l.slice(8)));
      const deepenLine = lines.find(l => l.startsWith('deepen '));
      const depth = deepenLine ? parseInt(deepenLine.slice(7).trim(), 10) : 0;

      // Expand haves to all reachable commits, trees, blobs
      const reachableHaves = new Set<string>();
      const markHaveReachable = (oid: string) => {
        if (!oid || reachableHaves.has(oid)) return;
        reachableHaves.add(oid);
        const obj = store.getObject(oid);
        if (!obj) return;
        if (obj.type === 'commit') {
          const text = obj.data.toString('utf8');
          const treeSha = text.match(/^tree ([0-9a-f]{40})/m)?.[1];
          if (treeSha) markHaveReachable(treeSha);
          // In shallow clones, if the client marks a commit as shallow, its parents are truncated!
          if (!clientShallows.has(oid)) {
            const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map(m => m[1]);
            for (const p of parents) markHaveReachable(p);
          }
        } else if (obj.type === 'tree') {
          let off = 0;
          while (off < obj.data.length) {
            const nullByte = obj.data.indexOf(0, off);
            if (nullByte === -1) break;
            const sha = obj.data.subarray(nullByte + 1, nullByte + 21).toString('hex');
            markHaveReachable(sha);
            off = nullByte + 21;
          }
        } else if (obj.type === 'tag') {
          const text = obj.data.toString('utf8');
          const target = text.match(/^object ([0-9a-f]{40})/m)?.[1];
          if (target) markHaveReachable(target);
        }
      };
      for (const h of haves) markHaveReachable(h);

      // Collect shallow boundaries and unshallow list
      const shallowBoundaries = new Set<string>();
      const unshallowList = new Set<string>();
      const allowedCommits = new Set<string>();

      if (depth > 0) {
        for (const want of wants) {
          let currentLevel = [want];
          for (let d = 1; d <= depth; d++) {
            const nextLevel: string[] = [];
            for (const cSha of currentLevel) {
              allowedCommits.add(cSha);
              const obj = store.getObject(cSha);
              if (!obj || obj.type !== 'commit') continue;
              const text = obj.data.toString('utf8');
              const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map(m => m[1]);
              if (d === depth) {
                if (parents.length > 0) {
                  shallowBoundaries.add(cSha);
                }
              } else {
                for (const p of parents) {
                  nextLevel.push(p);
                }
              }
            }
            currentLevel = nextLevel;
          }
        }
        for (const s of clientShallows) {
          if (allowedCommits.has(s) && !shallowBoundaries.has(s)) {
            unshallowList.add(s);
          }
        }
      }

      // Collect objects to send
      const visited = new Set<string>();
      const objectsToSend: Array<{ type: GitObjectType; data: Buffer }> = [];

      const walk = (oid: string) => {
        if (!oid || visited.has(oid)) return;
        visited.add(oid);
        const obj = store.getObject(oid);
        if (!obj) return;

        if (obj.type === 'commit') {
          if (depth > 0 && !allowedCommits.has(oid)) return;

          // Only send the commit object if the client doesn't already have it
          if (!haves.has(oid)) {
            objectsToSend.push(obj);
          }

          const text = obj.data.toString('utf8');
          const treeSha = text.match(/^tree ([0-9a-f]{40})/m)?.[1];
          if (treeSha && !reachableHaves.has(treeSha)) walk(treeSha);

          if (depth === 0 || !shallowBoundaries.has(oid)) {
            const parents = [...text.matchAll(/^parent ([0-9a-f]{40})/gm)].map(m => m[1]);
            for (const p of parents) walk(p);
          }
        } else if (obj.type === 'tree') {
          if (reachableHaves.has(oid)) return;
          objectsToSend.push(obj);
          let off = 0;
          while (off < obj.data.length) {
            const nullByte = obj.data.indexOf(0, off);
            if (nullByte === -1) break;
            const sha = obj.data.subarray(nullByte + 1, nullByte + 21).toString('hex');
            walk(sha);
            off = nullByte + 21;
          }
        } else if (obj.type === 'tag') {
          if (reachableHaves.has(oid)) return;
          objectsToSend.push(obj);
          const text = obj.data.toString('utf8');
          const target = text.match(/^object ([0-9a-f]{40})/m)?.[1];
          if (target) walk(target);
        } else {
          // blob
          if (reachableHaves.has(oid)) return;
          objectsToSend.push(obj);
        }
      };

      for (const want of wants) {
        walk(want);
      }

      const packBytes = writePack(objectsToSend);
      const parts: Buffer[] = [
        encodePktLine('acknowledgments\n'),
        DELIM_PKT,
      ];

      if (shallowBoundaries.size > 0 || unshallowList.size > 0) {
        parts.push(encodePktLine('shallow-info\n'));
        for (const s of shallowBoundaries) {
          parts.push(encodePktLine(`shallow ${s}\n`));
        }
        for (const u of unshallowList) {
          parts.push(encodePktLine(`unshallow ${u}\n`));
        }
        parts.push(DELIM_PKT);
      }

      parts.push(
        encodePktLine('packfile\n'),
        encodeSideband(1, packBytes),
        FLUSH_PKT
      );
      return { status: 200, contentType, body: Buffer.concat(parts) };
    }
  }

  // Fallback v0 fetch
  return { status: 200, contentType, body: FLUSH_PKT };
}

export function handleReceivePack(
  repo: ForgeRepo,
  store: ForgeStore,
  requestBody: Buffer
): { status: number; contentType: string; body: Buffer } {
  const contentType = 'application/x-git-receive-pack-result';

  // Find packfile in body
  const packIndex = requestBody.indexOf(Buffer.from('PACK', 'ascii'));
  const commandPart = packIndex > 0 ? requestBody.subarray(0, packIndex) : requestBody;
  const packPart = packIndex > 0 ? requestBody.subarray(packIndex) : null;

  const packets = parsePktLines(commandPart);
  const commandLines = packets.filter(p => p.kind === 'data').map(p => p.text?.trim() || '');

  let unpackOk = true;
  let unpackDetail = 'ok';

  if (packPart && packPart.length > 0) {
    try {
      const unpacked = readPack(packPart, (oid) => store.getObject(oid));
      for (const obj of unpacked) {
        store.putObject(obj.type, obj.data);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = (err as Error).message;
    }
  }

  const reports: string[] = [];
  let sideband = false;

  for (const line of commandLines) {
    if (!line) continue;
    // format: <oldOid> <newOid> <ref>\0<caps> or <oldOid> <newOid> <ref>
    const nullIdx = line.indexOf('\0');
    const head = nullIdx >= 0 ? line.slice(0, nullIdx) : line;
    const caps = nullIdx >= 0 ? line.slice(nullIdx + 1) : '';
    if (caps.includes('side-band-64k')) sideband = true;

    const parts = head.split(' ');
    if (parts.length < 3) continue;
    const [oldOid, newOid, ref] = parts;

    if (!unpackOk) {
      reports.push(`ng ${ref} unpack failed\n`);
      continue;
    }

    if (ref.startsWith('refs/heads/')) {
      const branchName = ref.slice(11);
      const currentOid = repo.branches.get(branchName);

      if (oldOid === ZERO_OID) {
        // Create branch
        repo.branches.set(branchName, newOid);
        const files = filesFromCommit(store, newOid);
        repo.branchFiles.set(branchName, files);
        // Track ancestor initial file snapshot
        const initMap = new Map<string, string>();
        for (const [p, b] of files.entries()) initMap.set(p, b.sha);
        repo.branchAncestors.set(branchName, { baseSha: newOid, initialFiles: initMap });
        reports.push(`ok ${ref}\n`);
      } else if (newOid === ZERO_OID) {
        // Delete branch
        repo.branches.delete(branchName);
        repo.branchFiles.delete(branchName);
        repo.branchAncestors.delete(branchName);
        reports.push(`ok ${ref}\n`);
      } else {
        // Update branch - check non-fast-forward
        if (currentOid && (currentOid !== oldOid || !isAncestor(store, currentOid, newOid))) {
          reports.push(`ng ${ref} non-fast-forward\n`);
        } else {
          repo.branches.set(branchName, newOid);
          repo.branchFiles.set(branchName, filesFromCommit(store, newOid));
          reports.push(`ok ${ref}\n`);
        }
      }
    } else if (ref.startsWith('refs/tags/')) {
      const tagName = ref.slice(10);
      if (newOid === ZERO_OID) {
        repo.tags.delete(tagName);
      } else {
        repo.tags.set(tagName, newOid);
      }
      reports.push(`ok ${ref}\n`);
    } else {
      reports.push(`ok ${ref}\n`);
    }
  }

  const reportPayloadParts: Buffer[] = [
    encodePktLine(unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`)
  ];
  for (const rep of reports) {
    reportPayloadParts.push(encodePktLine(rep));
  }
  reportPayloadParts.push(FLUSH_PKT);
  const rawReport = Buffer.concat(reportPayloadParts);

  if (sideband) {
    const wrapped = encodeSideband(1, rawReport);
    return { status: 200, contentType, body: Buffer.concat([wrapped, FLUSH_PKT]) };
  } else {
    return { status: 200, contentType, body: rawReport };
  }
}
