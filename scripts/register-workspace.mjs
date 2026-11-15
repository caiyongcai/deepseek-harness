/**
 * 在远端 DSH_HOME 中注册一个"兼容工作区"，用于承载从其他机器同步来的会话。
 *
 * 背景：工作区归属由「会话 header 的 cwd 解析结果」与「工作区 path」严格相等决定
 * （packages/workspace/workspace/src/index.ts 的 candidateMatches）。同步来的会话
 * 的 cwd 是源机器的绝对路径（如 D:\harness），在 Linux 上既不存在也无法与远端
 * 工作区吻合，因此会被过滤掉。这里在代码目录下创建一个同名字面量目录，并用它的
 * realpath 作为工作区 path，使这些会话重新获得归属，历史可以正常列出与阅读。
 *
 * 幂等：工作区 id 由源路径派生，重复执行只做并集。
 *
 * 用法：node register-workspace.mjs <DSH_HOME> <APP_DIR> <SOURCE_PATH> <TITLE> <IDS_JSON>
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// 源路径以 base64 传入：避免不同 shell 对反斜杠/盘符做路径转换。
const [dshHome, appDir, sourcePathB64, title, idsFile] = process.argv.slice(2)
const sourcePath = Buffer.from(sourcePathB64 ?? '', 'base64').toString('utf8')
if ([dshHome, appDir, sourcePathB64, idsFile].some(v => v === undefined) || sourcePath === '') {
  console.error('usage: node register-workspace.mjs <DSH_HOME> <APP_DIR> <SOURCE_PATH> <TITLE> <IDS_JSON>')
  process.exit(2)
}

const ids = JSON.parse(readFileSync(idsFile, 'utf8'))
const digest = createHash('sha1').update(sourcePath).digest('hex')
const workspaceId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-5${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`

// 与源机器 cwd 字面量同名（含反斜杠与冒号，在 Linux 上都是普通字符）。
const compatDir = join(appDir, sourcePath)
mkdirSync(compatDir, { recursive: true })
const resolvedPath = realpathSync(compatDir)

const file = join(dshHome, 'storages', 'workspace.json')
const state = JSON.parse(readFileSync(file, 'utf8'))
state.global ??= {}
state.global.workspaceIds ??= Object.keys(state.tables.workspaces ?? {})
if (!state.global.workspaceIds.includes(workspaceId)) state.global.workspaceIds.push(workspaceId)

const now = new Date().toISOString()
const previous = state.tables.workspaces[workspaceId]
const sessionIds = [...new Set([...(previous?.sessionIds ?? []), ...ids])]
state.tables.workspaces[workspaceId] = {
  path: resolvedPath,
  title: title ?? sourcePath,
  sessionIds,
  createdAt: previous?.createdAt ?? now,
  updatedAt: now,
}

// 清理历史遗留的无效工作区记录（路径在本机已不存在），保持列表干净。
const removed = []
for (const [id, record] of Object.entries(state.tables.workspaces)) {
  if (id === workspaceId) continue
  if (existsSync(record.path)) continue
  delete state.tables.workspaces[id]
  state.global.workspaceIds = state.global.workspaceIds.filter(candidate => candidate !== id)
  removed.push(id)
}

writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`)
if (removed.length > 0) console.error(`removed stale workspaces: ${removed.join(', ')}`)
console.log(JSON.stringify({ workspaceId, path: resolvedPath, sessions: sessionIds.length }))
