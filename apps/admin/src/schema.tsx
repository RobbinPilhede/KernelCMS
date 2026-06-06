import { createContext, useContext } from 'react'
import type { ReactNode } from 'react'
import type { AdminSchema } from './api'

const SchemaContext = createContext<AdminSchema | null>(null)

export function SchemaProvider({ schema, children }: { schema: AdminSchema; children: ReactNode }) {
  return <SchemaContext.Provider value={schema}>{children}</SchemaContext.Provider>
}

export function useSchema(): AdminSchema {
  const schema = useContext(SchemaContext)
  if (!schema) throw new Error('useSchema must be used within a SchemaProvider')
  return schema
}

export function useCollection(slug: string) {
  return useSchema().collections.find((c) => c.slug === slug)
}

export function useGlobal(slug: string) {
  return useSchema().globals.find((g) => g.slug === slug)
}
