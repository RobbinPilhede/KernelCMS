import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeConfig } from './config'
export default makeConfig('file:' + join(mkdtempSync(join(tmpdir(), 'kcli-')), 'cli.db'))
