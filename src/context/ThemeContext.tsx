import React, { createContext, useContext, useEffect, useState } from 'react';

export type Theme = 'dark' | 'light' | 'dim';

interface ThemeContextType {
  theme: Theme;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  isDark: boolean;
}

const ThemeContext = createContext<ThemeContextType>({
  theme: 'dark',
  toggleTheme: () => {},
  setTheme: () => {},
  isDark: true
});

export const ThemeProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [theme, setThemeState] = useState<Theme>(() => {
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem('stgorge_theme') as Theme;
      if (saved === 'dark' || saved === 'light' || saved === 'dim') {
        return saved;
      }
    }
    return 'dark'; // Midnight Black & Cyan default
  });

  useEffect(() => {
    // Apply immediate data-theme and classes to root element
    const root = document.documentElement;
    root.setAttribute('data-theme', theme);
    root.setAttribute('dir', 'rtl');
    root.setAttribute('lang', 'ar');
    root.classList.toggle('dark', theme === 'dark' || theme === 'dim');
    root.classList.toggle('light', theme === 'light');

    // Update browser theme-color meta tag
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute('content', theme === 'light' ? '#F0F4FA' : '#030711');
    }

    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem('stgorge_theme', theme);
      }
    } catch {}
  }, [theme]);

  const setTheme = (newTheme: Theme) => {
    setThemeState(newTheme);
  };

  const toggleTheme = () => {
    setThemeState((prev) => (prev === 'dark' ? 'light' : 'dark'));
  };

  const isDark = theme === 'dark' || theme === 'dim';

  return (
    <ThemeContext.Provider value={{ theme, toggleTheme, setTheme, isDark }}>
      {children}
    </ThemeContext.Provider>
  );
};

export const useTheme = () => useContext(ThemeContext);
