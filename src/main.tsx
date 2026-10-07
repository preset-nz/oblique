import { nativeContextMenu } from '@preset.nz/app-kit/core';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

// No WebKit context menu (Reload, Inspect Element): right-click in a text field pops up
// app-kit's native text menu, and elsewhere an app-drawn menu or nothing.
nativeContextMenu();

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
