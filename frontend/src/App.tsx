import { BrowserRouter, Route, Routes } from 'react-router'
import { Layout } from '@/components/Layout'
import IssuesPage from '@/pages/IssuesPage'
import NotFoundPage from '@/pages/NotFoundPage'
import StatsPage from '@/pages/StatsPage'

// Новая страница: создайте файл в src/pages, добавьте Route здесь и ссылку в Layout.tsx
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          <Route index element={<IssuesPage />} />
          <Route path="stats" element={<StatsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}
