import { BrowserRouter, Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import HomePage from '@/pages/HomePage'
import NotFoundPage from '@/pages/NotFoundPage'

// Новая страница: создайте файл в src/pages и добавьте Route здесь
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route index element={<HomePage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <Toaster richColors position="top-center" />
    </BrowserRouter>
  )
}
