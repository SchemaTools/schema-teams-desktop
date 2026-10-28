import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TraySurface } from './TraySurface';
import './theme.css';

const root = document.getElementById('root');
if (root)
  createRoot(root).render(
    new URLSearchParams(window.location.search).get('surface') === 'tray' ? (
      <TraySurface />
    ) : (
      <App />
    ),
  );
