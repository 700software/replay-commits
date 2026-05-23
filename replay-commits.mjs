#!/usr/bin/env node
/**
 * Replay commits that touch a source subdirectory onto a destination repository
 * (optionally under a destination subdirectory), preserving author and committer
 * identity and timestamps and appending a provenance footer.
 *
 * Merge commits use the first-parent subtree diff (`sha^1` .. `sha`).
 * See --help for usage and a pointer to `git subtree split` for simpler flows.
 */

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'

const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904'
const SUBTREE_DOC = 'https://git-scm.com/docs/git-subtree'

main()

function usage() {
  return `replay-commits — replay subtree history onto another git repo

Usage:
  npx replay-commits@latest \\
    --source-repo <path> \\
    --source-dir <relative-dir> \\
    --dest-repo <path> \\
    --dest-dir <relative-dir> \\
    [--github-repo <owner/name>] \\
    [--no-merges] [--dry-run] [--table-only] [--output <file.md>]

Options:
  --source-repo   Path to the repository that contains the source history.
  --source-dir    Directory inside the source repo to replay.
  --dest-repo     Path to the target repository (commits are appended here).
  --dest-dir      Directory inside the dest repo to apply into (use . for repo root).
  --github-repo   Optional override for owner/name in links, footer, and #123 rewrites.
                  If omitted, parsed from origin (github.com only); if that fails,
                  commit links use plain SHAs, footer is "Original commit: <sha>", and
                  bare #123 in messages is left unchanged.
  --no-merges     Only replay commits that are not merge commits (exclude merges).
  --dry-run       Print the markdown table and planned actions; do not modify dest.
  --table-only    Print the markdown table and exit (no replay).
  --output        Also write the markdown table to this file (still prints to stdout).

Replay model:
  Commits that touch --source-dir are listed oldest-first using git log --reverse
  --topo-order (parents before children, merges in sensible order). For a non-merge
  commit, the patch is git diff parent..commit limited to that pathspec. For a merge
  commit, the patch is git diff commit^1..commit (first-parent delta) limited to the
  pathspec — same as what landed on the first parent branch for that subtree. Paths
  are rewritten into --dest-dir. Before each apply, the destination is reset with
  git reset --hard to the replayed commit matching the source diff parent (or the
  initial dest commit when that parent had no tree at --source-dir yet), so sibling
  branches in topo order do not stack patches on the wrong base. Then git apply --index.
  Non-merge commits are finalized with git commit -F. Merge commits use git commit-tree
  with one -p per mapped source parent when every parent has a dest SHA (replay or
  subtree-tree alias); otherwise git commit -F with a single parent and a warning.
  GIT_AUTHOR_* / GIT_COMMITTER_* / dates always match the source commit. The message is the source body with bare #NNN rewritten to owner/repo#NNN
  when owner/repo is known, plus an Original commit: line. If the body ends with Git
  trailers (Co-authored-by, Signed-off-by, etc.), that line is inserted above the
  trailer block so GitHub still parses co-authors (trailers must remain last).

See also (simpler alternative):
  If you only need to extract a subdirectory's history into a new branch and push
  it to a standalone repo — without append replay, path remapping, provenance
  footers, or the audit table — use Git's built-in:
    git subtree split --prefix=<dir> ...
  Official documentation:
    ${SUBTREE_DOC}
`
}

function die(msg, code = 1) {
  console.error(msg)
  process.exit(code)
}

function git(cwd, args, input) {
  const opts = {
    cwd,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
    input: input ?? undefined,
  }
  const r = spawnSync('git', args, opts)
  if (r.error) {
    throw r.error
  }
  if (r.status !== 0) {
    const err = (r.stderr || '').trim() || `git ${args.join(' ')} failed`
    const e = new Error(err)
    e.status = r.status
    e.stdout = r.stdout
    e.stderr = r.stderr
    throw e
  }
  return (r.stdout || '').replace(/\r\n/g, '\n')
}

