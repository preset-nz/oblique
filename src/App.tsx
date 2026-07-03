import { useEffect } from 'react';
import { Layout } from './app/Layout';

function App() {
  useEffect(() => {
    // Set dark theme on html element
    document.documentElement.classList.add('dark');
  }, []);

  return <Layout />;
}

export default App;
