// 验证重写后的会话日志能被应用自身的扫描器读取。
import { readFileSync, readdirSync } from 'node:fs'
const { scanLog } = await import('./src/format.ts')
const { scanZstdFrames, createZstdFrameDecoder } = await import('./src/zstd.ts')

// scanLog 需要明文 JSONL：先把多帧 zstd 解成明文（解码器返回临时视图，须立即拷贝）。
function decodeLog(buffer) {
  const scan = scanZstdFrames(buffer)
  const decoder = createZstdFrameDecoder()
  const parts = []
  for (const chunk of decoder.decode(buffer, scan.frames)) parts.push(Buffer.from(chunk))
  decoder.close()
  return Buffer.concat(parts)
}

const dir = process.argv[2] ?? '/root/deepseek-harness/data/.dsh/sessions/--root-harness-space--'
const only = process.argv[3]
for (const id of readdirSync(dir).filter(name => name.startsWith('session-'))) {
  if (only !== undefined && !id.includes(only)) continue
  const logName = ['session.v4.jsonl.zstd', 'session.jsonl.zstd'].find((name) => {
    try { return readdirSync(`${dir}/${id}`).includes(name) } catch { return false }
  })
  if (logName === undefined) { console.log(id.slice(8, 16), 'no log'); continue }
  try {
    const scan = scanLog(decodeLog(readFileSync(`${dir}/${id}/${logName}`)))
    console.log(id.slice(8, 16), logName.slice(7, 10), 'cwd:', JSON.stringify(scan.meta.cwd), 'events:', scan.events.length, 'committed:', scan.committedBytes)
  } catch (error) {
    console.log(id.slice(8, 16), 'SCAN FAIL:', error.message.slice(0, 120))
  }
}
