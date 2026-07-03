import { useEffect } from 'react';
import { Layout } from './app/Layout';
import { installShortcuts } from './app/shortcuts';

function App() {
  useEffect(() => {
    // Set dark theme on html element
    document.documentElement.classList.add('dark');
  }, []);

  useEffect(() => installShortcuts(), []);

  return <Layout />;
}

export default App;