function gitAllowFail(cwd, args) {
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return {
    status: r.status ?? 1,
    stdout: (r.stdout || '').replace(/\r\n/g, '\n'),
    stderr: r.stderr || '',
  }
}

function resolveRepo(p) {
  const abs = path.resolve(p)
  if (!fs.statSync(abs, { throwIfNoEntry: false })?.isDirectory()) {
    die(`Not a directory: ${p}`)
  }
  if (!fs.statSync(path.join(abs, '.git'), { throwIfNoEntry: false })) {
    die(`Not a git repository (missing .git): ${abs}`)
  }
  return abs
}

function normalizeRelDir(d) {
  let s = String(d).replace(/\\/g, '/').replace(/^\/+/, '')
  if (s === '' || s === '.') {
    return '.'
  }
  s = s.replace(/\/+$/, '')
  return s
}

function assertGithubRepo(s) {
  if (!/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/.test(s)) {
    die(`--github-repo must look like owner/name, got: ${s}`)
  }
}

/** @returns {string | null} owner/repo or null if not github.com / not parseable */
function resolveGithubRepoFromRemote(sourceRepo) {
  let url = ''
  const r1 = gitAllowFail(sourceRepo, ['remote', 'get-url', 'origin'])
  if (r1.status === 0) {
    url = r1.stdout.trim()
  }
  if (!url) {
    const r2 = gitAllowFail(sourceRepo, ['config', '--get', 'remote.origin.url'])
    if (r2.status === 0) {
      url = r2.stdout.trim()
    }
  }
  if (!url) {
    return null
  }
  const mSsh = url.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/i)
  if (mSsh) {
    return `${mSsh[1]}/${mSsh[2]}`
  }
  const mHttps = url.match(/^https?:\/\/github\.com\/([^/]+)\/([^/?#]+?)(?:\.git)?(?:\/|$)/i)
  if (mHttps) {
    return `${mHttps[1]}/${mHttps[2]}`
  }
  const mSshProto = url.match(/^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/i)
  if (mSshProto) {
    return `${mSshProto[1]}/${mSshProto[2]}`
  }
  return null
}

function listTouchesOutside(sourceRepo, sha, sourceDir) {
  if (sourceDir === '.') {
    return false
  }
  const names = git(sourceRepo, ['show', '--format=', '--name-only', sha])
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
  const prefix = `${sourceDir}/`
  for (const n of names) {
    if (n === sourceDir) {
      continue
    }
    if (!n.startsWith(prefix)) {
      return true
    }
  }
  return false
}

function listCommits(sourceRepo, sourceDir, noMerges) {
  const spec = sourceDir === '.' ? '.' : `${sourceDir}/`
  const args = ['log', '--reverse', '--topo-order', '--format=%H', '--', spec]
  if (noMerges) {
    args.splice(1, 0, '--no-merges')
  }
  const out = git(sourceRepo, args)
  return out
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
}

function isMergeCommit(sourceRepo, sha) {
  return listParentShas(sourceRepo, sha).length > 1
}

/** Parent SHAs for a commit (empty for root). */
function listParentShas(sourceRepo, sha) {
  const out = git(sourceRepo, ['show', '-s', '--format=%P', sha]).trim()
  if (!out) {
    return []
  }
  return out.split(/\s+/).filter(Boolean)
}

/**
 * Tree object id for `sourceDir` at `sha`, or `null` if the path is missing.
 * For `sourceDir === '.'` returns the root tree of the commit.
 */
function subtreeTreeOid(sourceRepo, sha, sourceDir) {
  if (sourceDir === '.') {
    return git(sourceRepo, ['rev-parse', `${sha}^{tree}`]).trim()
  }
  const line = git(sourceRepo, ['ls-tree', sha, '--', sourceDir]).split('\n')[0]?.trim() ?? ''
  const m = /^(\S+)\s+(\S+)\s+(\S+)\s/.exec(line)
  if (!m) {
    return null
  }
  return m[3]
}

function isAncestor(sourceRepo, maybeAncestor, descendant) {
  const r = spawnSync('git', ['merge-base', '--is-ancestor', maybeAncestor, descendant], {
    cwd: sourceRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return r.status === 0
}

/** True when `git diff --quiet a b -- pathspec` (no textual diff for that path). */
function diffQuietForPathspec(sourceRepo, a, b, pathspec) {
  const r = spawnSync('git', ['diff', '--quiet', a, b, '--', pathspec], {
    cwd: sourceRepo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return r.status === 0
}

/**
 * Map a source commit `p` (merge parent or `diffParentForReplay`) that does not
 * appear in the path-filtered replay list onto an existing dest commit: the
 * latest replayed source commit before `currentSha` that is an ancestor of `p`
 * and has the same subtree tree at `sourceDir`, else a first-parent walk with an
 * empty path diff to a mapped commit. Mutates `sourceToDest`.
 */
function aliasUnmappedSourceParentToDest({ sourceRepo, sourceDir, pathspec, sourceToDest, shas, currentSha, p }) {
  if (sourceToDest.has(p) || p === EMPTY_TREE) {
    return
  }
  const curIdx = shas.indexOf(currentSha)
  if (curIdx < 0) {
    return
  }
  const treeP = subtreeTreeOid(sourceRepo, p, sourceDir)
  let best = null
  let bestIdx = -1
  for (let i = 0; i < curIdx; i += 1) {
    const q = shas[i]
    if (!sourceToDest.has(q)) {
      continue
    }
    if (!isAncestor(sourceRepo, q, p)) {
      continue
    }
    const treeQ = subtreeTreeOid(sourceRepo, q, sourceDir)
    if (treeQ !== treeP) {
      continue
    }
    if (i > bestIdx) {
      bestIdx = i
      best = q
    }
  }
  if (best != null) {
    sourceToDest.set(p, sourceToDest.get(best))
    console.error(
      `[alias] source ${p.slice(0, 7)} not in path log → same subtree tree as ${best.slice(
        0,
        7,
      )} → dest ${sourceToDest.get(p).slice(0, 7)}`,
    )
    return
  }
  const seen = new Set()
  let cur = p
  while (!seen.has(cur)) {
    seen.add(cur)
    if (sourceToDest.has(cur)) {
      if (diffQuietForPathspec(sourceRepo, cur, p, pathspec)) {
        sourceToDest.set(p, sourceToDest.get(cur))
        console.error(`[alias] source ${p.slice(0, 7)} via first-parent empty path diff from ${cur.slice(0, 7)}`)
      }
      break
    }
    const pars = listParentShas(sourceRepo, cur)
    if (pars.length === 0) {
      break
    }
    cur = pars[0]
  }
}

function ensureMergeParentsMapped({ sourceRepo, sourceDir, parentsSrc, sourceToDest, shas, currentSha, pathspec }) {
  for (const p of parentsSrc) {
    aliasUnmappedSourceParentToDest({
      sourceRepo,
      sourceDir,
      pathspec,
      sourceToDest,
      shas,
      currentSha,
      p,
    })
  }
}

/**
 * Dest SHA to `reset --hard` to before applying `git diff diffParent..sha` for this
 * replay step. Uses `initialDestSha` when the source diff parent has no tree at
 * `sourceDir` (directory did not exist yet).
 */
function resolveDestBaseSha({ initialDestSha, sourceRepo, sourceDir, sourceToDest, diffParentSrc }) {
  if (diffParentSrc === EMPTY_TREE) {
    return initialDestSha
  }
  if (sourceToDest.has(diffParentSrc)) {
    return sourceToDest.get(diffParentSrc)
  }
  if (subtreeTreeOid(sourceRepo, diffParentSrc, sourceDir) == null) {
    return initialDestSha
  }
  die(
    `Cannot resolve replay base for source parent ${diffParentSrc}: not replayed yet and subtree exists at "${sourceDir}".`,
  )
}

function rowForCommit(sourceRepo, sha, githubRepo, sourceDir) {
  const ai = git(sourceRepo, ['log', '-1', '--format=%ai', sha]).trim()
  const author = git(sourceRepo, ['log', '-1', '--format=%an <%ae>', sha]).trim()
  const subject = git(sourceRepo, ['log', '-1', '--format=%s', sha]).trim()
  const outside = listTouchesOutside(sourceRepo, sha, sourceDir) ? 'yes' : 'no'
  const merge = isMergeCommit(sourceRepo, sha) ? 'yes' : 'no'
  const short = sha.slice(0, 7)
  const link = githubRepo ? `[${short}](https://github.com/${githubRepo}/commit/${sha})` : `\`${short}\``
  return { sha, short, link, ai, author, subject, outside, merge }
}

function markdownTable(rows) {
  const lines = [
    '| Commit | Timestamp (author) | Author | Summary | Merge? | Touches outside source dir? |',
    '| --- | --- | --- | --- | --- | --- |',
  ]
  for (const r of rows) {
    const sub = r.subject.replace(/\|/g, '\\|')
    lines.push(`| ${r.link} | ${r.ai} | ${r.author.replace(/\|/g, '\\|')} | ${sub} | ${r.merge} | ${r.outside} |`)
  }
  return `${lines.join('\n')}\n`
}

/** Rewrite bare #123 to owner/repo#123 when githubRepo is set */
function rewriteBareIssueRefs(text, githubRepo) {
  if (!githubRepo) {
    return text
  }
  return text.replace(/(^|[\s([{,;])(#\d+)\b/g, (m, pre, issue) => `${pre}${githubRepo}${issue}`)
}

/** Known Git / GitHub trailer tokens when they appear as the final block (case-insensitive). */
function isKnownTrailerLine(line) {
  const t = line.trim()
  if (!t) {
    return false
  }
  return /^(?:Co-authored-by|Signed-off-by|Reviewed-by|Acked-by|Tested-by|Helped-by|Suggested-by|Reported-by|Fixes|Closes|CC):\s*\S/i.test(
    t,
  )
}

/**
 * Split a commit body into main text and a trailing run of known trailer lines.
 * Inserts provenance above this block so GitHub still parses Co-authored-by last.
 * @returns {{ main: string, trailers: string | null }}
 */
function splitBodyAndTrailingTrailers(body) {
  const trimmed = body.replace(/\s+$/, '')
  const lines = trimmed.split('\n')
  let k = lines.length - 1
  while (k >= 0 && lines[k].trim() === '') {
    k -= 1
  }
  if (k < 0) {
    return { main: '', trailers: null }
  }
  if (!isKnownTrailerLine(lines[k])) {
    return { main: trimmed, trailers: null }
  }
  let s = k
  while (s >= 0 && isKnownTrailerLine(lines[s])) {
    s -= 1
  }
  const trailerLines = lines.slice(s + 1, k + 1)
  const trailers = trailerLines.join('\n')
  const mainLines = lines.slice(0, s + 1)
  while (mainLines.length > 0 && mainLines[mainLines.length - 1].trim() === '') {
    mainLines.pop()
  }
  const main = mainLines.join('\n')
  return { main, trailers }
}

/** Join non-empty chunks with exactly one blank line between each. */
function joinWithBlankLines(...chunks) {
  return chunks.filter(c => c != null && String(c).trim() !== '').join('\n\n')
}

function rewritePatch(patch, sourceDir, destDir) {
  const src = normalizeRelDir(sourceDir)
  const dst = normalizeRelDir(destDir)
  if (src === '.') {
    die("--source-dir '.' is not supported (path rewrite would be ambiguous).")
  }
  const dstMid = dst === '.' ? '' : `${dst}/`
  const fromA = `a/${src}/`
  const fromB = `b/${src}/`
  const toA = dstMid ? `a/${dstMid}` : 'a/'
  const toB = dstMid ? `b/${dstMid}` : 'b/'
  let out = patch.split(fromA).join(toA).split(fromB).join(toB)
  const rel = `${src}/`
  const destRel = dstMid
  out = out.split(`rename from ${rel}`).join(`rename from ${destRel}`)
  out = out.split(`rename to ${rel}`).join(`rename to ${destRel}`)
  out = out.split(`copy from ${rel}`).join(`copy from ${destRel}`)
  out = out.split(`copy to ${rel}`).join(`copy to ${destRel}`)
  return out
}

function diffParentForReplay(sourceRepo, sha) {
  const parents = git(sourceRepo, ['show', '-s', '--format=%P', sha]).trim().split(/\s+/).filter(Boolean)
  if (parents.length === 0) {
    return EMPTY_TREE
  }
  if (parents.length === 1) {
    return parents[0]
  }
  return parents[0]
}

function destResetHard(destRepo) {
  git(destRepo, ['reset', '--hard', 'HEAD'])
}

/** Try apply strategies; reset index/worktree to HEAD between failed attempts. */
function applyPatchIndex(destRepo, patchFile, sha) {
  const attempts = [
    ['apply', '--index', '--whitespace=nowarn', patchFile],
    ['apply', '--index', '--whitespace=nowarn', '--3way', patchFile],
    ['apply', '--index', '--whitespace=nowarn', '--ignore-space-change', patchFile],
  ]
  let lastErr = ''
  for (const extra of attempts) {
    try {
      git(destRepo, extra)
      return
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      try {
        destResetHard(destRepo)
      } catch {
        /* ignore */
      }
    }
  }
  die(`git apply failed for source ${sha} after retries.\n` + `Patch left at: ${patchFile}\n` + `${lastErr}`)
}

function destStatusPorcelain(destRepo) {
  return git(destRepo, ['status', '--porcelain']).trim()
}

function commitMetadataEnv(sourceRepo, sha) {
  const lines = git(sourceRepo, ['log', '-1', '--format=%an%n%ae%n%ai%n%cn%n%ce%n%ci', sha]).trimEnd().split('\n')
  if (lines.length !== 6) {
    die(`Unexpected git log format line count for ${sha}: ${lines.length}`)
  }
  const [an, ae, ai, cn, ce, ci] = lines
  return {
    GIT_AUTHOR_NAME: an,
    GIT_AUTHOR_EMAIL: ae,
    GIT_AUTHOR_DATE: ai,
    GIT_COMMITTER_NAME: cn,
    GIT_COMMITTER_EMAIL: ce,
    GIT_COMMITTER_DATE: ci,
  }
}

function commitMessage(sourceRepo, sha, githubRepo) {
  let body = git(sourceRepo, ['log', '-1', '--format=%B', sha]).replace(/\s+$/, '')
  body = rewriteBareIssueRefs(body, githubRepo)
  const prov = githubRepo ? `Original commit: ${githubRepo}@${sha}` : `Original commit: ${sha}`
  const { main, trailers } = splitBodyAndTrailingTrailers(body)
  if (trailers) {
    return `${joinWithBlankLines(main, prov, trailers)}\n`
  }
  return `${joinWithBlankLines(main, prov)}\n`
}

/**
 * Finalize a replayed commit on dest. Merge commits use `git commit-tree` with one
 * `-p` per source parent when each parent has a dest mapping (including synthetic
 * aliases from {@link ensureMergeParentsMapped}); otherwise falls back to a
 * single-parent `git commit`.
 */
function createReplayCommit({
  destRepo,
  msgFile,
  commitEnv,
  sourceSha,
  parentsSrc,
  merge,
  hasStagedChanges,
  sourceToDest,
}) {
  const tree = hasStagedChanges
    ? git(destRepo, ['write-tree']).trim()
    : git(destRepo, ['rev-parse', 'HEAD^{tree}']).trim()
  const msgText = fs.readFileSync(msgFile, 'utf8')

  if (merge && parentsSrc.length >= 2) {
    const mappedAll = parentsSrc.every(p => sourceToDest.has(p))
    if (mappedAll) {
      const args = ['commit-tree', tree]
      for (const p of parentsSrc) {
        args.push('-p', sourceToDest.get(p))
      }
      const r = spawnSync('git', args, {
        cwd: destRepo,
        encoding: 'utf8',
        env: { ...process.env, ...commitEnv },
        input: msgText,
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      if (r.status !== 0) {
        die(`git commit-tree failed for merge replay of ${sourceSha}: ${(r.stderr || '').trim() || r.stdout}`)
      }
      const newSha = r.stdout.trim()
      git(destRepo, ['reset', '--hard', newSha])
      return
    }
    const flags = parentsSrc.map(p => (sourceToDest.has(p) ? 'mapped' : 'missing')).join(', ')
    console.error(
      `[warn] ${sourceSha.slice(0, 7)} merge: missing replay mapping for some parents (${flags}); ` +
        `using single-parent git commit instead.`,
    )
  }

  const commitArgs = ['commit', '-F', msgFile]
  if (!hasStagedChanges && merge) {
    commitArgs.splice(1, 0, '--allow-empty')
    console.error(
      `[warn] ${sourceSha.slice(
        0,
        7,
      )} merge: no staged changes (delta already applied); recording empty commit with merge message.`,
    )
  }
  const c = spawnSync('git', commitArgs, {
    cwd: destRepo,
    encoding: 'utf8',
    env: { ...process.env, ...commitEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (c.status !== 0) {
    die(`git commit failed for replay of ${sourceSha}: ${(c.stderr || '').trim() || c.stdout}`)
  }
}

function main() {
  const argv = process.argv.slice(2)
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(usage())
    process.exit(0)
  }

  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        'source-repo': { type: 'string' },
        'source-dir': { type: 'string' },
        'dest-repo': { type: 'string' },
        'dest-dir': { type: 'string', default: '.' },
        'github-repo': { type: 'string' },
        'no-merges': { type: 'boolean', default: false },
        'dry-run': { type: 'boolean', default: false },
        'table-only': { type: 'boolean', default: false },
        output: { type: 'string' },
      },
      allowPositionals: false,
    }))
  } catch (e) {
    die(`${e instanceof Error ? e.message : String(e)}\n\n${usage()}`, 1)
  }

  const sr = values['source-repo']
  const sd = values['source-dir']
  const dr = values['dest-repo']
  const dd = values['dest-dir']
  const ghFlag = values['github-repo']

  if (!sr || !sd || !dr || !dd) {
    die(`Missing required flags.\n\n${usage()}`)
  }

  if (ghFlag) {
    assertGithubRepo(ghFlag)
  }

  const sourceRepo = resolveRepo(sr)
  const destRepo = resolveRepo(dr)
  const sourceDir = normalizeRelDir(sd)
  const destDir = normalizeRelDir(dd)

  let githubRepo = ghFlag ?? null
  if (!githubRepo) {
    githubRepo = resolveGithubRepoFromRemote(sourceRepo)
    if (!githubRepo) {
      console.error(
        '[warn] Could not parse github.com owner/repo from origin; using plain SHAs in the table, footer without org/repo, and leaving bare #123 in messages unchanged.',
      )
    }
  }

  const noMerges = values['no-merges']
  const shas = listCommits(sourceRepo, sourceDir, noMerges)
  const rows = shas.map(sha => rowForCommit(sourceRepo, sha, githubRepo, sourceDir))
  const table = markdownTable(rows)

  if (values.output) {
    const outPath = path.resolve(values.output)
    fs.mkdirSync(path.dirname(outPath), { recursive: true })
    fs.writeFileSync(outPath, table, 'utf8')
  }

  console.log(table)

  if (values['table-only']) {
    process.exit(0)
  }

  if (values['dry-run']) {
    console.error(
      `[dry-run] Would replay ${shas.length} commit(s) onto ${destRepo} under "${destDir}" (${
        noMerges ? 'no merges' : 'merges included'
      }).`,
    )
    process.exit(0)
  }

  if (destStatusPorcelain(destRepo)) {
    die(`Destination repo has a dirty working tree; commit or stash before replay:\n${destRepo}`)
  }

  const sourceToDest = new Map()
  const initialDestSha = git(destRepo, ['rev-parse', 'HEAD']).trim()
  let replayed = 0
  for (const sha of shas) {
    const parentsSrc = listParentShas(sourceRepo, sha)
    const merge = parentsSrc.length > 1
    const pathspec = sourceDir === '.' ? '.' : `${sourceDir}/`
    const diffParent = diffParentForReplay(sourceRepo, sha)

    if (merge) {
      ensureMergeParentsMapped({
        sourceRepo,
        sourceDir,
        parentsSrc,
        sourceToDest,
        shas,
        currentSha: sha,
        pathspec,
      })
    }
    aliasUnmappedSourceParentToDest({
      sourceRepo,
      sourceDir,
      pathspec,
      sourceToDest,
      shas,
      currentSha: sha,
      p: diffParent,
    })

    const baseDest = resolveDestBaseSha({
      initialDestSha,
      sourceRepo,
      sourceDir,
      sourceToDest,
      diffParentSrc: diffParent,
    })
    git(destRepo, ['reset', '--hard', baseDest])

    let patch
    try {
      patch = git(sourceRepo, ['diff', diffParent, sha, '--', pathspec])
    } catch (e) {
      die(`git diff failed for ${sha}: ${e instanceof Error ? e.message : String(e)}`)
    }

    if (!patch.trim()) {
      if (!merge) {
        const dp = diffParent
        if (dp !== EMPTY_TREE && sourceToDest.has(dp)) {
          sourceToDest.set(sha, sourceToDest.get(dp))
          console.error(`[alias] ${sha.slice(0, 7)} — empty path diff; mapped to dest of replayed ${dp.slice(0, 7)}`)
        } else {
          console.error(`[skip] ${sha.slice(0, 7)} — empty diff for pathspec; skipping.`)
        }
      } else {
        console.error(`[skip] ${sha.slice(0, 7)} — empty diff for pathspec; skipping merge.`)
      }
      continue
    }

    const rewritten = rewritePatch(patch, sourceDir, destDir)
    const msg = commitMessage(sourceRepo, sha, githubRepo)
    const metaEnv = commitMetadataEnv(sourceRepo, sha)

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'replay-apply-'))
    const patchFile = path.join(tmpDir, 'patch.diff')
    const msgFile = path.join(tmpDir, 'message.txt')
    try {
      fs.writeFileSync(patchFile, rewritten, 'utf8')
      fs.writeFileSync(msgFile, msg, 'utf8')

      applyPatchIndex(destRepo, patchFile, sha)

      const hasStagedChanges = git(destRepo, ['diff', '--cached', '--name-only']).trim() !== ''
      if (!hasStagedChanges && !merge) {
        console.error(`[skip] ${sha.slice(0, 7)} — no staged changes after apply; skipping non-merge commit.`)
        continue
      }

      const commitEnv = { ...process.env, ...metaEnv }
      createReplayCommit({
        destRepo,
        msgFile,
        commitEnv,
        sourceSha: sha,
        parentsSrc,
        merge,
        hasStagedChanges,
        sourceToDest,
      })
      sourceToDest.set(sha, git(destRepo, ['rev-parse', 'HEAD']).trim())
      replayed += 1
      console.error(`[replay] ${sha.slice(0, 7)} -> ${git(destRepo, ['rev-parse', 'HEAD']).trim().slice(0, 7)}`)
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }
    }
  }

  console.error(`Done. Replayed ${replayed} commit(s) onto ${destRepo}.`)
}
