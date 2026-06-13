import { describe, expect, it } from 'vitest'
import { selectStdioAgent } from './index'

// Pure selection logic — no config-file loading, so it's robust on every CI runner.
describe('selectStdioAgent (mcp stdio principal selection)', () => {
  it('errors clearly when the config has no agents', () => {
    const r = selectStdioAgent([], undefined)
    expect('error' in r ? r.error : '').toContain('No agents configured')
    expect('error' in r ? r.error : '').toContain('agents: [...]')
  })

  it('errors with the agent ids when more than one agent and none is chosen', () => {
    const r = selectStdioAgent([{ id: 'a' }, { id: 'b' }], undefined)
    expect('error' in r ? r.error : '').toContain('Multiple agents configured')
    expect('error' in r ? r.error : '').toContain('--agent')
  })

  it('errors when --agent names an id that is not configured', () => {
    const r = selectStdioAgent([{ id: 'a' }], 'nope')
    expect('error' in r ? r.error : '').toContain('No agent with id "nope"')
  })

  it('returns the sole configured agent when none is named', () => {
    const r = selectStdioAgent([{ id: 'only', token: 't' }], undefined)
    expect('agent' in r ? r.agent.id : null).toBe('only')
  })

  it('returns the agent named by --agent', () => {
    const r = selectStdioAgent([{ id: 'a' }, { id: 'b' }], 'b')
    expect('agent' in r ? r.agent.id : null).toBe('b')
  })
})
