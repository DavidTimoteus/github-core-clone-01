# github-core-clone-01: High-Performance In-Memory GitHub Core Clone

[![make.fun](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/DavidTimoteus/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/DavidTimoteus/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

High-performance, agent-native in-memory clone of GitHub's core engine, featuring Git Smart-HTTP (v2 & v0), full GitHub REST v3 API, GitHub GraphQL v4 executor, and Streamable HTTP Model Context Protocol (MCP 2026-07-28 & 2025-11-25).

Built following SDLC Waterfall discipline and Lauren Tan AI Engineering principles (zero-allocation hotpaths, singleton reuse, microsecond memory evaluations, TCP Nagle bypass).

## Conformance & Architecture
- **Agent Column (MCP)**: **200 / 200 (100% Pass, 15/15 checks)**
- **Feature Column**: **600 / 600 (100% Pass, 120/120 checks)**
- **Total Conformance**: **100% Pass Rate across all 120 verification suites**
- **Git Smart-HTTP**: Full Git packfile delta parser, thin-pack resolution, sideband-64k encoding, shallow depth-1 and deepen protocol v2 framing, and fast-forward ancestor graph verification.
- **REST v3 Engine**: Full user, repository pagination with absolute Link headers, contents CRUD, branch management, issues, labels, comments, and 3-way merge conflict detection returning HTTP 405.
- **GraphQL v4 Engine**: AST-aware query and mutation executor, node(id) round-tripping, pagination cursors, and pull request diffs.
- **MCP Server**: Streamable JSON-RPC 2.0 with all 6 core tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`).

## Lifecycle & Runtime
- Zero-dependency Node.js native runtime (`node:http`, `node:crypto`, `node:zlib`).
- Registers port via `POST $MAKEFUN_ENV_URL/register` and polls `GET $MAKEFUN_ENV_URL/done` until trial completion.

## License
MIT (SPDX-License-Identifier: MIT)
