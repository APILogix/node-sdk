import { fork } from 'child_process'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdirSync, rmSync, writeFileSync } from 'fs'
import { pathToFileURL } from 'url'
import { persistentStorage } from '../dist/storage/persistent-storage.js'

async function run() {
  const testDir = join(tmpdir(), 'pulse-multiprocess-audit-' + Date.now())
  mkdirSync(testDir, { recursive: true })

  const storagePathUrl = pathToFileURL(join(process.cwd(), 'dist/storage/persistent-storage.js')).href

  const workerCode = `
import { persistentStorage } from '${storagePathUrl}'
const testDir = process.env.TEST_DIR
persistentStorage.configure({ directory: testDir, apiKeyHash: 'audit123' })
await persistentStorage.init()

const workerId = process.env.WORKER_ID
const promises = []
for (let i = 0; i < 50; i++) {
  persistentStorage.persist({
    eventId: 'evt-' + workerId + '-' + i,
    type: 'error',
    timestamp: Date.now(),
    message: 'msg-' + workerId + '-' + i
  })
  if (i % 10 === 0) {
    promises.push(persistentStorage.flush())
  }
}
await Promise.all(promises)
await persistentStorage.flush()
await persistentStorage.shutdown()
process.exit(0)
`

  const workerScript = join(testDir, 'worker.mjs')
  writeFileSync(workerScript, workerCode)

  console.log('Spawning 2 concurrent processes writing to the same persistence storage...')
  const p1 = fork(workerScript, { env: { ...process.env, TEST_DIR: testDir, WORKER_ID: 'w1' } })
  const p2 = fork(workerScript, { env: { ...process.env, TEST_DIR: testDir, WORKER_ID: 'w2' } })

  let exit1, exit2
  p1.on('exit', code => { exit1 = code })
  p2.on('exit', code => { exit2 = code })

  while (exit1 === undefined || exit2 === undefined) {
    await new Promise(r => setTimeout(r, 50))
  }

  console.log('Worker 1 exit code:', exit1)
  console.log('Worker 2 exit code:', exit2)

  persistentStorage.configure({ directory: testDir, apiKeyHash: 'audit123' })
  const replayed = await persistentStorage.init()
  console.log('Total replayed events after both workers exited:', replayed.length)
  const w1Events = replayed.filter(e => e.eventId.startsWith('evt-w1-')).length
  const w2Events = replayed.filter(e => e.eventId.startsWith('evt-w2-')).length
  console.log('Worker 1 events found (expected 50):', w1Events)
  console.log('Worker 2 events found (expected 50):', w2Events)

  await persistentStorage.shutdown()
  rmSync(testDir, { recursive: true, force: true })
}

run().catch(console.error)
