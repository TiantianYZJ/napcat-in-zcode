import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './styles.css';

const el = document.getElementById('root');
if (!el) throw new Error('面板挂载点 #root 不存在');
createRoot(el).render(<App />);
