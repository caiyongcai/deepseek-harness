/**
 * 同步收尾：
 * 1. 扫描全部会话目录，用应用自身的 scanLog 判定可读性（v4）；
 * 2. 把工作区登记修正为「磁盘上可读的会话全集」；
 * 3. 把不可读的 v0 旧格式会话移出 sessions 根（避免干扰目录扫描），归档到
 *    <DSH_HOME>/v0-legacy-sessions/；空目录直接删除。
 *
 * 用法：node --import tsx/esm scripts/sync-finalize.ts <DSH_HOME> <WORKSPACE_PATH>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanLog } from '../packages/session/session-persistence-jsonl/src/format.ts'
import { createZstdFrameDecoder, scanZstdFrames } from '../packages/session/session-persistence-jsonl/src/zstd.ts'

interface WorkspaceRecord {
  path: string
  sessionIds?: string[]
  updatedAt?: string
}

interface WorkspaceRegistry {
  global?: { workspaceIds?: string[] }
  tables: { workspaces: Record<string, WorkspaceRecord> }
}

const [dshHome, workspacePath] = process.argv.slice(2)
if (dshHome === undefined || workspacePath === undefined) {
  console.error('usage: node scripts/sync-finalize.ts <DSH_HOME> <WORKSPACE_PATH>')
  process.exit(2)
}

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// scanLog 需要明文 JSONL；解码器返回临时视图，必须立即拷贝。
function decodeLog(buffer: Buffer): Buffer {
  const scan = scanZstdFrames(buffer)
  const decoder = createZstdFrameDecoder()
  const parts = []
  for (const chunk of decoder.decode(buffer, scan.frames)) parts.push(Buffer.from(chunk))
  decoder.close()
  return Buffer.concat(parts)
}

function isDirectory(path: string): boolean {
  try { return statSync(path).isDirectory() } catch { return false }
}

const sessionsRoot = join(dshHome, 'sessions')
const archiveRoot = join(dshHome, 'v0-legacy-sessions')
const okIds: string[] = []
const archived: string[] = []
const removed: string[] = []

for (const key of readdirSync(sessionsRoot)) {
  const workspaceDir = join(sessionsRoot, key)
  if (!isDirectory(workspaceDir)) continue
  for (const entry of readdirSync(workspaceDir)) {
    const dir = join(workspaceDir, entry)
    if (!entry.startsWith('session-') || !isDirectory(dir)) continue
    const files = readdirSync(dir)
    const logName = ['session.v4.jsonl.zstd', 'session.jsonl.zstd'].find(name => files.includes(name))
    if (logName === undefined) {
      rmSync(dir, { recursive: true, force: true })
      removed.push(entry)
      continue
    }
    try {
      const scan = scanLog(decodeLog(readFileSync(join(dir, logName))))
      if (scan.meta.cwd === workspacePath) okIds.push(entry)
      else archived.push(`${entry} (cwd ${JSON.stringify(scan.meta.cwd)})`)
    } catch (error) {
      const message = errorMessage(error)
      if (/format v\d+, older/.test(message)) {
        mkdirSync(archiveRoot, { recursive: true })
        const dest = join(archiveRoot, entry)
        if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
        renameSync(dir, dest)
        archived.push(`${entry} (v0 legacy)`)
      } else {
        console.log(`  unreadable, kept in place: ${entry}: ${message.slice(0, 80)}`)
      }
    }
  }
}

const registryPath = join(dshHome, 'storages', 'workspace.json')
const state = JSON.parse(readFileSync(registryPath, 'utf8')) as WorkspaceRegistry
state.global ??= {}
state.global.workspaceIds ??= Object.keys(state.tables.workspaces)
const targetId = Object.entries(state.tables.workspaces)
  .find(([, record]) => record.path === workspacePath)?.[0]
if (targetId === undefined) {
  console.error(`workspace with path ${workspacePath} not found`)
  process.exit(1)
}
const record = state.tables.workspaces[targetId]
if (record === undefined) {
  console.error(`workspace ${targetId} has no record`)
  process.exit(1)
}
record.sessionIds = [...new Set([...okIds, ...(record.sessionIds ?? []).filter(id => okIds.includes(id))])]
record.updatedAt = new Date().toISOString()
writeFileSync(registryPath, `${JSON.stringify(state, null, 2)}\n`)

console.log(`readable sessions: ${okIds.length}`)
console.log(`archived v0: ${archived.length}`)
for (const line of archived) console.log('  archive:', line)
console.log(`removed empty dirs: ${removed.length}`)
console.log(`registry ${targetId.slice(0, 8)} sessionIds: ${record.sessionIds.length}`)
