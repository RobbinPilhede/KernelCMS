// A deliberately broken config for CI: it loads the sqlite adapter (so node:sqlite
// is initialized) and then throws during evaluation. Used to assert the CLI prints
// the error and exits cleanly with code 1 — never aborting with the Windows libuv
// `UV_HANDLE_CLOSING` assertion during teardown.
import { sqliteAdapter } from '@kernel/db-sqlite'

void sqliteAdapter({ url: ':memory:' })

throw new Error('intentional bad config (CI teardown test)')
