/**
 * 把同步来的会话日志 header 的 cwd 重写为远端工作区路径。
 *
 * 会话日志 = 多帧 zstd：第一帧必须「只含 header 行」（写入方契约，读取端会校验
 * first frame is exactly one header line），其后每帧是若干事件行。因此重写只动
 * 第一帧：解出第一帧 → 替换 cwd → 单独重压缩；其余帧的字节原样保留，事件内容
 * 零改动。
 *
 * 用法：node --import tsx/esm rewrite-session-cwd.ts <DSH_HOME> <FROM_CWD_B64> <TO_CWD>
 * 幂等：cwd 已等于 TO 的会话跳过；仅处理 v4 生成（session.v4.jsonl.zstd）。
 * （需放在 session-persistence-jsonl 包目录内、用 tsx 加载以复用包内解码器。）
 */
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const { scanZstdFrames, createZstdFrameDecoder, compressZstdFrame } = await import('./src/zstd.ts')

const [dshHome, fromCwdB64, toCwd] = process.argv.slice(2)
if ([dshHome, fromCwdB64, toCwd].some(v => v === undefined)) {
  console.error('usage: node rewrite-session-cwd.ts <DSH_HOME> <FROM_CWD_B64> <TO_CWD>')
  process.exit(2)
}
const fromCwd = Buffer.from(fromCwdB64, 'base64').toString('utf8')

// 解码器返回的是内部暂存视图，下一次调用即失效，必须立即拷贝。
function decodeFrame(buffer, range) {
  const decoder = createZstdFrameDecoder()
  let text = ''
  for (const chunk of decoder.decode(buffer, [range])) text += Buffer.from(chunk).toString('utf8')
  decoder.close()
  return text
}

function isDirectory(path) {
  try { return statSync(path).isDirectory() } catch { return false }
}

const sessionsRoot = join(dshHome, 'sessions')
const rewritten = []
const skipped = []

for (const key of readdirSync(sessionsRoot)) {
  const workspaceDir = join(sessionsRoot, key)
  if (!isDirectory(workspaceDir)) continue
  for (const entry of readdirSync(workspaceDir)) {
    const dir = join(workspaceDir, entry)
    // 仅处理 v4 生成；v0 旧格式本构建不读，留给收尾脚本归档。
    const logPath = join(dir, 'session.v4.jsonl.zstd')
    if (!entry.startsWith('session-') || !isDirectory(dir) || !existsSync(logPath)) continue

    const buffer = readFileSync(logPath)
    const scan = scanZstdFrames(buffer)
    if (scan.frames.length === 0 || scan.tornStart !== undefined) {
      skipped.push(`${entry}: torn or empty log`)
      continue
    }
    const firstFrame = scan.frames[0]
    const headerText = decodeFrame(buffer, firstFrame)
    if (!headerText.endsWith('\n') || headerText.indexOf('\n') !== headerText.length - 1) {
      skipped.push(`${entry}: first frame is not exactly one line`)
      continue
    }
    let header
    try {
      header = JSON.parse(headerText.slice(0, -1))
    } catch (error) {
      skipped.push(`${entry}: header parse failed (${error.message})`)
      continue
    }
    if (header.type !== 'session') {
      skipped.push(`${entry}: first line is not a session header`)
      continue
    }
    if (header.cwd === toCwd) {
      skipped.push(`${entry}: already ${toCwd}`)
      continue
    }
    if (header.cwd !== fromCwd) {
      skipped.push(`${entry}: cwd ${JSON.stringify(header.cwd)} not matched`)
      continue
    }

    header.cwd = toCwd
    const newFirstFrame = await compressZstdFrame(JSON.stringify(header) + '\n')
    const tmpPath = `${logPath}.rewrite-tmp`
    writeFileSync(tmpPath, Buffer.concat([newFirstFrame, buffer.subarray(firstFrame.end)]))
    rmSync(logPath)
    writeFileSync(logPath, readFileSync(tmpPath))
    rmSync(tmpPath)
    rewritten.push(header.id)
  }
}

console.log(`rewritten: ${rewritten.length}`)
for (const line of rewritten) console.log('  ok:', line)
for (const line of skipped) console.log('  skip:', line)
