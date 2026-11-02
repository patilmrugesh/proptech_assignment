import { createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { HomePage } from './HomePage'
import './styles.css'

const rootRoute = createRootRoute()

// The page lives at "/" and the chosen home is kept in the URL: /?home=<id>
const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: (search: Record<string, unknown>): { home: string | undefined } => ({
    home: typeof search.home === 'string' && search.home !== '' ? search.home : undefined,
  }),
  component: function IndexPage() {
    const { home } = indexRoute.useSearch()
    const navigate = indexRoute.useNavigate()
    return <HomePage homeId={home} onSelectHome={(id) => navigate({ search: { home: id } })} />
  },
})

const router = createRouter({ routeTree: rootRoute.addChildren([indexRoute]) })

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}

const container = document.getElementById('root')
if (container) {
  createRoot(container).render(
    <StrictMode>
      <RouterProvider router={router} />
    </StrictMode>,
  )
}
