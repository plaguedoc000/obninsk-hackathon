import { BrowserRouter, Route, Routes } from 'react-router'
import { Toaster } from '@/components/ui/sonner'
import { FLIDA_CALLBACK_PATH } from '@/lib/flida'
import FlidaCallbackPage from '@/pages/FlidaCallbackPage'
import HomePage from '@/pages/HomePage'
import NotFoundPage from '@/pages/NotFoundPage'

// Новая страница: создайте файл в src/pages и добавьте Route здесь
export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route index element={<HomePage />} />
        <Route path={FLIDA_CALLBACK_PATH} element={<FlidaCallbackPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Routes>
      <Toaster theme="dark" position="top-center" />
    </BrowserRouter>
  )
}
