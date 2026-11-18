import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

// Poppins in the three weights the page sets text in (mative-brand), Latin subset, served by this site.
import '@fontsource/poppins/latin-400.css';
import '@fontsource/poppins/latin-500.css';
import '@fontsource/poppins/latin-600.css';

import { App } from './App.tsx';
import './styles/brand.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root in index.html');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
