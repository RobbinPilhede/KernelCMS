import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { RouterProvider, createHashHistory, createRootRoute, createRoute, createRouter } from '@tanstack/react-router'
import { MotionConfig } from 'framer-motion'
import { fetchSchema } from './api'
import { SchemaProvider } from './schema'
import { LocaleProvider } from './locale'
import { AuthProvider } from './auth'
import { AppFrame, Dashboard, EditView, GlobalView, ListView, ResetPasswordPage, VerifyEmailPage } from './views'
import { PreviewPage } from './preview'

const rootRoute = createRootRoute({ component: AppFrame })
const indexRoute = createRoute({ getParentRoute: () => rootRoute, path: '/', component: Dashboard })
const listRoute = createRoute({ getParentRoute: () => rootRoute, path: '/collections/$slug', component: ListView })
const newRoute = createRoute({ getParentRoute: () => rootRoute, path: '/collections/$slug/new', component: EditView })
const editRoute = createRoute({ getParentRoute: () => rootRoute, path: '/collections/$slug/$id', component: EditView })
const globalRoute = createRoute({ getParentRoute: () => rootRoute, path: '/globals/$slug', component: GlobalView })

const routeTree = rootRoute.addChildren([indexRoute, listRoute, newRoute, editRoute, globalRoute])
const router = createRouter({ routeTree, history: createHashHistory(), defaultPreload: 'intent' })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 5_000 } },
})

function Boot() {
  // The CMS schema is static for the session — never refetch it. A mid-session
  // refetch would hand down a new `schema` object identity, which cascades into
  // remounting the router subtree (and wiping unsaved edits).
  const {
    data: schema,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['schema'],
    queryFn: fetchSchema,
    staleTime: Infinity,
    gcTime: Infinity,
  })
  if (isLoading) return <div className="center">Loading KernelCMS…</div>
  if (error || !schema) {
    return (
      <div className="center error">
        <div>
          <strong>Could not reach the KernelCMS API.</strong>
          <p className="muted">Start the server with `pnpm example:dev`, then reload.</p>
        </div>
      </div>
    )
  }
  return (
    <MotionConfig reducedMotion="user">
      <SchemaProvider schema={schema}>
        <LocaleProvider>
          <AuthProvider schema={schema}>
            <RouterProvider router={router} />
          </AuthProvider>
        </LocaleProvider>
      </SchemaProvider>
    </MotionConfig>
  )
}

export function App() {
  // When loaded inside the live-preview iframe, render the preview document only.
  const params = new URLSearchParams(window.location.search)
  if (params.get('kernel_preview') === '1') {
    return <PreviewPage collection={params.get('collection') ?? ''} />
  }
  // Public, auth-free pages reached from email links (before the schema/auth boot).
  const route = window.location.hash.replace(/^#/, '').split('?')[0]
  if (route === '/reset-password') {
    return (
      <QueryClientProvider client={queryClient}>
        <ResetPasswordPage />
      </QueryClientProvider>
    )
  }
  if (route === '/verify-email') {
    return (
      <QueryClientProvider client={queryClient}>
        <VerifyEmailPage />
      </QueryClientProvider>
    )
  }
  return (
    <QueryClientProvider client={queryClient}>
      <Boot />
    </QueryClientProvider>
  )
}
