import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router';
import { DesignPreview } from './Preview';
import './theme.css';

const root = document.getElementById('root');
if (root === null) throw new Error('Design preview root is missing.');

createRoot(root).render(<StrictMode><HashRouter><DesignPreview /></HashRouter></StrictMode>);
