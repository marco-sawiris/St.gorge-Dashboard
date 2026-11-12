import { createRoot } from 'react-dom/client';
import App from './App';
import { ThemeProvider } from './context/ThemeContext';
import { AuthProvider } from './context/AuthContext';
import { AppProvider } from './context/AppContext';
import './index.css';

// Register Service Worker for PWA
if ('serviceWorker' in navigator && process.env.NODE_ENV === 'production') {
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => console.log('PWA ServiceWorker registered successfully:', reg.scope))
      .catch((err) => console.warn('PWA ServiceWorker registration error:', err));
  });
}

createRoot(document.getElementById('root')!).render(
  <ThemeProvider>
    <AuthProvider>
      <AppProvider>
        <App />
      </AppProvider>
    </AuthProvider>
  </ThemeProvider>
);
